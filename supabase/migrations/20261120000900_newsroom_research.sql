-- Research-only fixtures reuse the same story locks, task states, leases and budget ledger.
alter table ai_ops.workflow_runs
  add column research_only boolean not null default false,
  drop constraint workflow_runs_fixture_event_id_key,
  drop constraint workflow_runs_fixture_state_check,
  add unique (fixture_event_id,research_only),
  add constraint newsroom_research_fixture check (
    (not research_only or fixture_event_id is not null) and
    (fixture_state not in ('research_ready','triaged') or research_only)
  ),
  add check (fixture_state in ('active','human_review','escalated','cancelled','research_ready','triaged'));

alter table ai_ops.newsroom_policy
  add column research_input_tokens integer not null default 12288 check (research_input_tokens between 1 and 32000),
  add column research_output_tokens integer not null default 4096 check (research_output_tokens between 1 and 4096);

-- An excerpt and its synthetic annotation can only belong to an ingested event document.
create table research.newsroom_fixture_evidence (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  document_id uuid not null,
  locator text not null check (char_length(locator) between 1 and 200),
  excerpt text not null check (char_length(excerpt) between 1 and 800),
  annotation jsonb not null check (jsonb_typeof(annotation)='object' and
    coalesce(annotation->>'kind','') in ('history','claim','observation','analysis','scenario')
    and octet_length(annotation::text)<=16000),
  foreign key (event_id,document_id) references news.event_documents(event_id,document_id),
  unique (id,event_id)
);
create index newsroom_fixture_evidence_by_event on research.newsroom_fixture_evidence(event_id,document_id);

create table research.newsroom_fixture_findings (
  attempt_id uuid primary key references ai_ops.task_attempts(id),
  run_id uuid not null references ai_ops.workflow_runs(id),
  event_id uuid not null references news.events(id),
  stage text not null check (stage in ('discovery','history','verification','analysis')),
  payload jsonb not null check (jsonb_typeof(payload)='object' and payload->'synthetic'='true'::jsonb),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (run_id,stage),
  unique (attempt_id,event_id)
);

create table research.newsroom_fixture_citations (
  attempt_id uuid not null,
  event_id uuid not null,
  evidence_id uuid not null,
  primary key (attempt_id,evidence_id),
  foreign key (attempt_id,event_id) references research.newsroom_fixture_findings(attempt_id,event_id),
  foreign key (evidence_id,event_id) references research.newsroom_fixture_evidence(id,event_id)
);

create table research.newsroom_fixture_sources (
  attempt_id uuid not null,
  event_id uuid not null,
  document_id uuid not null,
  primary key (attempt_id,document_id),
  foreign key (attempt_id,event_id) references research.newsroom_fixture_findings(attempt_id,event_id),
  foreign key (event_id,document_id) references news.event_documents(event_id,document_id)
);

alter table research.newsroom_fixture_evidence enable row level security;
alter table research.newsroom_fixture_findings enable row level security;
alter table research.newsroom_fixture_citations enable row level security;
alter table research.newsroom_fixture_sources enable row level security;
revoke all on research.newsroom_fixture_evidence, research.newsroom_fixture_findings,
  research.newsroom_fixture_citations, research.newsroom_fixture_sources from public,anon,authenticated,service_role;

create trigger fixture_excerpts_are_immutable before update or delete on research.newsroom_fixture_evidence
  for each row execute function editorial.reject_snapshot_change();

create function ai_ops.research_source_documents(target_event uuid)
returns table (document_id uuid,source_id uuid,licence_id uuid,headline text,attribution text,canonical_url text,origin text,fingerprint text)
language sql stable set search_path = '' as $$
  select d.id,d.source_id,l.id,p.title,p.attribution,p.canonical_url,p.origin,p.fingerprint
  from news.event_documents ed join news.documents d on d.id=ed.document_id
  join news.discovery_clusters c on c.event_id=ed.event_id
  join news.events e on e.id=ed.event_id
  join news.discovery_provenance p on p.document_id=d.id
  join ai_ops.discovery_runs r on r.id=p.run_id and r.licence_id=p.licence_id
  join news.discovery_endpoints ep on ep.id=r.endpoint_id and ep.source_id=d.source_id
  join news.acquisition_licences l on l.id=p.licence_id and l.endpoint_id=ep.id
  where ed.event_id=target_event and c.fixture and not e.discovery_pilot and not d.discovery_pilot and ep.fixture
    and r.state='complete' and l.revoked_at is null and l.retention_until>statement_timestamp()
    and d.retrieved_at>=l.valid_from and d.retrieved_at<l.valid_until
$$;

