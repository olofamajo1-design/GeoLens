-- Restricted local pilot. Candidate endpoints remain disabled and unlicensed
-- until their terms and the runtime's verifiable egress path have been reviewed.
create view news.discovery_pilot_sources as
select * from (values
  ('gdelt',
    'https://api.gdeltproject.org/api/v2/doc/doc?query=%28Nigeria%20OR%20Africa%29&mode=artlist&format=json&maxrecords=10',
    'https://gdeltproject.org/about.html',
    'The GDELT Project (DOC 2.0 API)'),
  ('world-bank',
    'https://api.worldbank.org/v2/country/NGA/indicator/SP.POP.TOTL?format=json&per_page=10&mrv=10',
    'https://www.worldbank.org/ext/en/legal/terms-conditions/datasets',
    'World Bank, World Development Indicators: Population, total (SP.POP.TOTL), Nigeria')
) as source(adapter, locator, terms_reference, attribution);
revoke all on news.discovery_pilot_sources from public,anon,authenticated,service_role;

create table ai_ops.discovery_pilot_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  expires_at timestamptz not null check (isfinite(expires_at))
);
alter table ai_ops.discovery_pilot_operators enable row level security;
revoke all on ai_ops.discovery_pilot_operators from public,anon,authenticated,service_role;

alter table ai_ops.discovery_runs
  add column pilot_operator uuid references auth.users(id),
  add column inserted integer not null default 0 check (inserted between 0 and received);

alter table news.documents add column discovery_pilot boolean not null default false;
alter table news.events add column discovery_pilot boolean not null default false;
alter table news.discovery_provenance
  add column pilot_expires_at timestamptz,
  add column pilot_location_id uuid references news.locations(id),
  add column pilot_entities text[] not null default '{}',
  add column population_year integer,
  add column population_value bigint,
  add constraint pilot_population_observation check (
    (population_year is null and population_value is null) or
    (pilot_expires_at is not null and population_year is not null and population_value is not null
      and population_year between 1960 and 9999 and population_value between 0 and 9007199254740991)
  );
create index discovery_pilot_expiry on news.discovery_provenance(pilot_expires_at) where pilot_expires_at is not null;

create function ai_ops.require_discovery_pilot() returns void
language plpgsql stable set search_path = '' as $$
begin
  perform ai_ops.require_ingestion();
  if not exists (select 1 from ai_ops.discovery_pilot_operators
    where user_id=auth.uid() and expires_at>statement_timestamp()) then
    raise exception 'Pilot operator grant required' using errcode='42501';
  end if;
end
$$;
revoke all on function ai_ops.require_discovery_pilot() from public,anon,authenticated,service_role;

