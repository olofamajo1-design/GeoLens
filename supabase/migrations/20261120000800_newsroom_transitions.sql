create function ai_ops.require_newsroom() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not app.has_role('newsroom_operator') then
    raise exception 'Newsroom operator role required' using errcode = '42501';
  end if;
end
$$;

create function ai_ops.newsroom_score(components jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  dimension text;
begin
  foreach dimension in array array['impact','evidence','urgency','regional','historical']
  loop
    if jsonb_typeof(components->dimension) is distinct from 'number' then return null; end if;
    if (components->>dimension)::numeric not between 0 and 100 then return null; end if;
  end loop;
  return round(((components->>'impact')::numeric * 30 + (components->>'evidence')::numeric * 25
    + (components->>'urgency')::numeric * 20 + (components->>'regional')::numeric * 15
    + (components->>'historical')::numeric * 10) / 100, 2);
end
$$;

create function ai_ops.add_fixture_task(
  run_id uuid, stage_name text, task_round smallint, prompt_id uuid, prerequisites uuid[], revision_id uuid default null
) returns uuid
language plpgsql set search_path = '' as $$
declare
  task_id uuid;
begin
  insert into ai_ops.agent_tasks(workflow_id,agent_id,prompt_version_id,stage,round,task_state,available_at,revision_attempt_id)
    select run_id,a.id,prompt_id,s.stage,task_round,'queued',clock_timestamp(),revision_id
    from ai_ops.newsroom_stages s join ai_ops.agents a on a.code=s.agent_code where s.stage=stage_name
    returning id into strict task_id;
  insert into ai_ops.newsroom_dependencies(workflow_id,task_id,prerequisite_id)
    select run_id,task_id,dependency from unnest(prerequisites) as dependency;
  return task_id;
end
$$;

create function ai_ops.seed_fixture_tasks(run_id uuid, prompts jsonb) returns void
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
  loop
    tasks := tasks || jsonb_build_object(stage_row.stage, ai_ops.add_fixture_task(run_id,stage_row.stage,0::smallint,
      (prompts->>(select agent_code from ai_ops.newsroom_stages where stage=stage_row.stage))::uuid,
      array(select (tasks->>dependency)::uuid from unnest(stage_row.prerequisites) as dependency)));
  end loop;
end
$$;

-- This intake path can see ranked, completed fixture discovery. Live pilot events never enter it.
create function geo_api.scan_newsroom_fixtures(prompt_manifest jsonb) returns uuid[]
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
    if prompts ? prompt_row.code or coalesce(prompt_row.version,0) < 1
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
        or previous.independent_origins is distinct from latest.independent_origins)
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
    if (priority in ('critical','high','standard') or attention)
      and not exists (select 1 from ai_ops.workflow_runs where fixture_event_id=event_row.event_id) then
      insert into editorial.stories(slug,synthetic) values ('newsroom-fixture-' || event_row.event_id,true)
        returning id into story_id;
      insert into ai_ops.workflow_runs(request_key,fixture_event_id,fixture_story_id,orchestrator_prompt_id,
        fixture_state,model,max_input_tokens,max_output_tokens,input_micros_per_token,output_micros_per_token)
        values ('newsroom-fixture:' || event_row.event_id,event_row.event_id,story_id,(prompts->>'GL-AGENT-001')::uuid,
          'active',policy.model,policy.max_input_tokens,policy.max_output_tokens,policy.input_micros_per_token,policy.output_micros_per_token)
        returning id into run_id;
      perform ai_ops.seed_fixture_tasks(run_id,prompts);
      perform governance.log_event('newsroom.fixture_queued',run_id,jsonb_build_object('event_id',event_row.event_id,
        'rank_id',event_row.rank_id,'priority',priority,'verification_attention',attention));
    end if;
  end loop;
  return array(
    select w.id from ai_ops.workflow_runs w join ai_ops.newsroom_assessments a on a.event_id=w.fixture_event_id
    where w.fixture_state='active' and (w.budget_retry_at is null or w.budget_retry_at <= instant)
    order by greatest(a.score,case when a.verification_attention then policy.high else 0 end) desc,
      a.verification_attention desc, w.created_at, w.id limit 50
  );
end
$$;