create or replace function ai_ops.seed_fixture_tasks(run_id uuid, prompts jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  stage_row record;
  tasks jsonb := '{}';
begin
  for stage_row in select * from (values
    ('discovery', array[]::text[]), ('history', array['discovery']), ('verification', array['discovery']),
    ('analysis', array['history','verification']), ('writing', array['analysis']), ('visual', array['analysis']),
    ('reverification', array['writing','visual']), ('editorial', array['writing','visual','reverification'])
  ) as g(stage, prerequisites)
  where stage in ('discovery','history','verification','analysis') or not
    (select research_only from ai_ops.workflow_runs where id=run_id)
  loop
    tasks := tasks || jsonb_build_object(stage_row.stage, ai_ops.add_fixture_task(run_id,stage_row.stage,0::smallint,
      (prompts->>(select agent_code from ai_ops.newsroom_stages where stage=stage_row.stage))::uuid,
      array(select (tasks->>dependency)::uuid from unnest(stage_row.prerequisites) as dependency)));
  end loop;
end
$$;

drop function geo_api.scan_newsroom_fixtures(jsonb);

-- This intake path can see ranked, completed fixture discovery. Live pilot events never enter it.
create function geo_api.scan_newsroom_fixtures(prompt_manifest jsonb, research_mode boolean default false) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  policy ai_ops.newsroom_policy%rowtype;
  prompt_row record;
  prompt_id uuid;
  prompts jsonb := '{}';
  event_row record;
  priority text;
  attention boolean;
  story_id uuid;
  run_id uuid;
  instant timestamptz;
begin
  perform ai_ops.require_newsroom();
  if research_mode is null then raise exception 'Fixture research mode is required'; end if;
  -- Serialize intake and policy changes. Task execution locks only its run and the budget month.
  select * into strict policy from ai_ops.newsroom_policy for update;
  instant := clock_timestamp();
  if jsonb_typeof(prompt_manifest) is distinct from 'array' or jsonb_array_length(prompt_manifest) <> 8 then
    raise exception 'Invalid fixture prompt manifest';
  end if;
  for prompt_row in
    select a.id, p."agentId" as code, p.version, p.digest
    from jsonb_to_recordset(prompt_manifest) as p("agentId" text, version integer, digest text)
    join ai_ops.agents a on a.code=p."agentId"
    order by a.code
  loop
    if prompts ? prompt_row.code or coalesce(prompt_row.version,0) <
        (case when research_mode and prompt_row.code in ('GL-AGENT-002','GL-AGENT-003','GL-AGENT-004','GL-AGENT-005') then 2 else 1 end)
      or coalesce(prompt_row.digest,'') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid fixture prompt'; end if;
    insert into ai_ops.prompt_versions(agent_id,version,digest)
      values (prompt_row.id,prompt_row.version,decode(prompt_row.digest,'hex')) on conflict do nothing;
    select id into prompt_id from ai_ops.prompt_versions where agent_id=prompt_row.id and version=prompt_row.version
      and digest=decode(prompt_row.digest,'hex');
    if not found then raise exception 'Fixture prompt version digest mismatch'; end if;
    prompts := prompts || jsonb_build_object(prompt_row.code,prompt_id);
  end loop;
  if (select count(*) from jsonb_object_keys(prompts)) <> 8 then raise exception 'Incomplete fixture prompt manifest'; end if;

  for event_row in
    select c.event_id, latest.id as rank_id, latest.score_components, latest.independent_origins, ranked.score
    from news.discovery_clusters c join news.events e on e.id=c.event_id
    join lateral (
      select r.* from news.discovery_ranks r join ai_ops.discovery_runs d on d.id=r.run_id
      join news.discovery_endpoints ep on ep.id=d.endpoint_id
      join news.acquisition_licences l on l.id=d.licence_id
      where r.event_id=c.event_id and ep.fixture and d.state='complete'
        and l.endpoint_id=ep.id and l.retention_until>instant and l.revoked_at is null
      order by d.cycle desc, d.finished_at desc, r.id desc limit 1
    ) latest on true
    cross join lateral (select ai_ops.newsroom_score(latest.score_components) as score) ranked
    left join ai_ops.newsroom_assessments previous on previous.event_id=c.event_id
    where c.fixture and not e.discovery_pilot and ranked.score is not null and latest.independent_origins >= 0
      and (previous.rank_id is distinct from latest.id or previous.assessed_at <= instant - interval '30 minutes'
        or previous.components is distinct from latest.score_components
        or previous.independent_origins is distinct from latest.independent_origins
        or ((research_mode or previous.priority in ('critical','high','standard') or previous.verification_attention)
          and not exists (select 1 from ai_ops.workflow_runs w where w.fixture_event_id=c.event_id and w.research_only=research_mode)))
    order by previous.assessed_at nulls first, c.event_id limit 50
  loop
    priority := case
      when event_row.score >= policy.critical then 'critical' when event_row.score >= policy.high then 'high'
      when event_row.score >= policy.standard then 'standard' when event_row.score >= policy.monitor then 'monitor'
      else 'archive' end;
    attention := (event_row.score_components->>'impact')::numeric >= policy.high_impact
      and ((event_row.score_components->>'evidence')::numeric < policy.weak_evidence or event_row.independent_origins < 2);
    insert into ai_ops.newsroom_assessments(event_id,rank_id,assessed_at,components,independent_origins,score,priority,verification_attention)
      values (event_row.event_id,event_row.rank_id,instant,event_row.score_components,event_row.independent_origins,event_row.score,priority,attention)
      on conflict (event_id) do update set rank_id=excluded.rank_id,assessed_at=excluded.assessed_at,components=excluded.components,
        independent_origins=excluded.independent_origins,score=excluded.score,priority=excluded.priority,
        verification_attention=excluded.verification_attention;
    if (research_mode or priority in ('critical','high','standard') or attention)
      and not exists (select 1 from ai_ops.workflow_runs where fixture_event_id=event_row.event_id and research_only=research_mode) then
      insert into editorial.stories(slug,synthetic) values ((case when research_mode then 'newsroom-research-' else 'newsroom-fixture-' end) || event_row.event_id,true)
        returning id into story_id;
      insert into ai_ops.workflow_runs(request_key,fixture_event_id,fixture_story_id,orchestrator_prompt_id,
        fixture_state,research_only,model,max_input_tokens,max_output_tokens,input_micros_per_token,output_micros_per_token)
        values ((case when research_mode then 'newsroom-research:' else 'newsroom-fixture:' end) || event_row.event_id,
          event_row.event_id,story_id,(prompts->>'GL-AGENT-001')::uuid,'active',research_mode,policy.model,
          case when research_mode then policy.research_input_tokens else policy.max_input_tokens end,
          case when research_mode then policy.research_output_tokens else policy.max_output_tokens end,
          policy.input_micros_per_token,policy.output_micros_per_token)
        returning id into run_id;
      perform ai_ops.seed_fixture_tasks(run_id,prompts);
      perform governance.log_event('newsroom.fixture_queued',run_id,jsonb_build_object('event_id',event_row.event_id,
        'rank_id',event_row.rank_id,'priority',priority,'verification_attention',attention,'research_only',research_mode));
    end if;
  end loop;
  return array(
    select w.id from ai_ops.workflow_runs w join ai_ops.newsroom_assessments a on a.event_id=w.fixture_event_id
    where w.fixture_state='active' and w.research_only=research_mode and (w.budget_retry_at is null or w.budget_retry_at <= instant)
    order by greatest(a.score,case when a.verification_attention then policy.high else 0 end) desc,
      a.verification_attention desc, w.created_at, w.id limit 50
  );
end
$$;

create function ai_ops.fixture_independent_sources(sources jsonb) returns integer
language sql immutable set search_path = '' as $$
  with recursive documents as (
    select n,item->>'origin' as origin,item->>'fingerprint' as fingerprint,item->>'canonicalUrl' as url
    from jsonb_array_elements(sources) with ordinality as docs(item,n)
  ), linked as (
    select a.n as src,b.n as dst from documents a join documents b
      on a.origin=b.origin or a.fingerprint=b.fingerprint or a.url=b.url
  ), connected(doc,root) as (
    select n,n from documents
    union
    select l.dst,c.root from connected c join linked l on l.src=c.doc
  )
  select count(distinct root)::integer from (
    select min(c.root) as root from connected c join documents d on d.n=c.doc
    where d.origin is not null group by c.doc
  ) known
$$;

create function ai_ops.research_fixture_input(target_run uuid,stage_name text,lease_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  assessment ai_ops.newsroom_assessments%rowtype;
  payload jsonb;
  sources jsonb;
  notes jsonb;
begin
  select * into strict run from ai_ops.workflow_runs where id=target_run and research_only;
  if stage_name='discovery' then
    select coalesce(jsonb_agg(jsonb_build_object('documentId',s.document_id,'sourceId',s.source_id,
      'headline',s.headline,'attribution',s.attribution,'canonicalUrl',s.canonical_url,'origin',s.origin,'fingerprint',s.fingerprint)
      order by s.document_id),'[]') into sources from (
        select * from ai_ops.research_source_documents(run.fixture_event_id) order by document_id limit 25
      ) s;
  else
    select a.input#>'{researchInput,sources}' into strict sources
    from research.newsroom_fixture_findings f join ai_ops.task_attempts a on a.id=f.attempt_id
    where f.run_id=run.id and f.stage='discovery';
  end if;
  payload := jsonb_build_object('stage',stage_name,'contractVersion',1,'synthetic',true,
    'eventId',run.fixture_event_id,'attemptId',lease_id,'sources',sources);
  select * into strict assessment from ai_ops.newsroom_assessments where event_id=run.fixture_event_id;

  if stage_name='discovery' then
    return payload || jsonb_build_object(
      'headline',(select title from news.events where id=run.fixture_event_id),
      'locations',coalesce((select jsonb_agg(jsonb_build_object('name',q.name,'country',q.country_code) order by q.country_code,q.name)
        from (select l.name,l.country_code from news.event_locations el join news.locations l on l.id=el.location_id
          where el.event_id=run.fixture_event_id order by l.country_code,l.name limit 25) q),'[]'),
      'entities',coalesce((select jsonb_agg(q.entity_name order by q.entity_name)
        from (select entity_name from news.discovery_entities where event_id=run.fixture_event_id order by entity_name limit 49) q),'[]'),
      'ingestionLabel',(select label from news.discovery_ranks where id=assessment.rank_id),
      'scores',assessment.components,'priority',assessment.priority,'verificationAttention',
        assessment.verification_attention or (
          (assessment.components->>'impact')::numeric >= (select high_impact from ai_ops.newsroom_policy)
          and ai_ops.fixture_independent_sources(sources)<2));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('evidenceId',n.id,'documentId',n.document_id,
    'locator',n.locator,'excerpt',n.excerpt,'annotation',n.annotation) order by n.id),'[]') into notes
  from (select e.* from research.newsroom_fixture_evidence e
    where e.event_id=run.fixture_event_id and exists (
      select 1 from jsonb_array_elements(sources) s where s->>'documentId'=e.document_id::text
    )
    and e.annotation->>'kind'=any(case stage_name when 'history' then array['history']
      when 'verification' then array['claim','observation'] when 'analysis' then array['analysis','scenario'] end)
    order by e.id limit 49) n;

  case stage_name
    when 'history' then return payload || jsonb_build_object('evidence',notes,'depth',
      case when (assessment.components->>'historical')::numeric>=75 then 'deep'
        when (assessment.components->>'historical')::numeric>=40 then 'extended' else 'contextual' end);
    when 'verification' then return payload || jsonb_build_object('evidence',notes,'asOf',(now() at time zone 'UTC')::date);
    when 'analysis' then return payload || jsonb_build_object('evidence',notes,
      'history',(select f.payload from research.newsroom_fixture_findings f where f.run_id=run.id and f.stage='history'),
      'verification',(select f.payload from research.newsroom_fixture_findings f where f.run_id=run.id and f.stage='verification'));
    else raise exception 'Unsupported research stage';
  end case;