-- A current grant and one request reservation are consumed before any provider I/O.
-- Unlike fixture leases, a live reservation is never returned to a second caller.
create function geo_api.reserve_discovery_pilot(source_adapter text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  endpoint news.discovery_endpoints%rowtype;
  licence news.acquisition_licences%rowtype;
  policy news.discovery_pilot_sources%rowtype;
  run_id uuid;
  instant timestamptz;
  usage_month date;
  cycle_time timestamptz;
begin
  perform ai_ops.require_discovery_pilot();
  select * into policy from news.discovery_pilot_sources where adapter=source_adapter;
  if not found then return '{"status":"inactive"}'::jsonb; end if;
  select e.* into endpoint from news.discovery_endpoints e
    where e.locator=policy.locator and e.adapter=policy.adapter and e.enabled and not e.fixture for update;
  if not found then return '{"status":"inactive"}'::jsonb; end if;

  instant := clock_timestamp();
  cycle_time := date_bin('15 minutes', instant, '2000-01-01T00:00:00Z'::timestamptz);
  usage_month := date_trunc('month', instant at time zone 'UTC')::date;
  select l.* into licence from news.acquisition_licences l
    where l.endpoint_id=endpoint.id and l.revoked_at is null and l.terms_reference=policy.terms_reference
      and l.attribution=policy.attribution and instant>=l.valid_from and instant<l.valid_until
      and instant<l.retention_until and isfinite(l.valid_until) and isfinite(l.retention_until)
    order by l.valid_from desc,l.id limit 1 for share;
  if not found then return '{"status":"inactive"}'::jsonb; end if;
  if endpoint.next_due>instant then return '{"status":"not_due"}'::jsonb; end if;

  update ai_ops.discovery_runs set state='failed',error_code='lease_expired',finished_at=instant
    where endpoint_id=endpoint.id and state='running' and started_at<=instant-interval '5 minutes';
  if exists (select 1 from ai_ops.discovery_runs where endpoint_id=endpoint.id and state='running')
    then return '{"status":"not_due"}'::jsonb; end if;

  insert into ai_ops.discovery_usage(month,scope) values(usage_month,'development') on conflict do nothing;
  perform 1 from ai_ops.discovery_usage where month=usage_month and scope='development' for update;
  if exists(select 1 from ai_ops.discovery_usage where month=usage_month and scope='development'
    and (amount_minor>=5000 or requests>=10000)) then return '{"status":"quota_blocked"}'::jsonb; end if;

  insert into ai_ops.discovery_runs(endpoint_id,licence_id,cycle,pilot_operator)
    values(endpoint.id,licence.id,cycle_time,auth.uid()) on conflict do nothing returning id into run_id;
  if run_id is null then return '{"status":"not_due"}'::jsonb; end if;
  update news.discovery_endpoints set next_due=instant+make_interval(mins=>endpoint.poll_minutes) where id=endpoint.id;
  update ai_ops.discovery_usage set requests=requests+1 where month=usage_month and scope='development';
  return jsonb_build_object('status','reserved','id',run_id,'locator',policy.locator);
end
$$;
revoke all on function geo_api.reserve_discovery_pilot(text) from public,anon,authenticated,service_role;
grant execute on function geo_api.reserve_discovery_pilot(text) to authenticated;

-- Keep provisional metadata out of durable editorial and research references.
create function news.reject_pilot_document_use() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from news.documents where id=new.document_id and discovery_pilot) then
    raise exception 'Pilot metadata cannot become an editorial or research citation' using errcode='42501';
  end if;
  return new;
end
$$;
create trigger reject_pilot_version_citation before insert or update of document_id on editorial.version_citations
  for each row execute function news.reject_pilot_document_use();
create trigger reject_pilot_research_evidence before insert or update of document_id on research.evidence
  for each row execute function news.reject_pilot_document_use();

create function news.reject_pilot_event_use() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from news.events where id=new.event_id and discovery_pilot) then
    raise exception 'Pilot events cannot become permanent research references' using errcode='42501';
  end if;
  return new;
end
$$;
create trigger reject_pilot_historical_research before insert or update of event_id on research.historical_research
  for each row execute function news.reject_pilot_event_use();

create function news.require_matching_discovery_scope() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select discovery_pilot from news.events where id=new.event_id) is distinct from
    (select discovery_pilot from news.documents where id=new.document_id) then
    raise exception 'Discovery event and document scopes must match' using errcode='42501';
  end if;
  return new;
end
$$;
create trigger match_discovery_event_scope before insert or update of event_id,document_id on news.event_documents
  for each row execute function news.require_matching_discovery_scope();

revoke all on function news.reject_pilot_document_use(), news.reject_pilot_event_use(),
  news.require_matching_discovery_scope() from public,anon,authenticated,service_role;

create function ai_ops.purge_discovery_pilot() returns integer
language plpgsql set search_path = '' as $$
declare
  expired uuid[];
  affected_events uuid[];
  affected_event uuid;
  surviving_title text;
  instant timestamptz;
