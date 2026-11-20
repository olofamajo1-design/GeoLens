insert into app.roles(code) values ('ingestion_operator');

-- Acquisition licences are separate from editorial publication permissions.
create table news.discovery_endpoints (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references news.sources(id),
  locator text not null unique,
  adapter text not null check (adapter in ('gdelt', 'rss', 'world-bank')),
  fixture boolean not null,
  enabled boolean not null default false,
  poll_minutes integer not null default 15 check (poll_minutes between 15 and 10080),
  next_due timestamptz not null default now(),
  last_success timestamptz,
  consecutive_failures integer not null default 0,
  etag text
);
create table news.acquisition_licences (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references news.discovery_endpoints(id),
  terms_reference text not null,
  attribution text not null,
  fields text[] not null check (fields = array['metadata']::text[]),
  retention_until timestamptz not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  revoked_at timestamptz,
  check (valid_until > valid_from and retention_until >= valid_until)
);
create index acquisition_licences_by_endpoint on news.acquisition_licences(endpoint_id, valid_until);

create table ai_ops.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references news.discovery_endpoints(id),
  licence_id uuid not null references news.acquisition_licences(id),
  cycle timestamptz not null,
  state text not null default 'running' check (state in ('running', 'complete', 'failed')),
  received integer not null default 0 check (received between 0 and 10),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(endpoint_id, cycle)
);
create table ai_ops.discovery_usage (
  month date not null,
  scope text not null check (scope in ('development', 'launch')),
  requests bigint not null default 0,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  primary key (month, scope)
);

create table news.discovery_provenance (
  document_id uuid primary key references news.documents(id),
  run_id uuid not null references ai_ops.discovery_runs(id),
  licence_id uuid not null references news.acquisition_licences(id),
  title text not null,
  original_url text,
  canonical_url text,
  provider_timestamp timestamptz,
  time_basis text check(time_basis in ('observed','published')),
  language text,
  attribution text not null,
  origin text,
  fingerprint text not null
);
create index discovery_provenance_fingerprint on news.discovery_provenance(fingerprint);
create index discovery_provenance_url on news.discovery_provenance(canonical_url);
create table news.discovery_clusters (
  cluster_key text primary key,
  event_id uuid not null unique references news.events(id),
  fixture boolean not null
);
create table news.discovery_entities (
  event_id uuid references news.events(id),
  entity_name text not null,
  primary key(event_id, entity_name)
);
create table news.discovery_ranks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references news.events(id),
  run_id uuid not null references ai_ops.discovery_runs(id),
  rule_version smallint not null default 1,
  independent_origins integer not null,
  score_components jsonb not null,
  score numeric(5,2),
  label text not null check (label in ('breaking','trending','developing','review')),
  unique (event_id, run_id)
);

create function ai_ops.require_ingestion() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not app.has_role('ingestion_operator') then
    raise exception 'Ingestion role required' using errcode = '42501';
  end if;
end
$$;