end
$$;

alter function geo_api.claim_newsroom_fixtures(uuid) set schema ai_ops;
revoke all on function ai_ops.claim_newsroom_fixtures(uuid) from public,anon,authenticated,service_role;

create function geo_api.claim_newsroom_fixtures(target_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  batch jsonb := ai_ops.claim_newsroom_fixtures(target_run);
  item jsonb;
  packet jsonb;
  attempt_id uuid;
  specialized jsonb := '[]';
begin
  if not exists (select 1 from ai_ops.workflow_runs where id=target_run and research_only) then return batch; end if;
  for item in select value from jsonb_array_elements(batch->'claims')
  loop
    attempt_id := (item#>>'{task,attemptId}')::uuid;
    packet := ai_ops.research_fixture_input(target_run,item#>>'{task,stage}',attempt_id);
    update ai_ops.task_attempts set input=input||jsonb_build_object('researchInput',packet) where id=attempt_id;
    specialized := specialized||jsonb_build_array(item||jsonb_build_object('researchInput',packet));
  end loop;
  return batch||jsonb_build_object('claims',specialized);
end
$$;

create function ai_ops.fixture_evidence_refs(payload jsonb) returns setof text
language sql immutable set search_path = '' as $$
  select distinct item#>>'{}' from jsonb_path_query(payload,'$.**.evidenceIds[*]') as item
$$;

create function ai_ops.valid_fixture_references(target_run uuid,packet jsonb,payload jsonb) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  fixture_event uuid := (packet->>'eventId')::uuid;
  registered jsonb := payload->'sourceRegister';
  source_count integer;
  licensed_count integer;
begin
  if jsonb_typeof(registered) is distinct from 'array' then return false; end if;
  if exists (
    select 1 from (
      select value#>>'{}' as document_id from jsonb_array_elements(registered)
      union select v#>>'{}' from jsonb_path_query(payload,'$.**.documentIds[*]') v
    ) d where not exists (select 1 from jsonb_array_elements(packet->'sources') s where s->>'documentId'=d.document_id)
  ) then return false; end if;
  if exists (
    select 1 from ai_ops.fixture_evidence_refs(payload) as ref(evidence_id)
    left join research.newsroom_fixture_evidence k on k.id::text=ref.evidence_id and k.event_id=fixture_event
    where k.id is null or not (registered ? k.document_id::text) or (
      not exists (select 1 from jsonb_array_elements(packet->'evidence') p where p->>'evidenceId'=ref.evidence_id)
      and not (packet->>'stage'='analysis' and exists (
        select 1 from research.newsroom_fixture_findings parent join research.newsroom_fixture_citations c
          on c.attempt_id=parent.attempt_id
        where parent.run_id=target_run and parent.stage in ('history','verification') and c.evidence_id=k.id
      ))
    )
  ) then return false; end if;

  -- Publication has separate rights gates. This lock also keeps research settlement and
  -- acquisition licence revocation ordered against the source packet used in the attempt.
  select jsonb_array_length(packet->'sources') into source_count;
  select count(*) into licensed_count from (
    select s.document_id from ai_ops.research_source_documents(fixture_event) s
    join news.acquisition_licences l on l.id=s.licence_id
    where l.revoked_at is null and l.retention_until>clock_timestamp()
      and exists (select 1 from jsonb_array_elements(packet->'sources') p where p->>'documentId'=s.document_id::text)
    order by l.id,s.document_id for share of l
  ) locked;
  return source_count=licensed_count;
end
$$;

create function ai_ops.fixture_comparison_value(raw_value text,claim_type text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  clean text := normalize(trim(raw_value),NFC);
  parts text[];
begin
  if claim_type='date' then
    return case when clean ~ '^\d{4}-\d{2}-\d{2}$' and (clean::date)::text=clean then clean end;
  elsif claim_type='quotation' then
    return regexp_replace(clean,'^["“](.*)["”]$','\1');
  elsif claim_type='number' then
    parts := regexp_match(clean,'^([+-]?)([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?(?:\s*([[:alpha:]%$°].*))?$');
    if parts is null then return null; end if;
    return trim_scale((parts[1]||replace(parts[2],',','')||coalesce('.'||parts[3],''))::numeric)::text || ' ' ||
      lower(regexp_replace(trim(coalesce(parts[4],'')),'\s+',' ','g'));
  end if;
  return lower(regexp_replace(clean,'\s+',' ','g'));
exception when invalid_datetime_format or datetime_field_overflow then
  return null;
end
$$;

-- A claimed verified result must account for current eligible contradictory or qualifying
-- records in its pinned packet, even if the caller submits a different workflow disposition.
create function ai_ops.fixture_verified_claim_supported(packet jsonb,claim jsonb,atom jsonb) returns boolean
language sql immutable set search_path = '' as $$
  with observations as (
    select e->>'evidenceId' as id,e#>>'{annotation,context}' as context,
      ai_ops.fixture_comparison_value(e#>>'{annotation,value}',atom->>'type') as observed,
      ai_ops.fixture_comparison_value(atom->>'value',atom->>'type') as expected
    from jsonb_array_elements(packet->'evidence') e
    where e#>>'{annotation,kind}'='observation' and e#>>'{annotation,claimId}'=claim->>'claimId'
      and e#>>'{annotation,relevant}'='true' and e#>>'{annotation,authority}' in ('primary','credible')
      and coalesce(e#>>'{annotation,validThrough}',packet->>'asOf')>=packet->>'asOf'
      and strpos(normalize(e->>'excerpt',NFC),normalize(e#>>'{annotation,value}',NFC))>0
      and exists (select 1 from jsonb_array_elements(packet->'sources') s
        where s->>'documentId'=e->>'documentId' and s->>'origin' is not null)
  )
  select exists (select 1 from observations where observed=expected and context='full'
    and (claim#>'{supporting,evidenceIds}') ? id)
  and not exists (select 1 from observations where observed is not null
    and (observed is distinct from expected or context is distinct from 'full'))
$$;

create function ai_ops.valid_fixture_claims(packet jsonb,payload jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  atoms jsonb;
  claim jsonb;
  atom jsonb;
  observed text;
  assessment text;
begin
  if jsonb_typeof(payload->'claims') is distinct from 'array' or payload->>'verificationId' is distinct from packet->>'attemptId'
    or payload->>'asOf' is distinct from packet->>'asOf' then return false; end if;
  select coalesce(jsonb_object_agg(a->>'claimId',a),'{}') into atoms
  from jsonb_path_query(packet,'$.evidence[*].annotation ? (@.kind == "claim").atoms[*]') a;
  if jsonb_array_length(payload->'claims')<>(select count(*) from jsonb_object_keys(atoms)) or
    jsonb_array_length(payload->'claims')<>(select count(distinct item->>'claimId') from jsonb_array_elements(payload->'claims') item)
    then return false; end if;
  for claim in select value from jsonb_array_elements(payload->'claims')
  loop
    atom := atoms->(claim->>'claimId');
    if atom is null or atom->'sensitive' is distinct from claim->'sensitive'
      or atom->'material' is distinct from claim->'material' or atom->'type' is distinct from claim->'type'
      or atom->'normalizedClaim' is distinct from claim->'normalizedClaim'
      or coalesce(claim->>'verdict','') not in ('verified','mostly_accurate','partially_accurate','misleading','false','unverified')
      or coalesce(claim->>'recommendedAction','') not in ('retain','correct','update','seek_evidence','escalate')
      or jsonb_typeof(claim->'outdated') is distinct from 'boolean'
      or jsonb_typeof(claim->'evidenceIds') is distinct from 'array'
      or jsonb_array_length(claim->'evidenceIds')=0 then return false; end if;
    if exists (
      select 1 from jsonb_array_elements_text(claim->'evidenceIds') cited(id)
      where not exists (
        select 1 from jsonb_array_elements(packet->'evidence') e
        where e->>'evidenceId'=cited.id and exists (
          select 1 from jsonb_path_query(e,'$.annotation ? (@.kind == "claim").atoms[*]') a
          where a->>'claimId'=claim->>'claimId'
        )
      )
    ) or not exists (
      select 1 from jsonb_array_elements(packet->'evidence') e
      where (claim->'evidenceIds') ? (e->>'evidenceId')
        and e#>>'{annotation,originalClaim}'=claim->>'originalClaim'
    ) then return false; end if;
    foreach assessment in array array['supporting','contradictory','excluded']
    loop
      if jsonb_typeof(claim#>array[assessment,'evidenceIds']) is distinct from 'array' then return false; end if;
      for observed in select jsonb_array_elements_text(claim#>array[assessment,'evidenceIds'])
      loop
        if not exists (select 1 from jsonb_array_elements(packet->'evidence') e
          where e->>'evidenceId'=observed and e#>>'{annotation,kind}'='observation'
            and e#>>'{annotation,claimId}'=claim->>'claimId'
            and (assessment='excluded' or (e#>>'{annotation,relevant}'='true'
              and e#>>'{annotation,authority}' in ('primary','credible')
              and coalesce(e#>>'{annotation,validThrough}',packet->>'asOf')>=packet->>'asOf'
              and strpos(normalize(e->>'excerpt',NFC),normalize(e#>>'{annotation,value}',NFC))>0))
        ) then return false; end if;
      end loop;
    end loop;
    if claim->>'verdict'='verified' and (jsonb_array_length(claim#>'{supporting,evidenceIds}')=0
      or jsonb_array_length(claim#>'{contradictory,evidenceIds}')>0
      or claim->>'outdated'<>'false' or not ai_ops.fixture_verified_claim_supported(packet,claim,atom))
      then return false; end if;
  end loop;
  return true;
end
$$;

create function ai_ops.fixture_history_grounded(packet jsonb,payload jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from jsonb_each(payload) field
    cross join lateral jsonb_array_elements(case when field.key in (
      'origins','timeline','actors','rootCauses','previousResolutions','comparativeAnalysis','competingInterpretations','consequences'
    ) then field.value else '[]' end) finding
    where not exists (
      select 1 from jsonb_array_elements(packet->'evidence') e
      where finding->'evidenceIds'=jsonb_build_array(e->>'evidenceId')
        and finding-'evidenceIds'=(e->'annotation')-array['kind','category','depth']
        and array_position(array['contextual','extended','deep'],e#>>'{annotation,depth}')
          <= array_position(array['contextual','extended','deep'],packet->>'depth')
        and case field.key
          when 'origins' then e#>>'{annotation,category}'='origin'
          when 'timeline' then e#>>'{annotation,category}' in ('origin','turning_point','resolution','consequence')
          when 'actors' then e#>>'{annotation,category}'='actor'
          when 'rootCauses' then e#>>'{annotation,category}'='root_cause'
          when 'previousResolutions' then e#>>'{annotation,category}'='resolution'
          when 'comparativeAnalysis' then e#>>'{annotation,category}'='comparison'
          when 'competingInterpretations' then e#>>'{annotation,category}'='interpretation' or e#>>'{annotation,status}'='disputed'
          when 'consequences' then e#>>'{annotation,category}'='consequence'
          else false
        end
    )
  )
$$;

create function ai_ops.fixture_analysis_grounded(packet jsonb,payload jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from (values
      ('actors','actor'), ('interests','interest'), ('capabilities','capability'), ('constraints','constraint'),
      ('alliances','alliance'), ('rivalries','rivalry'), ('powerDynamics','power_dynamic'), ('competingExplanations','explanation'),
      ('implications','implication'), ('regionalImplications','implication'), ('risks','risk'), ('opportunities','opportunity'),
      ('earlyWarnings','indicator')
    ) field(key,category)
    cross join lateral jsonb_array_elements(payload->field.key) finding
    where not exists (
      select 1 from jsonb_array_elements(packet->'evidence') e
      where (finding->'evidenceIds') ? (e->>'evidenceId')
        and e#>>'{annotation,kind}'='analysis' and e#>>'{annotation,category}'=field.category
        and finding-'evidenceIds'=(e->'annotation')-array['kind','category','claimId']
        and (field.key<>'regionalImplications' or finding->>'scope'<>'global')
        and (
          (finding->>'framing'<>'established_fact' and finding->'evidenceIds'=jsonb_build_array(e->>'evidenceId'))
          or (finding->>'framing'='established_fact' and exists (
            select 1 from jsonb_array_elements(payload->'establishedFacts') f
            where f->>'claimId'=e#>>'{annotation,claimId}' and f->>'statement'=finding->>'statement'
              and finding->'evidenceIds'=jsonb_build_array(e->>'evidenceId')||(f->'evidenceIds')
          ))
        )
    )
  )
  and not exists (
    select 1 from (values ('baseline','short'),('alternative','medium'),('escalation','long')) scenario(name,default_horizon)
    cross join lateral (select payload#>array['scenarios',scenario.name] as value) proposed
    where proposed.value is null or not (
      proposed.value=jsonb_build_object('framing','conditional_forecast','horizon',scenario.default_horizon,
        'months',case scenario.default_horizon when 'short' then '[0,3]'::jsonb when 'medium' then '[3,12]'::jsonb
          else '[12,36]'::jsonb end,
        'condition',null,'outcome',null,'assumptions','[]'::jsonb,'earlyWarnings','[]'::jsonb,'evidenceIds','[]'::jsonb)
      or exists (
        select 1 from jsonb_array_elements(packet->'evidence') e
        where e#>>'{annotation,kind}'='scenario' and e#>>'{annotation,scenario}'=scenario.name
          and proposed.value=jsonb_build_object('framing','conditional_forecast','horizon',e#>>'{annotation,horizon}',
            'months',case e#>>'{annotation,horizon}' when 'short' then '[0,3]'::jsonb when 'medium' then '[3,12]'::jsonb
              else '[12,36]'::jsonb end,'condition',e#>>'{annotation,condition}','outcome',e#>>'{annotation,outcome}',
            'assumptions',jsonb_build_array(e#>>'{annotation,assumption}'),
            'earlyWarnings',jsonb_build_array(e#>>'{annotation,indicator}'),'evidenceIds',jsonb_build_array(e->>'evidenceId'))
      )
    )
  )
$$;

create function ai_ops.research_fixture_disposition(packet jsonb,payload jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  stage_name text := packet->>'stage';
  expected_keys text[];
begin
  expected_keys := array['stage','contractVersion','synthetic','eventId','attemptId','sourceRegister'] ||
    case stage_name
    when 'discovery' then array['headline','summary','locations','entities','scope','independentSourceCount','duplicateGroups',
      'classification','ranking','historicalLeads','evidenceGaps','recommendation']
    when 'history' then array['researchId','depth','overview','period','origins','timeline','actors','rootCauses','previousResolutions',
      'comparativeAnalysis','competingInterpretations','consequences','evidenceGaps','confidence']
    when 'verification' then array['verificationId','asOf','methodology','claims']
    when 'analysis' then array['analysisId','historyId','verificationId','executiveSummary','establishedFacts','historicalContext',
      'actors','interests','capabilities','constraints','alliances','rivalries','powerDynamics','competingExplanations','implications',
      'regionalImplications','risks','opportunities','earlyWarnings','assumptions','scenarios','evidenceGaps','confidence']
    end;
  if jsonb_typeof(payload) is distinct from 'object' or expected_keys is null
    or not (payload ?& expected_keys) or payload-expected_keys<>'{}'
    or payload->'synthetic' is distinct from 'true'::jsonb or payload->'contractVersion' is distinct from '1'::jsonb
    or payload->>'stage' is distinct from stage_name or payload->>'eventId' is distinct from packet->>'eventId'
    or payload->>'attemptId' is distinct from packet->>'attemptId' then return null; end if;

  if stage_name='discovery' then
    if payload->>'recommendation' is distinct from (case when packet->>'verificationAttention'='true' then 'urgent_verification'
      when packet->>'priority' in ('monitor','archive') then packet->>'priority' else 'investigate' end)
      or payload->'headline' is distinct from packet->'headline'
      or payload->'independentSourceCount' is distinct from to_jsonb(ai_ops.fixture_independent_sources(packet->'sources'))
      or payload#>'{ranking,components}' is distinct from packet->'scores'
      or payload#>>'{ranking,priority}' is distinct from packet->>'priority'
      or (payload#>>'{ranking,score}')::numeric is distinct from ai_ops.newsroom_score(packet->'scores')
      then return null; end if;
  elsif stage_name='history' then
    if payload->>'researchId' is distinct from packet->>'attemptId' or payload->'depth' is distinct from packet->'depth'
      or not ai_ops.fixture_history_grounded(packet,payload) then return null; end if;
  elsif stage_name='verification' then
    if not ai_ops.valid_fixture_claims(packet,payload) then return null; end if;
    if exists (select 1 from jsonb_array_elements(payload->'claims') c
      where c->>'recommendedAction'='escalate'
        or (c->>'sensitive'='true' and (c->>'verdict'<>'verified' or c->>'outdated'='true'))
        or (c->>'material'='true' and c->>'verdict' in ('misleading','false'))) then return 'critical'; end if;
    if not exists (select 1 from jsonb_array_elements(payload->'claims') c where c->>'material'='true')
      or exists (select 1 from jsonb_array_elements(payload->'claims') c
        where c->>'material'='true' and (c->>'verdict'<>'verified' or c->>'outdated'='true')) then return 'incomplete'; end if;
  elsif stage_name='analysis' then
    if payload->>'analysisId' is distinct from packet->>'attemptId'
      or payload->>'historyId' is distinct from packet#>>'{history,researchId}'
      or payload->>'verificationId' is distinct from packet#>>'{verification,verificationId}'
      or jsonb_typeof(payload->'establishedFacts') is distinct from 'array'
      or jsonb_typeof(payload->'actors') is distinct from 'array'
      or payload->'historicalContext' is distinct from packet#>'{history,timeline}'
      or not ai_ops.fixture_analysis_grounded(packet,payload)
      or exists (select 1 from jsonb_array_elements(payload->'establishedFacts') f where not exists (
        select 1 from jsonb_array_elements(packet#>'{verification,claims}') c
        where c->>'claimId'=f->>'claimId' and c->>'verdict'='verified' and c->>'outdated'='false'
          and c->>'normalizedClaim'=f->>'statement' and c#>'{supporting,evidenceIds}'=f->'evidenceIds'
      )) then return null; end if;
    if jsonb_array_length(payload->'actors')=0 or jsonb_array_length(payload->'historicalContext')=0
      or exists (select 1 from unnest(array['baseline','alternative','escalation']) s(name)
        where payload#>>array['scenarios',s.name,'condition'] is null) then return 'incomplete'; end if;
  end if;
  return 'complete';
exception when invalid_text_representation or invalid_parameter_value then
  return null;
end
$$;

alter function geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text) set schema ai_ops;
revoke all on function ai_ops.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text) from public,anon,authenticated,service_role;

create function geo_api.finish_newsroom_fixture(target_run uuid,target_attempt uuid,result jsonb default null,
  in_tokens integer default null,out_tokens integer default null,failure text default null,research_result jsonb default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  lease ai_ops.task_attempts%rowtype;
  packet jsonb;
  disposition text;
  outcome text;
  recommendation text;
begin
  perform ai_ops.require_newsroom();
  select * into run from ai_ops.workflow_runs where id=target_run and fixture_kind for update;
  if not found or run.fixture_state<>'active' then return 'stale'; end if;
  if not run.research_only then
    if research_result is not null then raise exception 'Research result requires a research-only run'; end if;
    return ai_ops.finish_newsroom_fixture(target_run,target_attempt,result,in_tokens,out_tokens,failure);
  end if;
  if failure is not null then
    if research_result is not null then raise exception 'A failed attempt cannot save research'; end if;
    return ai_ops.finish_newsroom_fixture(target_run,target_attempt,result,in_tokens,out_tokens,failure);
  end if;
  select a.* into lease from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id=a.task_id
    where t.workflow_id=run.id and a.id=target_attempt;
  if not found or lease.attempt_state<>'running' then return 'stale'; end if;

  packet := lease.input->'researchInput';
  disposition := ai_ops.research_fixture_disposition(packet,research_result);
  if disposition is null or not ai_ops.valid_fixture_references(run.id,packet,research_result) then
    return ai_ops.finish_newsroom_fixture(target_run,target_attempt,null,null,null,'invalid_output');
  end if;

  outcome := ai_ops.finish_newsroom_fixture(target_run,target_attempt,
    jsonb_build_object('synthetic',true,'disposition',disposition,'summary','Synthetic '||(packet->>'stage')||' finding assessed.',
      'revisionStage',null),in_tokens,out_tokens);
  if not exists (select 1 from ai_ops.task_attempts where id=target_attempt and attempt_state='succeeded') then return outcome; end if;

  insert into research.newsroom_fixture_findings(attempt_id,run_id,event_id,stage,payload)
    values(target_attempt,run.id,run.fixture_event_id,packet->>'stage',research_result);
  insert into research.newsroom_fixture_citations(attempt_id,event_id,evidence_id)
    select target_attempt,run.fixture_event_id,id::uuid from ai_ops.fixture_evidence_refs(research_result) x(id);
  insert into research.newsroom_fixture_sources(attempt_id,event_id,document_id)
    select distinct target_attempt,run.fixture_event_id,id::uuid from jsonb_array_elements_text(research_result->'sourceRegister') x(id);
  perform governance.log_event('newsroom.research_finding_saved',target_attempt,jsonb_build_object('run_id',run.id,
    'stage',packet->>'stage','disposition',disposition));

  if outcome='succeeded' then
    recommendation := research_result->>'recommendation';
    if packet->>'stage'='discovery' and recommendation in ('monitor','archive') then
      perform ai_ops.stop_fixture_run(run.id,'triaged',recommendation);
      return 'triaged';
    elsif packet->>'stage'='analysis' then
      perform ai_ops.stop_fixture_run(run.id,'research_ready','stage_5b_complete');
      return 'research_ready';
    end if;
  end if;
  return outcome;
end
$$;

create function geo_api.newsroom_research_findings(target_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.has_role('newsroom_operator') then perform app.require_human('human_editor'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('payload',f.payload,
    'sources',coalesce((select jsonb_agg(s order by s->>'documentId')
      from jsonb_array_elements(a.input#>'{researchInput,sources}') s
      join research.newsroom_fixture_sources cited on cited.attempt_id=f.attempt_id
        and cited.document_id::text=s->>'documentId'),'[]'),
    'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'documentId',e.document_id,'locator',e.locator) order by e.id)
      from research.newsroom_fixture_citations c join research.newsroom_fixture_evidence e on e.id=c.evidence_id
      where c.attempt_id=f.attempt_id),'[]')) order by f.recorded_at,f.attempt_id)
    from research.newsroom_fixture_findings f join ai_ops.task_attempts a on a.id=f.attempt_id where f.run_id=target_run),'[]');
end
$$;

revoke all on function ai_ops.research_source_documents(uuid),ai_ops.fixture_independent_sources(jsonb),ai_ops.research_fixture_input(uuid,text,uuid),
  ai_ops.fixture_evidence_refs(jsonb),ai_ops.valid_fixture_references(uuid,jsonb,jsonb),ai_ops.valid_fixture_claims(jsonb,jsonb),
  ai_ops.research_fixture_disposition(jsonb,jsonb),ai_ops.fixture_comparison_value(text,text),
  ai_ops.fixture_verified_claim_supported(jsonb,jsonb,jsonb),ai_ops.fixture_history_grounded(jsonb,jsonb),
  ai_ops.fixture_analysis_grounded(jsonb,jsonb) from public,anon,authenticated,service_role;

revoke all on function geo_api.scan_newsroom_fixtures(jsonb,boolean),geo_api.claim_newsroom_fixtures(uuid),
  geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb),geo_api.newsroom_research_findings(uuid)
  from public,anon,authenticated,service_role;
grant execute on function geo_api.scan_newsroom_fixtures(jsonb,boolean),geo_api.claim_newsroom_fixtures(uuid),
  geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb),geo_api.newsroom_research_findings(uuid) to authenticated;