begin
  perform pg_advisory_xact_lock(78294221);
  instant := clock_timestamp();
  select array_agg(p.document_id) into expired from news.discovery_provenance p
    join news.acquisition_licences l on l.id=p.licence_id
    where p.pilot_expires_at is not null
      and (p.pilot_expires_at<=instant or l.retention_until<=instant or l.revoked_at is not null);
  if expired is null then return 0; end if;

  select array_agg(distinct event_id) into affected_events from news.event_documents where document_id=any(expired);
  delete from news.event_documents where document_id=any(expired);
  delete from news.discovery_provenance where document_id=any(expired);
  delete from news.documents where id=any(expired) and discovery_pilot;

  -- Rebuild derived fields from surviving records only. Drop previous ranking
  -- snapshots for these events because they include the removed evidence.
  foreach affected_event in array coalesce(affected_events, '{}'::uuid[])
  loop
    delete from news.discovery_ranks where event_id=affected_event;
    delete from news.event_locations where event_id=affected_event;
    delete from news.discovery_entities where event_id=affected_event;
    select p.title into surviving_title from news.event_documents d
      join news.discovery_provenance p on p.document_id=d.document_id
      join news.documents doc on doc.id=d.document_id
      where d.event_id=affected_event order by doc.retrieved_at,doc.id limit 1;
    if not found then
      delete from news.discovery_clusters where event_id=affected_event and not fixture;
      delete from news.events where id=affected_event and discovery_pilot;
    else
      update news.events set title=surviving_title where id=affected_event and discovery_pilot;
      insert into news.event_locations(event_id,location_id)
        select distinct d.event_id,p.pilot_location_id from news.event_documents d
        join news.discovery_provenance p on p.document_id=d.document_id
        where d.event_id=affected_event and p.pilot_location_id is not null;
      insert into news.discovery_entities(event_id,entity_name)
        select distinct d.event_id,e.name from news.event_documents d
        join news.discovery_provenance p on p.document_id=d.document_id
        cross join lateral unnest(p.pilot_entities) e(name)
        where d.event_id=affected_event;
    end if;
  end loop;
  return cardinality(expired);
end
$$;
revoke all on function ai_ops.purge_discovery_pilot() from public,anon,authenticated,service_role;

