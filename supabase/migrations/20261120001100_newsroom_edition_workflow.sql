create function geo_api.queue_newsroom_edition(target_run uuid,prompt_manifest jsonb,featured_format text default 'deep_dive')
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  policy ai_ops.newsroom_policy%rowtype;
  p record;
  prompt_id uuid;
  prompts jsonb := '{}';
  sources jsonb;
  material jsonb;
  context jsonb;
  subject text;
  lead text;
  analysis_attempt uuid;
  analysis_task uuid;
  writing_task uuid;
  visual_task uuid;
  verification_task uuid;
begin
  perform ai_ops.require_newsroom();
  select * into run from ai_ops.workflow_runs where id=target_run and research_only and fixture_kind for update;
  if not found then return false; end if;
  if exists (select 1 from editorial.newsroom_edition_runs where run_id=target_run) then return false; end if;
  if run.fixture_state<>'research_ready' then return false; end if;
  if featured_format is null or featured_format not in ('quick_brief','deep_dive','historical_explainer','geopolitical_analysis',
    'investigative_report','special_feature','factcheck_report') then raise exception 'Unknown editorial format'; end if;
  if jsonb_typeof(prompt_manifest) is distinct from 'array' or jsonb_array_length(prompt_manifest)<>8 then
    raise exception 'Invalid fixture prompt manifest';
  end if;
  for p in select a.id,a.code,m.version,m.digest
    from jsonb_to_recordset(prompt_manifest) m("agentId" text,version integer,digest text)
    join ai_ops.agents a on a.code=m."agentId" where a.code in ('GL-AGENT-004','GL-AGENT-006','GL-AGENT-007','GL-AGENT-008')
    order by a.code
  loop
    if prompts ? p.code or coalesce(p.version,0)<2 or coalesce(p.digest,'') !~ '^[0-9a-f]{64}$' then
      raise exception 'Invalid editorial fixture prompt';
    end if;
    insert into ai_ops.prompt_versions(agent_id,version,digest) values(p.id,p.version,decode(p.digest,'hex')) on conflict do nothing;
    select id into prompt_id from ai_ops.prompt_versions where agent_id=p.id and version=p.version and digest=decode(p.digest,'hex');
    if not found then raise exception 'Fixture prompt version digest mismatch'; end if;
    prompts := prompts||jsonb_build_object(p.code,prompt_id);
  end loop;
  if (select count(*) from jsonb_object_keys(prompts))<>4 then raise exception 'Incomplete editorial prompt manifest'; end if;

  select f.attempt_id,a.task_id into strict analysis_attempt,analysis_task
    from research.newsroom_fixture_findings f join ai_ops.task_attempts a on a.id=f.attempt_id
    where f.run_id=run.id and f.stage='analysis' and a.attempt_state='succeeded';
  select a.input#>'{researchInput,sources}', f.payload#>>'{locations,0,name}' into strict sources,subject
    from research.newsroom_fixture_findings f join ai_ops.task_attempts a on a.id=f.attempt_id
    where f.run_id=run.id and f.stage='discovery';
  if subject is null or subject !~ '^[[:alpha:][:space:].''-]{1,45}$' then subject:='the synthetic case'; end if;
  material := editorial.fixture_material(run.id);
  select block->>'text' into lead from jsonb_array_elements(material) block
    where block->>'frame'='verified_fact' and char_length(block->>'text')<=360 limit 1;
  if lead is null then raise exception 'Editorial fixtures require verified material'; end if;
  select * into strict policy from ai_ops.newsroom_policy;
  context := jsonb_build_object(
    'researchId',analysis_attempt,'sources',sources,'sourceRegister',
      (select jsonb_agg(s->'documentId' order by s->>'documentId') from jsonb_array_elements(sources) s),
    'evidence',(
      select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'documentId',e.document_id,'locator',e.locator) order by e.id),'[]')
      from research.newsroom_fixture_evidence e where exists (
        select 1 from research.newsroom_fixture_findings r
        join research.newsroom_fixture_citations c on c.attempt_id=r.attempt_id and c.evidence_id=e.id
        where r.run_id=run.id
      )
    ),
    'independentOrigins',ai_ops.fixture_independent_sources(sources),'material',material,
    'headlines',jsonb_build_array('What the records show about '||subject,
      'Sources and context for '||subject,'How to read the evidence from '||subject),
    'standfirst',lead||' This synthetic report traces the confirmed findings, their context and the questions that remain.',
    'formats',jsonb_build_array('quick_brief','deep_dive')||
      case when featured_format in ('quick_brief','deep_dive') then '[]'::jsonb else jsonb_build_array(featured_format) end
  );
  insert into editorial.newsroom_edition_runs(run_id,context) values(run.id,context);
  update ai_ops.workflow_runs set fixture_state='active',state_reason='edition_queued',budget_retry_at=null,
    max_input_tokens=policy.editorial_input_tokens,max_output_tokens=policy.editorial_output_tokens where id=run.id;

  writing_task := ai_ops.add_fixture_task(run.id,'writing',0::smallint,(prompts->>'GL-AGENT-006')::uuid,array[analysis_task]);
  visual_task := ai_ops.add_fixture_task(run.id,'visual',0::smallint,(prompts->>'GL-AGENT-007')::uuid,array[analysis_task]);
  verification_task := ai_ops.add_fixture_task(run.id,'reverification',0::smallint,(prompts->>'GL-AGENT-004')::uuid,array[writing_task,visual_task]);
  perform ai_ops.add_fixture_task(run.id,'editorial',0::smallint,(prompts->>'GL-AGENT-008')::uuid,
    array[writing_task,visual_task,verification_task]);
  perform governance.log_event('newsroom.edition_queued',run.id,jsonb_build_object('research_attempt',analysis_attempt,'format',featured_format));
  return true;