-- Pilot jobs are fixture-only until a separate reviewed activation change.
create function geo_api.begin_discovery(source_endpoint uuid, cycle_time timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  endpoint news.discovery_endpoints%rowtype;
  licence news.acquisition_licences%rowtype;
  run_id uuid;
  instant timestamptz := clock_timestamp();
  usage_month date := date_trunc('month', instant at time zone 'UTC')::date;
begin
  perform ai_ops.require_ingestion();
  if cycle_time is null or cycle_time > instant or cycle_time < instant - interval '1 hour'
    or date_bin('15 minutes', cycle_time, '2000-01-01T00:00:00Z'::timestamptz) <> cycle_time then
    raise exception 'Invalid discovery cycle';
  end if;
  select * into endpoint from news.discovery_endpoints where id = source_endpoint for update;
  if not found or not endpoint.fixture or not endpoint.enabled then return null; end if;
  select id into run_id from ai_ops.discovery_runs where endpoint_id=source_endpoint and cycle=cycle_time
    and state='running' and started_at>instant-interval '5 minutes'
    and exists(select 1 from news.acquisition_licences l where l.id=ai_ops.discovery_runs.licence_id
      and l.revoked_at is null and instant>=l.valid_from and instant<l.valid_until);
  if found then
    return jsonb_build_object('id',run_id,'adapter',endpoint.adapter,'fixture',endpoint.fixture,'etag',endpoint.etag);
  end if;
  if endpoint.next_due > instant then return null; end if;
  select * into licence from news.acquisition_licences
    where endpoint_id = source_endpoint and revoked_at is null and instant >= valid_from and instant < valid_until
    order by valid_from desc, id limit 1;
  if not found then return null; end if;

  update ai_ops.discovery_runs set state = 'failed', error_code = 'lease_expired', finished_at = instant
    where endpoint_id = source_endpoint and state = 'running' and started_at <= instant - interval '5 minutes';
  if exists (select 1 from ai_ops.discovery_runs where endpoint_id = source_endpoint and state = 'running') then return null; end if;
  insert into ai_ops.discovery_usage(month, scope) values (usage_month, 'development') on conflict do nothing;
  perform 1 from ai_ops.discovery_usage where month = usage_month and scope = 'development' for update;
  if exists (select 1 from ai_ops.discovery_usage where month = usage_month and scope = 'development'
    and (amount_minor >= 5000 or requests >= 10000)) then return null; end if;

  insert into ai_ops.discovery_runs(endpoint_id, licence_id, cycle)
    values (source_endpoint, licence.id, cycle_time) on conflict do nothing returning id into run_id;
  if run_id is null then return null; end if;
  update news.discovery_endpoints set next_due = instant + make_interval(mins => endpoint.poll_minutes)
    where id = source_endpoint;
  update ai_ops.discovery_usage set requests = requests + 1 where month = usage_month and scope = 'development';
  return jsonb_build_object('id',run_id,'adapter',endpoint.adapter,'fixture',endpoint.fixture,'etag',endpoint.etag);
end
$$;

create function geo_api.finish_discovery(target_run uuid, documents jsonb, failure text default null,
  retry_seconds integer default 0, response_etag text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.discovery_runs%rowtype;
  endpoint news.discovery_endpoints%rowtype;
  licence news.acquisition_licences%rowtype;
  item jsonb;
  entity text;
  doc_id uuid;
  affected_event uuid;
  affected_events uuid[] := '{}';
  cluster_key_value text;
  independent integer;
  components jsonb;
  impact integer;
  urgency integer;
  regional integer;
  historical integer;
  event_time timestamptz;
  headline text;
  instant timestamptz := clock_timestamp();
  err text := failure;
begin
  perform ai_ops.require_ingestion();
  select e.* into strict endpoint from news.discovery_endpoints e join ai_ops.discovery_runs r on r.endpoint_id=e.id
    where r.id=target_run for update of e;
  select * into strict run from ai_ops.discovery_runs where id=target_run for update;
  if run.state <> 'running' then return run.state; end if;
  select * into strict licence from news.acquisition_licences where id=run.licence_id for share;
  if not endpoint.enabled or not endpoint.fixture or licence.revoked_at is not null
    or clock_timestamp() < licence.valid_from or clock_timestamp() >= licence.valid_until then err := 'licence_unavailable'; end if;
  if clock_timestamp() > run.started_at + interval '5 minutes' then err := 'lease_expired'; end if;
  if err is not null then
    update ai_ops.discovery_runs set state='failed', error_code=case when err in (
      'licence_unavailable','lease_expired','rate_limited','upstream_error','upstream_unavailable','invalid_payload'
    ) then err else 'ingestion_error' end, finished_at=instant where id=run.id;
    update news.discovery_endpoints set consecutive_failures=consecutive_failures+1,
      next_due=greatest(next_due, instant+make_interval(secs=>greatest(0,coalesce(retry_seconds,0))))
      where id=endpoint.id;
    return 'failed';
  end if;
  if jsonb_typeof(documents) is distinct from 'array' or jsonb_array_length(documents)>10
    or octet_length(documents::text)>80000 then raise exception 'Invalid discovery batch'; end if;

  -- Serialize cluster creation, canonical duplicate checks and ranking across endpoints.
  perform pg_advisory_xact_lock(78294221);
  for item in select value from jsonb_array_elements(documents)
  loop
    if jsonb_typeof(item) is distinct from 'object'
      or item - array['externalReference','originalUrl','canonicalUrl','title','occurredAt','timeBasis','language',
        'digest','fingerprint','origin','location','entities','cluster'] <> '{}'::jsonb
      or length(coalesce(item->>'originalUrl',''))>2048 or length(coalesce(item->>'canonicalUrl',''))>2048
      or length(coalesce(item->>'cluster',''))>160 or length(coalesce(item->>'language',''))>40
      or (item->>'canonicalUrl' is not null and item->>'canonicalUrl' !~ '^https://[^/@ ]+(/|$)')
      or nullif(trim(item->>'title'),'') is null or length(item->>'title')>400
      or nullif(trim(item->>'externalReference'),'') is null or length(item->>'externalReference')>2048
      or coalesce(item->>'digest','') !~ '^[0-9a-f]{64}$' or coalesce(item->>'fingerprint','') !~ '^[0-9a-f]{64}$'
      then raise exception 'Invalid normalized record'; end if;
    if item->>'canonicalUrl' is not null and exists (
      select 1 from news.discovery_provenance p join news.documents d on d.id=p.document_id
      where d.source_id=endpoint.source_id and p.canonical_url=item->>'canonicalUrl'
        and d.digest=decode(item->>'digest','hex')
    ) then continue; end if;
    doc_id := null;
    insert into news.documents(source_id, external_reference, digest)
      values(endpoint.source_id,item->>'externalReference',decode(item->>'digest','hex'))
      on conflict do nothing returning id into doc_id;
    if doc_id is null then continue; end if;
    insert into news.discovery_provenance values(doc_id,run.id,licence.id,item->>'title',item->>'originalUrl',
      item->>'canonicalUrl',(item->>'occurredAt')::timestamptz,item->>'timeBasis',item->>'language',licence.attribution,
      case when item->>'origin' in ('reuters','associated-press','world-bank') then item->>'origin' end,item->>'fingerprint');

    cluster_key_value := 'fixture:' || coalesce(item->>'cluster',item->>'fingerprint');
    select event_id into affected_event from news.discovery_clusters where cluster_key=cluster_key_value;
    if not found then
      insert into news.events(title) values(item->>'title') returning id into affected_event;
      insert into news.discovery_clusters values(cluster_key_value,affected_event,true);
    end if;
    insert into news.event_documents values(affected_event,doc_id);
    if jsonb_typeof(item->'location')='object' then
      insert into news.locations(name,country_code) values(item->'location'->>'name',item->'location'->>'country')
        on conflict do nothing;
      insert into news.event_locations select affected_event,id from news.locations
        where name=item->'location'->>'name' and country_code=item->'location'->>'country' on conflict do nothing;
    end if;
    for entity in select value from jsonb_array_elements_text(coalesce(item->'entities','[]'))
    loop
      insert into news.discovery_entities values(affected_event,entity) on conflict do nothing;
    end loop;
    if not affected_event = any(affected_events) then affected_events:=array_append(affected_events,affected_event); end if;
  end loop;

  foreach affected_event in array affected_events
  loop
    -- Reprints with a common origin or an identical headline fingerprint cannot boost independent evidence.
    with recursive evidence as (
      select distinct p.origin,p.fingerprint
      from news.event_documents d join news.discovery_provenance p on p.document_id=d.document_id
      join news.acquisition_licences l on l.id=p.licence_id
      where d.event_id=affected_event and p.origin is not null and l.revoked_at is null and l.retention_until>instant
    ), related as (
      select a.origin as src,b.origin as dst from evidence a join evidence b using(fingerprint)
    ), walk(origin,root) as (
      select distinct origin,origin from evidence
      union
      select r.dst,w.root from walk w join related r on r.src=w.origin
    )
    select count(distinct root) into independent from (
      select min(root) as root from walk group by origin
    ) groups;
    select max(p.provider_timestamp) into event_time
      from news.event_documents d join news.discovery_provenance p on p.document_id=d.document_id
      join news.acquisition_licences l on l.id=p.licence_id
      where d.event_id=affected_event and l.revoked_at is null and l.retention_until>instant;
    select title into headline from news.events where id=affected_event;
    impact := case when headline ~* '\m(flood|flooding|election|elections)\M' then 75
      when headline ~* '\m(solar|power)\M' then 65 else 35 end;
    urgency := case when event_time between instant-interval '2 hours' and instant then 100
      when event_time between instant-interval '1 day' and instant then 50 else 0 end;
    regional := case when exists (select 1 from news.event_locations e join news.locations l on l.id=e.location_id
      where e.event_id=affected_event and l.country_code='NG') then 100
      when exists (select 1 from news.event_locations e where e.event_id=affected_event) then 75 else 50 end;
    historical := case when headline ~* '\m(centenary|anniversary|historical|archive)\M' then 75 else 0 end;
    components := jsonb_build_object('impact',impact,'evidence',least(independent*25,100),
      'urgency',urgency,'regional',regional,'historical',historical);
    insert into news.discovery_ranks(event_id,run_id,independent_origins,score_components,score,label)
      values(affected_event,run.id,independent,components,
        case when independent>0 then (impact*30+least(independent*25,100)*25+urgency*20+regional*15+historical*10)/100.0 end,
        case when independent=0 then 'review' when urgency=100 then 'breaking' when independent>=2 then 'trending'
          when exists(select 1 from news.discovery_ranks r where r.event_id=affected_event)
            and exists(select 1 from news.event_documents d join news.discovery_provenance p on p.document_id=d.document_id
              where d.event_id=affected_event and p.run_id=run.id and p.origin is not null
                and not exists(select 1 from news.event_documents old_d join news.discovery_provenance old_p
                  on old_p.document_id=old_d.document_id
                  where old_d.event_id=affected_event and old_p.run_id<>run.id and old_p.fingerprint=p.fingerprint))
            then 'developing' else 'review' end);
  end loop;

  update ai_ops.discovery_runs set state='complete',received=jsonb_array_length(documents),finished_at=instant where id=run.id;
  update news.discovery_endpoints set last_success=instant,consecutive_failures=0,etag=left(response_etag,256) where id=endpoint.id;
  return 'complete';
end
$$;

alter table news.discovery_endpoints enable row level security;
alter table news.acquisition_licences enable row level security;
alter table news.discovery_provenance enable row level security;
alter table news.discovery_clusters enable row level security;
alter table news.discovery_entities enable row level security;
alter table news.discovery_ranks enable row level security;
alter table ai_ops.discovery_runs enable row level security;
alter table ai_ops.discovery_usage enable row level security;
revoke all on function ai_ops.require_ingestion() from public, anon, authenticated, service_role;
revoke all on function geo_api.begin_discovery(uuid,timestamptz),
  geo_api.finish_discovery(uuid,jsonb,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function geo_api.begin_discovery(uuid,timestamptz),
  geo_api.finish_discovery(uuid,jsonb,text,integer,text) to authenticated;

create function geo_api.due_discovery()
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
begin
  perform ai_ops.require_ingestion();
  return array(select e.id from news.discovery_endpoints e where e.enabled and e.fixture and e.next_due <= now()
    and exists(select 1 from news.acquisition_licences l where l.endpoint_id=e.id and l.revoked_at is null
      and now()>=l.valid_from and now()<l.valid_until)
    order by e.next_due,e.id limit 30);
end
$$;

create function geo_api.discovery_budget()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  month_start date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  perform ai_ops.require_ingestion();
  return (select jsonb_object_agg(config.scope,jsonb_build_object(
    'requests',coalesce(u.requests,0),'amountMinor',coalesce(u.amount_minor,0),
    'limitMinor',config.ceiling,'alerts',array(select t from unnest(config.thresholds) t
      where t<=coalesce(u.amount_minor,0)),
    'blocked',coalesce(u.amount_minor,0)>=config.ceiling))
    from (values ('development',5000,array[3500,4500]),('launch',30000,array[21000,25000,27000]))
      config(scope,ceiling,thresholds)
    left join ai_ops.discovery_usage u on u.scope=config.scope and u.month=month_start);
end
$$;

revoke all on function geo_api.due_discovery(),geo_api.discovery_budget()
  from public,anon,authenticated,service_role;
grant execute on function geo_api.due_discovery(),geo_api.discovery_budget() to authenticated;

create or replace function app.require_human(role_code text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if (auth.jwt()->>'aal') is distinct from 'aal2'
    or not app.has_role(role_code)
    or app.has_role('verification_agent') or app.has_role('ai_editor') or app.has_role('ingestion_operator') then
    raise exception 'Privileged human session required' using errcode = '42501';
  end if;
end
$$;


create or replace function geo_api.set_role(target_user uuid, role_code text, enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  selected_role uuid;
  changed uuid;
begin
  perform pg_advisory_xact_lock(68250311);
  perform app.require_human('super_admin');
  if enabled is null then raise exception 'Role state is required'; end if;
  select id into strict selected_role from app.roles where code = role_code;
  if enabled then
    if exists (
      select 1 from app.user_roles ur join app.roles r on r.id = ur.role_id
      where ur.user_id = target_user and ur.revoked_at is null
      and ((r.code in ('verification_agent', 'ai_editor', 'ingestion_operator')) <> (role_code in ('verification_agent', 'ai_editor', 'ingestion_operator')))
    ) then raise exception 'Human and automation roles must use separate identities'; end if;
    insert into app.user_roles(user_id, role_id, granted_by)
      values (target_user, selected_role, auth.uid()) on conflict do nothing returning id into changed;
  else
    if role_code = 'super_admin' and not exists (
      select 1 from app.user_roles
      where role_id = selected_role and revoked_at is null and user_id <> target_user
    ) then raise exception 'The last super administrator must remain active'; end if;
    update app.user_roles set revoked_at = clock_timestamp()
      where user_id = target_user and role_id = selected_role and revoked_at is null returning id into changed;
  end if;
  if changed is not null then
    perform governance.log_event(
      case when enabled then 'role.granted' else 'role.revoked' end,
      target_user, jsonb_build_object('role', role_code, 'grant_id', changed)
    );
  end if;
end
$$;


-- Candidate registration grants no acquisition or publication rights.
insert into news.sources(name) values ('GDELT'), ('World Bank'), ('Premium Times') on conflict do nothing;
insert into news.discovery_endpoints(source_id,locator,adapter,fixture)
select s.id, candidate.locator,candidate.adapter,false
from (values
  ('GDELT','https://api.gdeltproject.org/api/v2/doc/doc?query=%28Nigeria%20OR%20Africa%29&mode=artlist&format=json&maxrecords=10','gdelt'),
  ('World Bank','https://api.worldbank.org/v2/country/NGA/indicator/SP.POP.TOTL?format=json&per_page=10&mrv=10','world-bank'),
  ('Premium Times','pending:premium-times-authorized-feed','rss')
) candidate(name,locator,adapter) join news.sources s on s.name=candidate.name;

create function geo_api.record_discovery_cost(budget_scope text, total_minor bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  month_start date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  perform app.require_human('super_admin');
  if budget_scope is null or budget_scope not in ('development','launch') or total_minor is null or total_minor<0
    then raise exception 'Invalid budget observation'; end if;
  insert into ai_ops.discovery_usage(month,scope,amount_minor) values(month_start,budget_scope,total_minor)
  on conflict (month,scope) do update set amount_minor=excluded.amount_minor
    where ai_ops.discovery_usage.amount_minor < excluded.amount_minor;
  if found then
    perform governance.log_event('discovery.cost_reconciled', auth.uid(),
      jsonb_build_object('scope',budget_scope,'month',month_start,'usd_minor',total_minor));
  end if;
end
$$;
revoke all on function geo_api.record_discovery_cost(text,bigint) from public,anon,authenticated,service_role;
grant execute on function geo_api.record_discovery_cost(text,bigint) to authenticated;

create function news.audit_acquisition_licence() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform governance.log_event('discovery.licence_changed',new.id,
    jsonb_build_object('endpoint_id',new.endpoint_id,'revoked',new.revoked_at is not null,
      'valid_until',new.valid_until,'operation',tg_op));
  return new;
end
$$;
create trigger discovery_licence_audit after insert or update on news.acquisition_licences
  for each row execute function news.audit_acquisition_licence();
revoke all on function news.audit_acquisition_licence() from public,anon,authenticated,service_role;

create function geo_api.discovery_health()
returns table (endpoint_id uuid, adapter text, enabled boolean, fixture boolean,
  next_due timestamptz, last_success timestamptz, consecutive_failures integer,
  latest_state text, latest_error text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ai_ops.require_ingestion();
  return query select e.id,e.adapter,e.enabled,e.fixture,e.next_due,e.last_success,e.consecutive_failures,
    r.state,r.error_code
    from news.discovery_endpoints e
    left join lateral (
      select d.state,d.error_code from ai_ops.discovery_runs d where d.endpoint_id=e.id
      order by d.cycle desc limit 1
    ) r on true
    order by e.id;
end
$$;
revoke all on function geo_api.discovery_health() from public,anon,authenticated,service_role;
grant execute on function geo_api.discovery_health() to authenticated;