-- Every terminal attempt gets one usage observation. A started failure conservatively retains
-- its simulated maximum even when the mock produced no usage data.
create function ai_ops.settle_fixture_attempt(
  target_attempt uuid, next_state text, failure text, result jsonb, in_tokens integer, out_tokens integer
) returns void
language plpgsql set search_path = '' as $$
declare
  saved ai_ops.task_attempts%rowtype;
begin
  update ai_ops.task_attempts set attempt_state=next_state, failure_code=failure, output=result, finished_at=clock_timestamp()
    where id=target_attempt and attempt_state in ('leased','running') returning * into strict saved;
  insert into ai_ops.usage_events(attempt_id,provider_reference,amount_minor,currency,input_tokens,output_tokens,estimated_micros)
    select saved.id,'newsroom-fixture-v1',0,'USD',in_tokens,out_tokens,
      case when next_state='succeeded' then in_tokens::bigint*w.input_micros_per_token + out_tokens::bigint*w.output_micros_per_token
        when saved.started_at is not null then saved.reserved_micros else 0 end
    from ai_ops.agent_tasks t join ai_ops.workflow_runs w on w.id=t.workflow_id where t.id=saved.task_id;
  perform governance.log_event('newsroom.attempt_' || next_state, saved.id,
    jsonb_build_object('task_id',saved.task_id,'attempt',saved.attempt,'failure_code',failure));
end
$$;

create function ai_ops.stop_fixture_run(target_run uuid, next_state text, reason text) returns void
language plpgsql set search_path = '' as $$
declare
  attempt_id uuid;
begin
  for attempt_id in
    select a.id from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id=a.task_id
    where t.workflow_id=target_run and a.attempt_state in ('leased','running') order by a.id
  loop
    perform ai_ops.settle_fixture_attempt(attempt_id,'cancelled','cancelled',null,null,null);
  end loop;
  update ai_ops.agent_tasks set task_state='cancelled' where workflow_id=target_run and task_state in ('queued','active');
  update ai_ops.workflow_runs set fixture_state=next_state,state_reason=reason,budget_retry_at=null where id=target_run;
  perform governance.log_event('newsroom.fixture_' || next_state,target_run,jsonb_build_object('reason',reason));
end
$$;

create function ai_ops.fail_fixture_attempt(target_attempt uuid, failure text) returns text
language plpgsql set search_path = '' as $$
declare
  lease ai_ops.task_attempts%rowtype;
  run_id uuid;
begin
  select * into strict lease from ai_ops.task_attempts where id=target_attempt;
  perform ai_ops.settle_fixture_attempt(target_attempt,'failed',failure,null,null,null);
  if lease.attempt = 3 then
    update ai_ops.agent_tasks set task_state='failed' where id=lease.task_id returning workflow_id into run_id;
    perform ai_ops.stop_fixture_run(run_id,'escalated','attempts_exhausted:' || failure);
    return 'escalated';
  end if;
  update ai_ops.agent_tasks set task_state='queued',
    available_at=clock_timestamp() + case when lease.attempt=1 then interval '5 seconds' else interval '30 seconds' end
    where id=lease.task_id;
  return 'retry';
end
$$;

create function ai_ops.newsroom_reserved_cost(usage_month date) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(coalesce(u.estimated_micros,a.reserved_micros)),0)
    from ai_ops.task_attempts a left join ai_ops.usage_events u
      on u.attempt_id=a.id and u.provider_reference='newsroom-fixture-v1'
    where a.budget_month=usage_month and a.attempt_state is not null
$$;