end
$$;

create function geo_api.ready_newsroom_editions() returns uuid[]
language plpgsql security definer set search_path = '' as $$
begin
  perform ai_ops.require_newsroom();
  return array(select w.id from ai_ops.workflow_runs w join editorial.newsroom_edition_runs e on e.run_id=w.id
    where w.fixture_state='active' and (w.budget_retry_at is null or w.budget_retry_at<=clock_timestamp())
    order by e.created_at,w.id limit 50);
end
$$;

-- Keep the earlier fixture modes isolated from the explicit Stage 5C queue.
alter function geo_api.scan_newsroom_fixtures(jsonb,boolean) set schema ai_ops;
revoke all on function ai_ops.scan_newsroom_fixtures(jsonb,boolean) from public,anon,authenticated,service_role;
create function geo_api.scan_newsroom_fixtures(prompt_manifest jsonb,research_mode boolean default false) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare candidates uuid[] := ai_ops.scan_newsroom_fixtures(prompt_manifest,research_mode);
begin
  return array(select c.id from unnest(candidates) with ordinality c(id,position)
    where not exists (select 1 from editorial.newsroom_edition_runs e where e.run_id=c.id) order by c.position);
end
$$;

alter function geo_api.claim_newsroom_fixtures(uuid) rename to claim_research_fixtures;
alter function geo_api.claim_research_fixtures(uuid) set schema ai_ops;
revoke all on function ai_ops.claim_research_fixtures(uuid) from public,anon,authenticated,service_role;
create function geo_api.claim_newsroom_fixtures(target_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform ai_ops.require_newsroom();
  perform 1 from ai_ops.workflow_runs where id=target_run and fixture_kind for update;
  if exists (select 1 from editorial.newsroom_edition_runs where run_id=target_run) then
    return jsonb_build_object('state','missing','claims','[]'::jsonb);
  end if;
  return ai_ops.claim_research_fixtures(target_run);
end
$$;

alter function geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb) rename to finish_research_fixture;
alter function geo_api.finish_research_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb) set schema ai_ops;
revoke all on function ai_ops.finish_research_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb) from public,anon,authenticated,service_role;
create function geo_api.finish_newsroom_fixture(target_run uuid,target_attempt uuid,result jsonb default null,
  in_tokens integer default null,out_tokens integer default null,failure text default null,research_result jsonb default null)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform ai_ops.require_newsroom();
  perform 1 from ai_ops.workflow_runs where id=target_run and fixture_kind for update;
  if exists (select 1 from editorial.newsroom_edition_runs where run_id=target_run) then return 'stale'; end if;
  return ai_ops.finish_research_fixture(target_run,target_attempt,result,in_tokens,out_tokens,failure,research_result);
end
$$;

create function editorial.fixture_package_rights(target_run uuid,visual jsonb) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  context jsonb;
  target_event uuid;
  assets jsonb := visual->'assets';
  catalogue jsonb;
begin
  select e.context,w.fixture_event_id into strict context,target_event from editorial.newsroom_edition_runs e
    join ai_ops.workflow_runs w on w.id=e.run_id where e.run_id=target_run;
  if not ai_ops.valid_fixture_references(target_run,jsonb_build_object('eventId',target_event,
    'stage','analysis','sources',context->'sources','evidence','[]'::jsonb),
    jsonb_build_object('sourceRegister',context->'sourceRegister')) then return false; end if;

  -- Source rights are locked first. Media licences and the exact private storage
  -- objects follow in stable order so changes cannot race the review decision.
  perform 1 from media.licences l where l.id in (
    select r.licence_id from media.newsroom_fixture_visual_records r
    join jsonb_array_elements(assets) a on r.id::text=a->>'id' where r.event_id=target_event
  ) order by l.id for share of l;
  perform 1 from storage.objects o where o.bucket_id='editorial-private' and o.name in (
    select av.object_key from media.newsroom_fixture_visual_records r join media.asset_versions av on av.id=r.asset_version_id
    join jsonb_array_elements(assets) a on r.id::text=a->>'id' where r.event_id=target_event
  ) order by o.name for share of o;
  catalogue := editorial.fixture_current_visuals(target_event,target_run);
  return not exists (
    select 1 from jsonb_array_elements(assets) a where not exists (
      select 1 from jsonb_array_elements(catalogue) c
      where c->>'id'=a->>'id' and c->>'digest'=a->>'digest' and c#>>'{licence,status}'='active'
    )
  );