-- The original fixture endpoint and the restricted pilot use the same normalizer persistence,
-- duplicate handling, event clustering and ranking transaction.
create function ai_ops.finish_discovery_batch(target_run uuid, documents jsonb, failure text,
  retry_seconds integer, response_etag text, pilot boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  run ai_ops.discovery_runs%rowtype;
  endpoint news.discovery_endpoints%rowtype;
  licence news.acquisition_licences%rowtype;
  policy news.discovery_pilot_sources%rowtype;
  observation jsonb;
  population_year_value integer;
  population_count bigint;
  location_id_value uuid;
  new_documents integer := 0;
  metadata_digest bytea;
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
  select e.* into strict endpoint from news.discovery_endpoints e join ai_ops.discovery_runs r on r.endpoint_id=e.id
    where r.id=target_run for update of e;
  select * into strict run from ai_ops.discovery_runs where id=target_run for update;
  if endpoint.fixture = pilot or (pilot and run.pilot_operator is distinct from auth.uid())
    or (not pilot and run.pilot_operator is not null) then
    raise exception 'Run is outside this discovery scope' using errcode='42501';
  end if;
  if run.state <> 'running' then
    return jsonb_build_object('status',run.state,'received',run.received,'inserted',run.inserted,'error',run.error_code);
  end if;
  select * into strict licence from news.acquisition_licences where id=run.licence_id for share;
  if err is null then
    -- Use the same lock ordering as retention, canonical deduplication and clustering.
    perform pg_advisory_xact_lock(78294221);
  end if;
  instant := clock_timestamp();
  if pilot then
    select * into policy from news.discovery_pilot_sources where locator=endpoint.locator and adapter=endpoint.adapter;
    if not found or licence.terms_reference<>policy.terms_reference or licence.attribution<>policy.attribution then
      err := 'licence_unavailable';
    end if;
  end if;
  if not endpoint.enabled or licence.revoked_at is not null or instant < licence.valid_from or instant >= licence.valid_until
    or (pilot and instant>=licence.retention_until) then err := 'licence_unavailable'; end if;
  if instant > run.started_at + interval '5 minutes' then err := 'lease_expired'; end if;
  if err is not null then
    update ai_ops.discovery_runs set state='failed', error_code=case when err in (
      'licence_unavailable','lease_expired','rate_limited','upstream_error','upstream_unavailable','invalid_payload',
      'destination_denied','dns_no_addresses','dns_destination_denied','dns_resolution_failed',
      'tls_peer_denied','tls_peer_mismatch','tls_validation_failed','retrieval_timeout','upstream_connection_failed',
      'redirect_denied','unexpected_content_type','unexpected_content_encoding','body_too_large','empty_body',
      'proxy_peer_unverifiable'
    ) then err else 'ingestion_error' end, finished_at=instant where id=run.id returning error_code into err;
    update news.discovery_endpoints set consecutive_failures=consecutive_failures+1,
      next_due=greatest(next_due, instant+make_interval(secs=>greatest(0,coalesce(retry_seconds,0))))
      where id=endpoint.id;
    return jsonb_build_object('status','failed','received',0,'inserted',0,'error',err);
  end if;
  if jsonb_typeof(documents) is distinct from 'array' or jsonb_array_length(documents)>10
    or octet_length(documents::text)>80000 then raise exception 'Invalid discovery batch'; end if;

  if pilot then perform ai_ops.purge_discovery_pilot(); end if;
  for item in select value from jsonb_array_elements(documents)
  loop
    if jsonb_typeof(item) is distinct from 'object'
      or item - array['externalReference','originalUrl','canonicalUrl','title','occurredAt','timeBasis','language',
        'digest','fingerprint','origin','location','entities','cluster','observation'] <> '{}'::jsonb
      or length(coalesce(item->>'originalUrl',''))>2048 or length(coalesce(item->>'canonicalUrl',''))>2048
      or length(coalesce(item->>'cluster',''))>160 or length(coalesce(item->>'language',''))>40
      or (item->>'canonicalUrl' is not null and item->>'canonicalUrl' !~ '^https://[^/@ ]+(/|$)')
      or nullif(trim(item->>'title'),'') is null or length(item->>'title')>400
      or nullif(trim(item->>'externalReference'),'') is null or length(item->>'externalReference')>2048
      or coalesce(item->>'digest','') !~ '^[0-9a-f]{64}$' or coalesce(item->>'fingerprint','') !~ '^[0-9a-f]{64}$'
      then raise exception 'Invalid normalized record'; end if;
    population_year_value := null;
    population_count := null;
    if pilot and endpoint.adapter='world-bank' then
      observation := item->'observation';
      if jsonb_typeof(observation) is distinct from 'object' or observation-array['country','indicator','year','value']<>'{}'::jsonb
        or observation->>'country' is distinct from 'NGA' or observation->>'indicator' is distinct from 'SP.POP.TOTL'
        or jsonb_typeof(observation->'year') is distinct from 'number'
        or jsonb_typeof(observation->'value') is distinct from 'number'
        or coalesce(observation->>'year','') !~ '^[0-9]{4}$'
        or coalesce(observation->>'value','') !~ '^(0|[1-9][0-9]{0,15})$'
        or item->>'externalReference' is distinct from 'NGA:SP.POP.TOTL:'||(observation->>'year')
        or item->>'title' is distinct from 'Nigeria — Population, total: '||(observation->>'value')||' ('||(observation->>'year')||')'
        or item->>'canonicalUrl' is not null or item->>'originalUrl' is not null
        or item->>'occurredAt' is not null or item->>'timeBasis' is not null
        or item->>'origin' is distinct from 'world-bank'
        then raise exception 'Observation outside approved World Bank scope'; end if;
      population_year_value := (observation->>'year')::integer;
      population_count := (observation->>'value')::bigint;
      if population_year_value<1960 or population_year_value>extract(year from instant at time zone 'UTC')
        or population_count>9007199254740991 then raise exception 'Invalid population observation'; end if;
    elsif item ? 'observation' then
      raise exception 'Observation outside approved World Bank scope';
    elsif pilot and (item->>'canonicalUrl' is null or item->>'originalUrl' is not null
      or item->>'externalReference' is distinct from item->>'canonicalUrl'
      or (item->>'occurredAt' is not null and item->>'timeBasis' is distinct from 'observed')) then
      raise exception 'Lead outside approved GDELT scope';
    end if;

    metadata_digest := case when pilot then extensions.digest(convert_to(jsonb_build_array(
      'pilot:v1',endpoint.adapter,item->>'externalReference',item->>'title',item->>'language',
      item->>'origin',population_year_value,population_count)::text,'UTF8'),'sha256')
      else decode(item->>'digest','hex') end;
    if item->>'canonicalUrl' is not null and exists (
      select 1 from news.discovery_provenance p join news.documents d on d.id=p.document_id
      where d.source_id=endpoint.source_id and d.discovery_pilot=pilot and p.canonical_url=item->>'canonicalUrl'
        and d.digest=metadata_digest
    ) then continue; end if;
    doc_id := null;
    insert into news.documents(source_id,external_reference,digest,retrieved_at,discovery_pilot)
      values(endpoint.source_id,item->>'externalReference',metadata_digest,instant,pilot)
      on conflict do nothing returning id into doc_id;
    if doc_id is null then continue; end if;
    new_documents := new_documents+1;

    location_id_value := null;
    if jsonb_typeof(item->'location')='object' then
      insert into news.locations(name,country_code) values(item->'location'->>'name',item->'location'->>'country')
        on conflict do nothing;
      select id into location_id_value from news.locations
        where name=item->'location'->>'name' and country_code=item->'location'->>'country';
    end if;
    insert into news.discovery_provenance(document_id,run_id,licence_id,title,original_url,canonical_url,
      provider_timestamp,time_basis,language,attribution,origin,fingerprint,pilot_expires_at,pilot_location_id,
      pilot_entities,population_year,population_value)
    values(doc_id,run.id,licence.id,item->>'title',item->>'originalUrl',item->>'canonicalUrl',
      (item->>'occurredAt')::timestamptz,item->>'timeBasis',item->>'language',licence.attribution,
      case when item->>'origin' in ('reuters','associated-press','world-bank') then item->>'origin' end,item->>'fingerprint',
      case when pilot then least(instant+interval '720 hours',licence.retention_until) end,
      case when pilot then location_id_value end,
      case when pilot then array(select jsonb_array_elements_text(coalesce(item->'entities','[]'))) else '{}'::text[] end,
      population_year_value,population_count);

    cluster_key_value := (case when pilot then 'pilot:' else 'fixture:' end) || coalesce(item->>'cluster',item->>'fingerprint');
    select event_id into affected_event from news.discovery_clusters where cluster_key=cluster_key_value;
    if not found then
      insert into news.events(title,discovery_pilot) values(item->>'title',pilot) returning id into affected_event;
      insert into news.discovery_clusters values(cluster_key_value,affected_event,not pilot);
    end if;
    insert into news.event_documents values(affected_event,doc_id);
    if location_id_value is not null then
      insert into news.event_locations values(affected_event,location_id_value) on conflict do nothing;
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
        and (p.pilot_expires_at is null or p.pilot_expires_at>instant)
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
      where d.event_id=affected_event and l.revoked_at is null and l.retention_until>instant
      and (p.pilot_expires_at is null or p.pilot_expires_at>instant);
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

  update ai_ops.discovery_runs set state='complete',received=jsonb_array_length(documents),inserted=new_documents,
    finished_at=instant where id=run.id;
  update news.discovery_endpoints set last_success=instant,consecutive_failures=0,etag=left(response_etag,256) where id=endpoint.id;
  return jsonb_build_object('status','complete','received',jsonb_array_length(documents),'inserted',new_documents);
end
$$;

revoke all on function ai_ops.finish_discovery_batch(uuid,jsonb,text,integer,text,boolean)
  from public,anon,authenticated,service_role;

create or replace function geo_api.finish_discovery(target_run uuid, documents jsonb, failure text default null,
  retry_seconds integer default 0, response_etag text default null)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform ai_ops.require_ingestion();
  return ai_ops.finish_discovery_batch(target_run,documents,failure,retry_seconds,response_etag,false)->>'status';
end
$$;

create function geo_api.finish_discovery_pilot(target_run uuid, documents jsonb, failure text default null,
  retry_seconds integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ai_ops.require_discovery_pilot();
  return ai_ops.finish_discovery_batch(target_run,documents,failure,retry_seconds,null,true);
end
$$;
revoke all on function geo_api.finish_discovery_pilot(uuid,jsonb,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function geo_api.finish_discovery_pilot(uuid,jsonb,text,integer) to authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('geolens-discovery-pilot-retention','* * * * *',
  'select ai_ops.purge_discovery_pilot()');