-- A fixture run has a unique story. Its row lock serializes claims, settlements, revisions and cancellation
-- for that story. The UTC discovery ledger row serializes new budget admissions across different stories.
create function geo_api.claim_newsroom_fixtures(target_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  item record;
  expired uuid;
  window_start date;
  instant timestamptz;
  wake_at timestamptz;
  slots integer;
  observed_minor bigint;
  cap_micros bigint;
  reserved numeric;
  reservation bigint;
  lease_id uuid;
  lease_until timestamptz;
  ordinal smallint;
  task_input jsonb;
  claims jsonb := '[]';
begin
  perform ai_ops.require_newsroom();
  select * into run from ai_ops.workflow_runs where id=target_run and fixture_event_id is not null for update;
  if not found then return jsonb_build_object('state','missing','claims',claims); end if;
  if run.fixture_state <> 'active' then return jsonb_build_object('state',run.fixture_state,'claims',claims); end if;
  instant := clock_timestamp();

  for expired in
    select a.id from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id=a.task_id
    where t.workflow_id=run.id and a.attempt_state in ('leased','running') and a.lease_expires_at<=instant
    order by a.lease_expires_at,a.id
  loop
    if ai_ops.fail_fixture_attempt(expired,'timeout')='escalated' then
      return jsonb_build_object('state','escalated','claims',claims);
    end if;
  end loop;

  select 3-count(*) into slots from ai_ops.agent_tasks where workflow_id=run.id and task_state='active';
  for item in
    select t.*,p.version as prompt_version,encode(p.digest,'hex') as prompt_digest,s.timeout_seconds,s.agent_code
    from ai_ops.agent_tasks t join ai_ops.prompt_versions p on p.id=t.prompt_version_id
    join ai_ops.newsroom_stages s on s.stage=t.stage
    where t.workflow_id=run.id and t.task_state='queued' and t.available_at<=instant
      and not exists (select 1 from ai_ops.newsroom_dependencies d join ai_ops.agent_tasks required on required.id=d.prerequisite_id
        where d.task_id=t.id and required.task_state <> 'succeeded')
    order by t.available_at,t.stage,t.id limit slots
  loop
    if run.budget_retry_at > instant then exit; end if;
    if jsonb_array_length(claims)=0 then
      window_start := date_trunc('month',clock_timestamp() at time zone 'UTC')::date;
      insert into ai_ops.discovery_usage(month,scope) values (window_start,'development') on conflict do nothing;
      select amount_minor into strict observed_minor from ai_ops.discovery_usage
        where month=window_start and scope='development' for update;
      select development_limit_minor*10000 into strict cap_micros from ai_ops.newsroom_policy;
      select observed_minor::numeric*10000 + ai_ops.newsroom_reserved_cost(window_start) into reserved;
      reservation := run.max_input_tokens::bigint*run.input_micros_per_token + run.max_output_tokens::bigint*run.output_micros_per_token;
    end if;
    if reserved+reservation > cap_micros then
      update ai_ops.workflow_runs set budget_retry_at=clock_timestamp()+interval '15 minutes',
        state_reason='budget_blocked' where id=run.id returning budget_retry_at into run.budget_retry_at;
      if run.state_reason is distinct from 'budget_blocked' then
        perform governance.log_event('newsroom.budget_blocked',run.id,jsonb_build_object('month',window_start,'limit_micros',cap_micros));
      end if;
      exit;
    end if;

    select count(*)+1 into ordinal from ai_ops.task_attempts where task_id=item.id;
    lease_id := gen_random_uuid();
    lease_until := clock_timestamp()+make_interval(secs=>item.timeout_seconds);
    select jsonb_build_object(
      'contractVersion',1,'synthetic',true,'runId',run.id,'eventId',run.fixture_event_id,'taskId',item.id,'attemptId',lease_id,
      'stage',item.stage,'agentId',item.agent_code,'round',item.round,'attempt',ordinal,
      'verificationAttention',a.verification_attention,
      'revisionRequest',(select output from ai_ops.task_attempts where id=item.revision_attempt_id),
      'dependencies',coalesce((select jsonb_agg(jsonb_build_object('taskId',required.id,'stage',required.stage,'result',finished.output)
        order by required.stage) from ai_ops.newsroom_dependencies d
        join ai_ops.agent_tasks required on required.id=d.prerequisite_id
        join ai_ops.task_attempts finished on finished.task_id=required.id and finished.attempt_state='succeeded'
        where d.task_id=item.id),'[]'))
      into strict task_input from ai_ops.newsroom_assessments a where a.event_id=run.fixture_event_id;

    insert into ai_ops.task_attempts(id,task_id,attempt,contract_version,input,synthetic,finished_at,
      attempt_state,lease_expires_at,budget_month,reserved_micros)
      values(lease_id,item.id,ordinal,1,task_input,true,null,'leased',lease_until,window_start,reservation);
    update ai_ops.agent_tasks set task_state='active' where id=item.id;
    update ai_ops.workflow_runs set budget_retry_at=null,state_reason=null where id=run.id and state_reason='budget_blocked';
    claims := claims || jsonb_build_array(jsonb_build_object('task',task_input,'leaseExpiresAt',lease_until,
      'promptVersion',item.prompt_version,'promptDigest',item.prompt_digest,'model',run.model,
      'maxInputTokens',run.max_input_tokens,'maxOutputTokens',run.max_output_tokens));
    reserved := reserved + reservation;
    perform governance.log_event('newsroom.attempt_leased',lease_id,jsonb_build_object('task_id',item.id,
      'attempt',ordinal,'stage',item.stage,'reserved_micros',reservation));
  end loop;
  if jsonb_array_length(claims)>0 then return jsonb_build_object('state','active','claims',claims); end if;

  select min(next_time) into wake_at from (
    select a.lease_expires_at as next_time from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id=a.task_id
      where t.workflow_id=run.id and a.attempt_state in ('leased','running')
    union all
    select greatest(t.available_at,run.budget_retry_at) from ai_ops.agent_tasks t where slots>0 and workflow_id=run.id and task_state='queued'
      and not exists (select 1 from ai_ops.newsroom_dependencies d join ai_ops.agent_tasks required on required.id=d.prerequisite_id
        where d.task_id=t.id and required.task_state <> 'succeeded')
    union all select run.budget_retry_at where run.budget_retry_at > instant
  ) as next_task;
  if wake_at is null then
    perform ai_ops.stop_fixture_run(run.id,'escalated','dependency_stalled');
    return jsonb_build_object('state','escalated','claims',claims);
  end if;
  return jsonb_build_object('state','active','claims',claims,'wakeAt',wake_at,'budgetBlocked',run.budget_retry_at > instant);
end
$$;

create function geo_api.start_newsroom_fixture(target_run uuid, target_attempt uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform ai_ops.require_newsroom();
  perform 1 from ai_ops.workflow_runs where id=target_run and fixture_state='active' for update;
  if not found then return false; end if;
  update ai_ops.task_attempts a set attempt_state='running',started_at=clock_timestamp()
    from ai_ops.agent_tasks t where a.task_id=t.id and t.workflow_id=target_run and a.id=target_attempt
      and a.attempt_state='leased' and a.lease_expires_at>clock_timestamp();
  if not found then return false; end if;
  perform governance.log_event('newsroom.attempt_started',target_attempt,jsonb_build_object('run_id',target_run));
  return true;
end
$$;

create function ai_ops.valid_fixture_output(result jsonb, stage_name text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(result) is distinct from 'object' then return false; end if;
  return (select count(*) from jsonb_object_keys(result))=4
    and result ?& array['synthetic','disposition','summary','revisionStage']
    and result->'synthetic'='true'::jsonb
    and jsonb_typeof(result->'summary')='string' and char_length(result->>'summary') between 1 and 250
    and ((result->>'disposition' in ('complete','critical','incomplete') and result->'revisionStage'='null'::jsonb)
      or (stage_name='editorial' and result->>'disposition'='revision_requested'
        and result->>'revisionStage' in ('writing','visual'))) is true;
end
$$;

create function ai_ops.revise_fixture_run(
  target_run uuid, revision_stage text, next_round smallint, revision_id uuid
) returns text
language plpgsql set search_path = '' as $$
declare
  previous_task ai_ops.agent_tasks%rowtype;
  work_id uuid;
  analysis_id uuid;
  other_id uuid;
  verify_id uuid;
  verify_prompt uuid;
  editorial_prompt uuid;
begin
  if (select count(*) from ai_ops.agent_tasks where workflow_id=target_run and stage=revision_stage) >= 3 then
    perform ai_ops.stop_fixture_run(target_run,'escalated','revision_limit:' || revision_stage);
    return 'escalated';
  end if;
  select * into strict previous_task from ai_ops.agent_tasks where workflow_id=target_run and stage=revision_stage
    order by round desc limit 1;
  select id into strict analysis_id from ai_ops.agent_tasks where workflow_id=target_run and stage='analysis';
  select id into strict other_id from ai_ops.agent_tasks where workflow_id=target_run
    and stage=case revision_stage when 'writing' then 'visual' else 'writing' end order by round desc limit 1;
  select prompt_version_id into strict verify_prompt from ai_ops.agent_tasks
    where workflow_id=target_run and stage='reverification' and round=0;
  select prompt_version_id into strict editorial_prompt from ai_ops.agent_tasks
    where workflow_id=target_run and stage='editorial' and round=0;
  work_id := ai_ops.add_fixture_task(target_run,revision_stage,next_round,previous_task.prompt_version_id,
    array[analysis_id,previous_task.id],revision_id);
  verify_id := ai_ops.add_fixture_task(target_run,'reverification',next_round,verify_prompt,array[work_id,other_id]);
  perform ai_ops.add_fixture_task(target_run,'editorial',next_round,editorial_prompt,array[work_id,other_id,verify_id]);
  perform governance.log_event('newsroom.revision_queued',target_run,
    jsonb_build_object('stage',revision_stage,'round',next_round,'request_attempt',revision_id));
  return 'revision_queued';
end
$$;

create function geo_api.finish_newsroom_fixture(
  target_run uuid, target_attempt uuid, result jsonb default null, in_tokens integer default null,
  out_tokens integer default null, failure text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  lease record;
  disposition text;
begin
  perform ai_ops.require_newsroom();
  select * into run from ai_ops.workflow_runs where id=target_run and fixture_event_id is not null for update;
  if not found or run.fixture_state <> 'active' then return 'stale'; end if;
  select a.id,a.task_id,a.attempt_state,a.lease_expires_at,t.stage,t.round into lease
    from ai_ops.task_attempts a join ai_ops.agent_tasks t on a.task_id=t.id where t.workflow_id=run.id and a.id=target_attempt;
  if not found or lease.attempt_state is distinct from 'running' then return 'stale'; end if;
  if lease.lease_expires_at<=clock_timestamp() then return ai_ops.fail_fixture_attempt(lease.id,'timeout'); end if;
  if failure is not null then
    if failure not in ('invalid_input','invalid_output','provider_error','usage_limit','timeout')
      or result is not null or in_tokens is not null or out_tokens is not null then raise exception 'Invalid fixture failure'; end if;
    return ai_ops.fail_fixture_attempt(lease.id,failure);
  end if;
  if not ai_ops.valid_fixture_output(result,lease.stage) then return ai_ops.fail_fixture_attempt(lease.id,'invalid_output'); end if;
  if in_tokens is null or out_tokens is null or in_tokens not between 0 and run.max_input_tokens
    or out_tokens not between 0 and run.max_output_tokens then return ai_ops.fail_fixture_attempt(lease.id,'usage_limit'); end if;

  perform ai_ops.settle_fixture_attempt(lease.id,'succeeded',null,result,in_tokens,out_tokens);
  disposition := result->>'disposition';
  if disposition in ('critical','incomplete') then
    update ai_ops.agent_tasks set task_state='failed' where id=lease.task_id;
    perform ai_ops.stop_fixture_run(run.id,'escalated',disposition || '_finding:' || lease.stage);
    return 'escalated';
  end if;
  update ai_ops.agent_tasks set task_state='succeeded' where id=lease.task_id;
  if disposition='revision_requested' then
    return ai_ops.revise_fixture_run(run.id,result->>'revisionStage',(lease.round+1)::smallint,lease.id);
  end if;
  if lease.stage='editorial' then
    update ai_ops.workflow_runs set fixture_state='human_review',state_reason='fixture_complete',budget_retry_at=null where id=run.id;
    perform governance.log_event('newsroom.human_review_requested',run.id,jsonb_build_object('synthetic',true,'attempt_id',lease.id));
    return 'human_review';
  end if;
  return 'succeeded';
end
$$;

create function geo_api.cancel_newsroom_fixture(target_run uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role('newsroom_operator') then perform app.require_human('human_editor'); end if;
  perform 1 from ai_ops.workflow_runs where id=target_run and fixture_state='active' for update;
  if not found then return false; end if;
  perform ai_ops.stop_fixture_run(target_run,'cancelled','operator_cancelled');
  return true;
end
$$;

create function geo_api.newsroom_fixture_status(target_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.has_role('newsroom_operator') then perform app.require_human('human_editor'); end if;
  return (
    select jsonb_build_object('state',w.fixture_state,'reason',w.state_reason,'synthetic',true,
      'priority',a.priority,'score',a.score,'verificationAttention',a.verification_attention,
      'tasks',coalesce((select jsonb_agg(jsonb_build_object('stage',t.stage,'round',t.round,'state',t.task_state,
        'agentId',ag.code,'attempts',coalesce((select jsonb_agg(jsonb_build_object('attempt',b.attempt,
          'state',b.attempt_state,'failure',b.failure_code,'reservedMicros',b.reserved_micros,
          'estimatedMicros',u.estimated_micros,'actualMinor',u.amount_minor,'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,
          'elapsedMs',extract(epoch from (b.finished_at-b.started_at))*1000) order by b.attempt)
          from ai_ops.task_attempts b left join ai_ops.usage_events u
            on u.attempt_id=b.id and u.provider_reference='newsroom-fixture-v1' where b.task_id=t.id),'[]')) order by t.round,t.stage)
        from ai_ops.agent_tasks t join ai_ops.agents ag on ag.id=t.agent_id where t.workflow_id=w.id),'[]'))
    from ai_ops.workflow_runs w join ai_ops.newsroom_assessments a on a.event_id=w.fixture_event_id where w.id=target_run
  );
end
$$;

create function geo_api.newsroom_fixture_review_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_human('human_editor');
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id) from (
    select w.id,w.fixture_event_id as event_id,w.fixture_state as state,w.state_reason as reason,w.created_at,true as synthetic
    from ai_ops.workflow_runs w where w.fixture_state in ('human_review','escalated')
    order by w.created_at desc,w.id limit 50
  ) q),'[]');
end
$$;

create function geo_api.newsroom_fixture_budget() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  usage_month date := date_trunc('month',now() at time zone 'UTC')::date;
  policy ai_ops.newsroom_policy%rowtype;
  development_micros numeric;
  launch_micros numeric;
begin
  if not app.has_role('newsroom_operator') then perform app.require_human('super_admin'); end if;
  select * into strict policy from ai_ops.newsroom_policy;
  development_micros := coalesce((select amount_minor::numeric*10000 from ai_ops.discovery_usage
    where month=usage_month and scope='development'),0)+ai_ops.newsroom_reserved_cost(usage_month);
  launch_micros := coalesce((select amount_minor::numeric*10000 from ai_ops.discovery_usage
    where month=usage_month and scope='launch'),0);
  return jsonb_build_object('month',usage_month,'synthetic',true,'currency','USD',
    'developmentMicros',development_micros,'developmentLimitMinor',policy.development_limit_minor,
    'launchMicros',launch_micros,'launchLimitMinor',policy.launch_limit_minor,'fixtureActualMinor',0);
end
$$;

revoke all on function ai_ops.require_newsroom(), ai_ops.newsroom_score(jsonb),
  ai_ops.add_fixture_task(uuid,text,smallint,uuid,uuid[],uuid), ai_ops.seed_fixture_tasks(uuid,jsonb),
  ai_ops.settle_fixture_attempt(uuid,text,text,jsonb,integer,integer), ai_ops.stop_fixture_run(uuid,text,text),
  ai_ops.fail_fixture_attempt(uuid,text), ai_ops.newsroom_reserved_cost(date), ai_ops.valid_fixture_output(jsonb,text),
  ai_ops.revise_fixture_run(uuid,text,smallint,uuid) from public,anon,authenticated,service_role;

revoke all on function geo_api.scan_newsroom_fixtures(jsonb), geo_api.claim_newsroom_fixtures(uuid),
  geo_api.start_newsroom_fixture(uuid,uuid), geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text),
  geo_api.cancel_newsroom_fixture(uuid), geo_api.newsroom_fixture_status(uuid), geo_api.newsroom_fixture_review_queue(),
  geo_api.newsroom_fixture_budget() from public,anon,authenticated,service_role;
grant execute on function geo_api.scan_newsroom_fixtures(jsonb), geo_api.claim_newsroom_fixtures(uuid),
  geo_api.start_newsroom_fixture(uuid,uuid), geo_api.finish_newsroom_fixture(uuid,uuid,jsonb,integer,integer,text),
  geo_api.cancel_newsroom_fixture(uuid), geo_api.newsroom_fixture_status(uuid), geo_api.newsroom_fixture_review_queue(),
  geo_api.newsroom_fixture_budget() to authenticated;