end
$$;

create function editorial.fixture_production_input(target_run uuid,task jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  entry editorial.newsroom_edition_runs%rowtype;
  w ai_ops.workflow_runs%rowtype;
  stage_name text := task->>'stage';
  round_number integer := (task->>'round')::integer;
  leased_task uuid := (task->>'taskId')::uuid;
  identity jsonb;
  instructions jsonb;
  article editorial.newsroom_edition_products%rowtype;
  visual editorial.newsroom_edition_products%rowtype;
  edition editorial.newsroom_edition_versions%rowtype;
  verification jsonb;
  version_digest bytea;
begin
  select * into strict entry from editorial.newsroom_edition_runs where run_id=target_run;
  select * into strict w from ai_ops.workflow_runs where id=target_run and research_only;
  identity := jsonb_build_object('contractVersion',1,'synthetic',true,'runId',w.id,'eventId',w.fixture_event_id,
    'storyId',w.fixture_story_id,'attemptId',task->'attemptId','round',round_number,'stage',stage_name);
  if stage_name in ('writing','visual') then
    select coalesce(jsonb_agg(issue->'instruction' order by issue->>'code'),'[]') into instructions
    from ai_ops.agent_tasks t join editorial.newsroom_edition_reviews r on r.attempt_id=t.revision_attempt_id
    cross join lateral jsonb_array_elements(r.payload->'issues') issue
    where t.id=leased_task and issue->>'agentId'=case stage_name when 'writing' then 'GL-AGENT-006' else 'GL-AGENT-007' end;
    if stage_name='writing' then
      return identity||(entry.context-array['sources','evidence','independentOrigins'])||jsonb_build_object('revisionInstructions',instructions);
    end if;
    return identity||jsonb_build_object('candidates',editorial.fixture_current_visuals(w.fixture_event_id,w.id),
      'revisionInstructions',instructions);
  end if;

  select p.* into strict article from ai_ops.newsroom_dependencies d
    join ai_ops.agent_tasks t on t.id=d.prerequisite_id and t.stage='writing'
    join ai_ops.task_attempts a on a.task_id=t.id and a.attempt_state='succeeded'
    join editorial.newsroom_edition_products p on p.attempt_id=a.id where d.task_id=leased_task;
  select p.* into strict visual from ai_ops.newsroom_dependencies d
    join ai_ops.agent_tasks t on t.id=d.prerequisite_id and t.stage='visual'
    join ai_ops.task_attempts a on a.task_id=t.id and a.attempt_state='succeeded'
    join editorial.newsroom_edition_products p on p.attempt_id=a.id where d.task_id=leased_task;

  if stage_name='reverification' then
    version_digest := editorial.fixture_hash(jsonb_build_object('storyId',w.fixture_story_id,'number',round_number+1,
      'article',article.payload,'visual',visual.payload,'sources',entry.context->'sources','evidence',entry.context->'evidence'));
    insert into editorial.newsroom_edition_versions(run_id,number,article_attempt,visual_attempt,digest)
      values(w.id,round_number+1,article.attempt_id,visual.attempt_id,version_digest) on conflict(run_id,number) do nothing;
    select * into strict edition from editorial.newsroom_edition_versions v where v.run_id=w.id and v.number=round_number+1
      and v.article_attempt=article.attempt_id and v.visual_attempt=visual.attempt_id and v.digest=version_digest;
    update editorial.newsroom_edition_runs set current_version_id=edition.id where run_id=w.id;
  else
    select * into strict edition from editorial.newsroom_edition_versions v where v.id=entry.current_version_id
      and v.article_attempt=article.attempt_id and v.visual_attempt=visual.attempt_id and v.number=round_number+1;
    select r.payload into strict verification from editorial.newsroom_edition_reviews r
      join ai_ops.task_attempts a on a.id=r.attempt_id
      join ai_ops.newsroom_dependencies d on d.prerequisite_id=a.task_id
      where r.version_id=edition.id and r.stage='reverification' and r.payload->>'status'='verified'
        and d.task_id=leased_task;
  end if;
  return identity||jsonb_build_object('version',jsonb_build_object('id',edition.id,'number',edition.number,'digest',encode(edition.digest,'hex')),
    'article',article.payload,'visual',visual.payload,'material',entry.context->'material','independentOrigins',entry.context->'independentOrigins',
    'rightsActive',editorial.fixture_package_rights(w.id,visual.payload))
    || case when stage_name='editorial' then jsonb_build_object('verification',verification) else '{}'::jsonb end;
end
$$;

create function geo_api.claim_newsroom_editions(target_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  batch jsonb;
  item jsonb;
  packet jsonb;
  claims jsonb := '[]';
begin
  perform ai_ops.require_newsroom();
  if not exists (select 1 from editorial.newsroom_edition_runs where run_id=target_run) then
    return jsonb_build_object('state','missing','claims','[]'::jsonb);
  end if;
  batch := ai_ops.claim_newsroom_fixtures(target_run);
  for item in select value from jsonb_array_elements(batch->'claims') loop
    packet := editorial.fixture_production_input(target_run,item->'task');
    update ai_ops.task_attempts set input=input||jsonb_build_object('productionInput',packet)
      where id=(item#>>'{task,attemptId}')::uuid;
    claims := claims||jsonb_build_array(item||jsonb_build_object('productionInput',packet));
  end loop;
  return batch||jsonb_build_object('claims',claims);
end
$$;

create function editorial.fixture_object_keys(value jsonb,keys text[]) returns boolean
language sql immutable set search_path = '' as $$
  select (jsonb_typeof(value)='object' and value ?& keys and value-keys='{}'::jsonb) is true
$$;

create function editorial.fixture_valid_writing(packet jsonb,output jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  article jsonb;
  sec jsonb;
  proposal jsonb;
  words text;
begin
  if output->'researchId' is distinct from packet->'researchId'
    or output->'sourceRegister' is distinct from packet->'sourceRegister'
    or jsonb_typeof(output->'articles') is distinct from 'array'
    or (select jsonb_agg(a.item->'format' order by a.position)
      from jsonb_array_elements(output->'articles') with ordinality a(item,position)) is distinct from packet->'formats'
    or jsonb_typeof(output->'proposedClaims') is distinct from 'array'
    or jsonb_array_length(output->'proposedClaims')>12 then return false; end if;

  for article in select value from jsonb_array_elements(output->'articles') loop
    if not editorial.fixture_object_keys(article,array['format','headlines','standfirst','sections','wordCount'])
      or article->'headlines' is distinct from packet->'headlines'
      or article->'standfirst' is distinct from packet->'standfirst'
      or jsonb_typeof(article->'sections') is distinct from 'array'
      or jsonb_array_length(article->'sections') not between 1 and 6
      or (select count(distinct s->>'kind') from jsonb_array_elements(article->'sections') s)<>jsonb_array_length(article->'sections')
      then return false; end if;
    words := article->>'standfirst';
    for sec in select value from jsonb_array_elements(article->'sections') loop
      if not editorial.fixture_object_keys(sec,array['kind','blocks'])
        or jsonb_typeof(sec->'blocks') is distinct from 'array' or jsonb_array_length(sec->'blocks') not between 1 and 150
        or exists (select 1 from jsonb_array_elements(sec->'blocks') b where b->'section' is distinct from sec->'kind'
          or not exists (select 1 from jsonb_array_elements(packet->'material') pinned where pinned=b))
        then return false; end if;
      words := words||' '||(select string_agg(b->>'text',' ' order by n)
        from jsonb_array_elements(sec->'blocks') with ordinality u(b,n));
    end loop;
    if article->'wordCount' is distinct from to_jsonb(cardinality(regexp_split_to_array(trim(words),'[[:space:]]+')))
      or exists (
        select 1 from jsonb_path_query(article,'$.sections[*].blocks[*]') b
        group by b->>'id' having count(*)>1
      ) or exists (
        select 1 from jsonb_array_elements(packet->'material') b where b->>'frame'='verified_fact' and not exists (
          select 1 from jsonb_path_query(article,'$.sections[*].blocks[*]') draft where b=draft
        )
      ) then return false; end if;
  end loop;

  for proposal in select value from jsonb_array_elements(output->'proposedClaims') loop
    if not editorial.fixture_object_keys(proposal,array['statement','evidenceIds'])
      or jsonb_typeof(proposal->'statement') is distinct from 'string' or char_length(trim(proposal->>'statement')) not between 1 and 600
      or jsonb_typeof(proposal->'evidenceIds') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(proposal->'evidenceIds') ref
        where not exists (select 1 from jsonb_path_query(packet->'material','$[*].evidenceIds[*]') known where known=ref))
    then return false; end if;
  end loop;
  return true;
end
$$;

create function editorial.fixture_eligible_visual(asset jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  data jsonb := asset->'data';
  uncertainty text := asset->>'uncertainty';
begin
  if asset#>>'{licence,status}' is distinct from 'active' then return false; end if;
  if data->>'kind'='photo' then
    return asset->>'provenance'='licensed_fixture' and data->>'disclosure'='Synthetic licensed media fixture';
  elsif data->>'kind'='illustration' then
    return asset->>'provenance'='mock_ai' and data->>'disclosure'='AI-generated synthetic illustration';
  end if;
  if asset->>'provenance' is distinct from 'research_fixture' or jsonb_array_length(asset->'evidenceIds')=0 then return false; end if;
  case data->>'kind'
  when 'map' then
    return data->>'renderer'='maplibre' and data->>'basemap'='stadia_disabled'
      and jsonb_array_length(data#>'{geojson,features}')>0 and not exists (
      select 1 from jsonb_array_elements(data#>'{geojson,features}') f
      where (f#>>'{geometry,coordinates,0}')::numeric not between -180 and 180
        or (f#>>'{geometry,coordinates,1}')::numeric not between -90 and 90
        or (f#>>'{properties,accuracy}'='approximate' and uncertainty !~* 'approximate')
        or (f#>>'{properties,boundary}'='disputed' and uncertainty !~* 'disputed')
    );
  when 'chart' then
    return data->>'scale'='linear' and data->'baseline'='0'::jsonb and jsonb_array_length(data->'values')>0
      and not exists (select 1 from jsonb_array_elements(data->'values') point where (point->>'value')::numeric<0);
  when 'timeline' then
    return jsonb_array_length(data->'entries')>0 and not exists (
      select 1 from jsonb_array_elements(data->'entries') e where (e->>'startYear')::int>(e->>'endYear')::int);
  when 'relationship' then
    return jsonb_array_length(data->'links')>0 and not exists (select 1 from jsonb_array_elements(data->'links') l
      where l->>'from'=l->>'to' or not ((data->'nodes') ? (l->>'from')) or not ((data->'nodes') ? (l->>'to')));
  when 'infographic' then
    return jsonb_array_length(data->'points')>0;
  else return false;
  end case;
end
$$;

create function editorial.fixture_visual_manifest(packet jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with assets as (
    select c.asset,c.position,editorial.fixture_eligible_visual(c.asset) is true as eligible
    from jsonb_array_elements(packet->'candidates') with ordinality c(asset,position)
  )
  select jsonb_build_object(
    'assets',coalesce(jsonb_agg(asset order by position) filter (where eligible),'[]'),
    'blockedAssetIds',coalesce(jsonb_agg(asset->'id' order by position) filter (where not eligible),'[]'),
    'layout',jsonb_build_object('responsive',true,'foreground','--ink','accent','--accent','fallback','text_and_data')
  ) from assets
$$;

create function editorial.fixture_issue(code text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('code',i.code,'severity',i.severity,'agentId',i.agent,'instruction',i.instruction)
  from (values
    ('rights','critical','GL-AGENT-007','Replace or clear each blocked asset and reconfirm the linked source and media rights.'),
    ('privacy','critical','GL-AGENT-006','Remove private contact details from the draft, captions and open claim notes.'),
    ('security','critical','GL-AGENT-008','Remove active markup and executable links from the edition before another integrity assessment.'),
    ('unverified_claim','critical','GL-AGENT-004','Verify the proposed claims against new eligible evidence before including them in an edition.'),
    ('invalid_grounding','critical','GL-AGENT-004','Reconcile the article and visual references to the verification packet for this exact version.'),
    ('missing_history','major','GL-AGENT-006','Restore the sourced historical section and keep its date uncertainty visible.'),
    ('missing_analysis','major','GL-AGENT-006','Restore the sourced analysis and clearly label at least one conditional scenario.'),
    ('missing_visuals','minor','GL-AGENT-007','Attach an eligible, accessible visual with an evidence citation and active rights.'),
    ('source_balance','critical','GL-AGENT-004','Establish an attributable independent source for the evidence before human handoff.'),
    ('below_threshold','major','GL-AGENT-006','Improve the lowest-rated writing or sourcing factor before reassessment.')
  ) i(code,severity,agent,instruction) where i.code=fixture_issue.code
$$;

create function editorial.fixture_review_payload(packet jsonb,rights_active boolean) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  unresolved jsonb;
  checked jsonb;
  critical text[] := '{}';
  issues jsonb := '[]';
  ratings jsonb;
  score numeric;
  decision text;
  code text;
  deep jsonb;
  brief jsonb;
  historical boolean;
  analysis boolean;
  length_in_range boolean;
  has_visuals boolean;
  origin_count integer := (packet->>'independentOrigins')::int;
  content text := (packet#>'{article,articles}')::text||(packet#>'{article,proposedClaims}')::text||(packet#>'{visual,assets}')::text;
begin
  select coalesce(jsonb_agg(p.item order by p.position),'[]') into unresolved
    from jsonb_array_elements(packet#>'{article,proposedClaims}') with ordinality p(item,position)
    where not exists (select 1 from jsonb_array_elements(packet->'material') m where m->>'frame'='verified_fact'
      and m->'text'=p.item->'statement' and p.item->'evidenceIds'=m->'evidenceIds');
  select coalesce(jsonb_agg(distinct c.id order by c.id),'[]') into checked
    from jsonb_array_elements(packet->'material') m cross join lateral jsonb_array_elements_text(m->'claimIds') c(id)
    where m->>'frame'='verified_fact';
  if jsonb_array_length(unresolved)>0 then critical:=array_append(critical,'unverified_claim'); end if;
  if not rights_active or jsonb_array_length(packet#>'{visual,blockedAssetIds}')>0 then
    critical:=array_append(critical,'rights');
  end if;
  if content ~* '[[:alnum:]_.+-]+@[[:alnum:]_-]+([.][[:alnum:]_-]+)+' then critical:=array_append(critical,'privacy'); end if;
  if content ~* '<[[:space:]]*(script|iframe|object|embed)\M|javascript[[:space:]]*:'
    then critical:=array_append(critical,'security'); end if;

  if packet->>'stage'='reverification' then
    return jsonb_build_object('status',case when cardinality(critical)>0 then 'hold' else 'verified' end,
      'checkedClaims',checked,'unresolved',unresolved,'critical',to_jsonb(critical));
  end if;

  if packet#>>'{verification,status}' is distinct from 'verified'
    or packet#>'{verification,version}' is distinct from packet->'version' then
    critical:=array_append(critical,'invalid_grounding');
  end if;
  foreach code in array critical loop
    issues:=issues||jsonb_build_array(editorial.fixture_issue(code));
  end loop;
  select article into deep from jsonb_array_elements(packet#>'{article,articles}') article where article->>'format'='deep_dive';
  select article into brief from jsonb_array_elements(packet#>'{article,articles}') article where article->>'format'='quick_brief';
  historical:=exists (select 1 from jsonb_path_query(deep,'$.sections[*].blocks[*]') b
    where b->>'frame' in ('documented_history','disputed_interpretation'));
  analysis:=exists (select 1 from jsonb_path_query(deep,'$.sections[*].blocks[*]') b where b->>'frame'='conditional_scenario')
    and exists (select 1 from jsonb_path_query(deep,'$.sections[*].blocks[*]') b
      where b->>'section'='analysis' and jsonb_array_length(b->'evidenceIds')>0);
  length_in_range:=(brief->>'wordCount')::int between 150 and 300 and (deep->>'wordCount')::int between 900 and 1500;
  has_visuals:=jsonb_array_length(packet#>'{visual,assets}')>0;
  if not historical then issues:=issues||jsonb_build_array(editorial.fixture_issue('missing_history')); end if;
  if not analysis then issues:=issues||jsonb_build_array(editorial.fixture_issue('missing_analysis')); end if;
  if not has_visuals then issues:=issues||jsonb_build_array(editorial.fixture_issue('missing_visuals')); end if;
  if origin_count=0 then issues:=issues||jsonb_build_array(editorial.fixture_issue('source_balance')); end if;
  ratings:=jsonb_build_object(
    'factual_accuracy_and_evidence',case when critical && array['invalid_grounding','unverified_claim'] then 0 else 100 end,
    'research_completeness_and_context',case when historical then 100 else 40 end,
    'balance_and_independence',case when origin_count>=2 then 100 when origin_count=1 then 75 else 0 end,
    'analytical_quality',case when analysis then 100 else 50 end,
    'writing_quality',case when length_in_range then 100 else 90 end,
    'source_transparency',case when jsonb_array_length(packet#>'{article,sourceRegister}')>=2 then 100 else 60 end,
    'visual_accuracy_and_quality',case when has_visuals then 100 else 60 end,
    'legal_ethical_and_safety',case when critical && array['rights','privacy','security'] then 0 else 100 end
  );
  select sum(w.weight*(ratings->>w.factor)::numeric)/100 into score from (values
    ('factual_accuracy_and_evidence',25),('research_completeness_and_context',15),('balance_and_independence',15),
    ('analytical_quality',15),('writing_quality',10),('source_transparency',10),('visual_accuracy_and_quality',5),
    ('legal_ethical_and_safety',5)
  ) w(factor,weight);
  if score<85 and jsonb_array_length(issues)=0 then issues:=jsonb_build_array(editorial.fixture_issue('below_threshold')); end if;
  decision:=case when critical && array['invalid_grounding','privacy','security'] then 'reject'
    when cardinality(critical)>0 or origin_count=0 then 'hold'
    when exists (select 1 from jsonb_array_elements(issues) i where i->>'severity'='major') then 'major_revision'
    when jsonb_array_length(issues)>0 then 'minor_revision' else 'ready_for_human_review' end;
  return jsonb_build_object('ratings',ratings,'score',score,'decision',decision,'issues',issues);
end
$$;

create function geo_api.finish_newsroom_edition(target_run uuid,target_attempt uuid,production_result jsonb default null,
  in_tokens integer default null,out_tokens integer default null,failure text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  lease ai_ops.task_attempts%rowtype;
  entry editorial.newsroom_edition_runs%rowtype;
  edition editorial.newsroom_edition_versions%rowtype;
  packet jsonb;
  stage_name text;
  identity jsonb;
  fields text[];
  expected jsonb;
  assessed jsonb;
  accepted boolean;
  disposition text := 'complete';
  responsible text;
  revision_stage text;
  outcome text;
begin
  perform ai_ops.require_newsroom();
  select * into run from ai_ops.workflow_runs where id=target_run and research_only for update;
  if not found or run.fixture_state<>'active' then return 'stale'; end if;
  select * into entry from editorial.newsroom_edition_runs where run_id=target_run;
  if not found then return 'stale'; end if;
  select a.* into lease from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id=a.task_id
    where a.id=target_attempt and t.workflow_id=run.id and t.stage in ('writing','visual','reverification','editorial');
  if not found or lease.attempt_state is distinct from 'running' then return 'stale'; end if;
  if lease.lease_expires_at<=clock_timestamp() then return ai_ops.fail_fixture_attempt(lease.id,'timeout'); end if;
  if failure is not null then
    if production_result is not null then raise exception 'A failed edition attempt cannot save output'; end if;
    return ai_ops.finish_newsroom_fixture(run.id,lease.id,null,in_tokens,out_tokens,failure);
  end if;

  packet:=lease.input->'productionInput';
  stage_name:=packet->>'stage';
  identity:=jsonb_build_object('contractVersion',1,'synthetic',true,'runId',run.id,'eventId',run.fixture_event_id,
    'storyId',run.fixture_story_id,'stage',stage_name,'attemptId',lease.id,'round',packet->'round');
  fields:=case stage_name when 'writing' then array['researchId','sourceRegister','articles','proposedClaims']
    when 'visual' then array['assets','blockedAssetIds','layout']
    when 'reverification' then array['version','status','checkedClaims','unresolved','critical']
    when 'editorial' then array['version','ratings','score','decision','issues'] end;
  if fields is null or jsonb_typeof(production_result) is distinct from 'object'
    or not (production_result ?& fields) or production_result-fields is distinct from identity then
    return ai_ops.fail_fixture_attempt(lease.id,'invalid_output');
  end if;

  begin
    if stage_name='writing' then
      accepted:=editorial.fixture_valid_writing(packet,production_result);
    elsif stage_name='visual' then
      accepted:=production_result=identity||editorial.fixture_visual_manifest(packet);
    else
      select * into edition from editorial.newsroom_edition_versions where id=entry.current_version_id and run_id=run.id;
      if not found or packet#>>'{version,id}' is distinct from edition.id::text
        or packet#>>'{version,digest}' is distinct from encode(edition.digest,'hex')
        or packet#>'{version,number}' is distinct from to_jsonb(edition.number) then return 'stale'; end if;
      expected:=editorial.fixture_review_payload(packet,(packet->>'rightsActive')::boolean);
      accepted:=production_result=identity||jsonb_build_object('version',packet->'version')||expected;
    end if;
  exception when data_exception then
    accepted:=false;
  end;
  if accepted is distinct from true then return ai_ops.fail_fixture_attempt(lease.id,'invalid_output'); end if;

  assessed:=production_result;
  if stage_name='visual' and not editorial.fixture_package_rights(run.id,production_result) then
    assessed:=production_result||jsonb_build_object('assets','[]'::jsonb,'blockedAssetIds',
      coalesce((select jsonb_agg(asset->'id' order by position)
        from jsonb_array_elements(packet->'candidates') with ordinality a(asset,position)),'[]'));
  elsif stage_name in ('reverification','editorial') then
    assessed:=identity||jsonb_build_object('version',packet->'version')||
      editorial.fixture_review_payload(packet,editorial.fixture_package_rights(run.id,packet->'visual'));
    if assessed->>'status'='hold' or assessed->>'decision' in ('hold','reject') then
      disposition:='critical';
    elsif assessed->>'decision' in ('minor_revision','major_revision') then
      disposition:='revision_requested';
      responsible:=assessed#>>'{issues,0,agentId}';
      revision_stage:=case responsible when 'GL-AGENT-006' then 'writing' when 'GL-AGENT-007' then 'visual' end;
      if revision_stage is null then disposition:='critical'; end if;
    end if;
  end if;

  outcome:=ai_ops.finish_newsroom_fixture(run.id,lease.id,jsonb_build_object('synthetic',true,
    'disposition',disposition,'summary','Private fixture '||stage_name||' assessed.','revisionStage',revision_stage),in_tokens,out_tokens);
  if not exists (select 1 from ai_ops.task_attempts where id=lease.id and attempt_state='succeeded') then return outcome; end if;
  if stage_name in ('writing','visual') then
    insert into editorial.newsroom_edition_products(attempt_id,run_id,stage,round,payload)
      values(lease.id,run.id,stage_name,(packet->>'round')::smallint,assessed);
  else
    insert into editorial.newsroom_edition_reviews(attempt_id,run_id,version_id,version_digest,stage,payload)
      values(lease.id,run.id,edition.id,edition.digest,stage_name,assessed);
    perform governance.log_event('newsroom.edition_'||stage_name,edition.id,
      jsonb_build_object('run_id',run.id,'disposition',disposition,'digest',encode(edition.digest,'hex')));
    if disposition='revision_requested' then
      update editorial.newsroom_edition_runs set current_version_id=null where run_id=run.id;
      perform governance.log_event('newsroom.edition_superseded',edition.id,
        jsonb_build_object('run_id',run.id,'revision_stage',revision_stage));
    end if;
  end if;
  return outcome;
end
$$;

-- History remains readable privately. The handoff additionally requires rights on
-- the current exact version, even when rights change after the AI recommendation.
create function geo_api.newsroom_edition(target_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  entry editorial.newsroom_edition_runs%rowtype;
  phase text;
  current_visual jsonb;
  ready boolean := false;
begin
  if not app.has_role('newsroom_operator') then perform app.require_human('human_editor'); end if;
  select * into entry from editorial.newsroom_edition_runs where run_id=target_run;
  if not found then return null; end if;
  select fixture_state into strict phase from ai_ops.workflow_runs where id=target_run;
  if phase='human_review' and entry.current_version_id is not null then
    select p.payload into strict current_visual from editorial.newsroom_edition_versions v
      join editorial.newsroom_edition_products p on p.attempt_id=v.visual_attempt where v.id=entry.current_version_id;
    ready:=editorial.fixture_package_rights(target_run,current_visual);
  end if;
  return jsonb_build_object('runId',target_run,'state',phase,'currentVersionId',entry.current_version_id,
    'readyForHumanReview',ready,'sources',entry.context->'sources','evidence',entry.context->'evidence','versions',(
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'number',v.number,'digest',encode(v.digest,'hex'),
      'article',a.payload,'visual',m.payload,'reviews',(
        select coalesce(jsonb_agg(r.payload order by r.created_at,r.attempt_id),'[]') from editorial.newsroom_edition_reviews r where r.version_id=v.id
      )) order by v.number),'[]')
    from editorial.newsroom_edition_versions v join editorial.newsroom_edition_products a on a.attempt_id=v.article_attempt
    join editorial.newsroom_edition_products m on m.attempt_id=v.visual_attempt where v.run_id=target_run
  ));
end
$$;

create trigger immutable_edition_context before update of context on editorial.newsroom_edition_runs
  for each row execute function editorial.reject_snapshot_change();

revoke all on function editorial.fixture_package_rights(uuid,jsonb),editorial.fixture_production_input(uuid,jsonb),
  editorial.fixture_object_keys(jsonb,text[]),editorial.fixture_valid_writing(jsonb,jsonb),editorial.fixture_eligible_visual(jsonb),
  editorial.fixture_visual_manifest(jsonb),editorial.fixture_issue(text),editorial.fixture_review_payload(jsonb,boolean)
  from public,anon,authenticated,service_role;

revoke all on function geo_api.queue_newsroom_edition(uuid,jsonb,text),geo_api.ready_newsroom_editions(),
  geo_api.scan_newsroom_fixtures(jsonb,boolean),geo_api.claim_newsroom_fixtures(uuid),
  geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb),geo_api.claim_newsroom_editions(uuid),
  geo_api.finish_newsroom_edition(uuid,uuid,jsonb,integer,integer,text),geo_api.newsroom_edition(uuid)
  from public,anon,authenticated,service_role;
grant execute on function geo_api.queue_newsroom_edition(uuid,jsonb,text),geo_api.ready_newsroom_editions(),
  geo_api.scan_newsroom_fixtures(jsonb,boolean),geo_api.claim_newsroom_fixtures(uuid),
  geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text,jsonb),geo_api.claim_newsroom_editions(uuid),
  geo_api.finish_newsroom_edition(uuid,uuid,jsonb,integer,integer,text),geo_api.newsroom_edition(uuid) to authenticated;
