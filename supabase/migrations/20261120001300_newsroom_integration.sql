-- The integrated fixture mode advances the existing research run into its private edition.
create function geo_api.scan_newsroom_integration(prompt_manifest jsonb) returns uuid[]
language plpgsql security definer set search_path = '' as $$
begin
  perform geo_api.scan_newsroom_fixtures(prompt_manifest,true);
  return array(
    select w.id from ai_ops.workflow_runs w join ai_ops.newsroom_assessments a on a.event_id=w.fixture_event_id
    cross join ai_ops.newsroom_policy policy
    where w.research_only and (w.fixture_state='research_ready' or
      (w.fixture_state='active' and (w.budget_retry_at is null or w.budget_retry_at<=clock_timestamp())))
    order by greatest(a.score,case when a.verification_attention then policy.high else 0 end) desc,
      a.verification_attention desc,w.created_at,w.id limit 50
  );
end
$$;

create function geo_api.claim_newsroom_integration(target_run uuid,prompt_manifest jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  discovery record;
  hold_reason text;
begin
  perform ai_ops.require_newsroom();
  select * into run from ai_ops.workflow_runs where id=target_run and research_only and fixture_kind for update;
  if not found then return jsonb_build_object('state','missing','claims','[]'::jsonb); end if;
  if run.fixture_state='research_ready' then
    select f.payload,a.input->'researchInput' as packet into discovery
    from research.newsroom_fixture_findings f join ai_ops.task_attempts a on a.id=f.attempt_id
    where f.run_id=run.id and f.stage='discovery';
    if not found or not ai_ops.valid_fixture_references(run.id,discovery.packet,discovery.payload) then
      hold_reason:='edition_source_rights';
    elsif not exists (select 1 from jsonb_array_elements(editorial.fixture_material(run.id)) m
      where m->>'frame'='verified_fact' and char_length(m->>'text')<=360) then
      hold_reason:='edition_material_missing';
    end if;
    if hold_reason is not null then
      perform ai_ops.stop_fixture_run(run.id,'escalated',hold_reason);
      return jsonb_build_object('state','escalated','claims','[]'::jsonb);
    end if;
    if not geo_api.queue_newsroom_edition(run.id,prompt_manifest) then raise exception 'Edition handoff failed'; end if;
    perform governance.log_event('newsroom.integration_advanced',run.id,jsonb_build_object('agent_id','GL-AGENT-001'));
  end if;
  if exists (select 1 from editorial.newsroom_edition_runs where run_id=run.id) then
    return geo_api.claim_newsroom_editions(run.id);
  end if;
  return geo_api.claim_newsroom_fixtures(run.id);
end
$$;

-- These decisions belong exclusively to the private synthetic edition path.
alter table editorial.newsroom_edition_reviews add unique (attempt_id,version_id);

create table editorial.newsroom_edition_human_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  version_id uuid not null,
  version_digest bytea not null,
  verification_attempt_id uuid not null,
  editorial_attempt_id uuid not null,
  reviewer_id uuid not null references auth.users(id),
  operation_id uuid not null,
  action text not null check (action in ('approve','reject','revise')),
  note text check (char_length(trim(note)) between 1 and 320),
  revision_stage text check (revision_stage in ('writing','visual')),
  revision_round smallint check (revision_round between 1 and 5),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (version_id,run_id,version_digest) references editorial.newsroom_edition_versions(id,run_id,digest),
  foreign key (verification_attempt_id,version_id) references editorial.newsroom_edition_reviews(attempt_id,version_id),
  foreign key (editorial_attempt_id,version_id) references editorial.newsroom_edition_reviews(attempt_id,version_id),
  unique (run_id,operation_id),
  check (verification_attempt_id<>editorial_attempt_id),
  check ((action='revise')=(revision_stage is not null) and (action='revise')=(revision_round is not null)),
  check (action='approve' or note is not null)
);
create unique index one_human_edition_decision on editorial.newsroom_edition_human_actions(version_id)
  where action in ('approve','reject');
create unique index one_human_edition_revision on editorial.newsroom_edition_human_actions(run_id,revision_round)
  where action='revise';
alter table editorial.newsroom_edition_human_actions enable row level security;
revoke all on editorial.newsroom_edition_human_actions from public,anon,authenticated,service_role;
create trigger immutable_edition_human_action before update or delete on editorial.newsroom_edition_human_actions
  for each row execute function editorial.reject_snapshot_change();

create function geo_api.review_newsroom_edition(target_run uuid,target_version uuid,expected_digest text,
  operation_key uuid,human_action text,note_text text default null,requested_stage text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  run ai_ops.workflow_runs%rowtype;
  edition editorial.newsroom_edition_versions%rowtype;
  saved editorial.newsroom_edition_human_actions%rowtype;
  checked uuid;
  reviewed uuid;
  visual jsonb;
  result uuid;
begin
  perform app.require_human('human_editor');
  if operation_key is null or human_action is null or human_action not in ('approve','reject','revise')
    or (human_action='revise') is distinct from (requested_stage is not null)
    or (requested_stage is not null and requested_stage not in ('writing','visual'))
    or (note_text is not null and char_length(trim(note_text)) not between 1 and 320)
    or (human_action<>'approve' and note_text is null) then raise exception 'Invalid private editorial action'; end if;

  select * into run from ai_ops.workflow_runs where id=target_run and research_only and fixture_kind for update;
  if not found then raise exception 'Private edition unavailable'; end if;
  select * into saved from editorial.newsroom_edition_human_actions
    where run_id=run.id and operation_id=operation_key;
  if found then
    if saved.version_id is distinct from target_version or encode(saved.version_digest,'hex') is distinct from expected_digest
      or saved.reviewer_id is distinct from auth.uid() or saved.action is distinct from human_action
      or saved.note is distinct from note_text or saved.revision_stage is distinct from requested_stage then
      raise exception 'Idempotency key conflicts with an earlier editorial action';
    end if;
    return saved.id;
  end if;

  select v.* into edition from editorial.newsroom_edition_runs e
    join editorial.newsroom_edition_versions v on v.id=e.current_version_id and v.run_id=e.run_id
    where e.run_id=run.id and v.id=target_version and encode(v.digest,'hex')=expected_digest;
  if not found or run.fixture_state<>'human_review' then raise exception 'Current exact private edition required'; end if;
  select attempt_id into checked from editorial.newsroom_edition_reviews r
    where r.version_id=edition.id and r.stage='reverification' and r.payload->>'status'='verified'
      and r.payload->'critical'='[]'::jsonb;
  select attempt_id into reviewed from editorial.newsroom_edition_reviews r
    where r.version_id=edition.id and r.stage='editorial' and r.payload->>'decision'='ready_for_human_review'
      and r.payload->'issues'='[]'::jsonb and (r.payload->>'score')::numeric>=85;
  if checked is null or reviewed is null then raise exception 'Both passing exact-edition reviews are required'; end if;
  if human_action='approve' then
    select payload into strict visual from editorial.newsroom_edition_products where attempt_id=edition.visual_attempt;
    if not editorial.fixture_package_rights(run.id,visual) then raise exception 'Active edition rights required'; end if;
  end if;

  insert into editorial.newsroom_edition_human_actions(run_id,version_id,version_digest,verification_attempt_id,
    editorial_attempt_id,reviewer_id,operation_id,action,note,revision_stage,revision_round)
  values (run.id,edition.id,edition.digest,checked,reviewed,auth.uid(),operation_key,human_action,note_text,
    requested_stage,case when human_action='revise' then edition.number end)
  returning id into result;
  perform governance.log_event('newsroom.edition_human_'||human_action,result,jsonb_build_object(
    'run_id',run.id,'version_id',edition.id,'digest',expected_digest,'verification_attempt',checked,'editorial_attempt',reviewed));

  if human_action='revise' then
    update editorial.newsroom_edition_runs set current_version_id=null where run_id=run.id;
    update ai_ops.workflow_runs set fixture_state='active',state_reason='human_revision_requested' where id=run.id;
    perform ai_ops.revise_fixture_run(run.id,requested_stage,edition.number::smallint,null);
    perform governance.log_event('newsroom.edition_superseded',edition.id,
      jsonb_build_object('run_id',run.id,'revision_stage',requested_stage,'human_action_id',result));
  end if;
  return result;
end
$$;

-- Human returns pass through the same revision graph and contract as automated returns.
alter function editorial.fixture_production_input(uuid,jsonb) rename to fixture_production_input_v2;
create function editorial.fixture_production_input(target_run uuid,task jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  packet jsonb := editorial.fixture_production_input_v2(target_run,task);
  correction text;
begin
  if task->>'stage' in ('writing','visual') then
    select h.note into correction from editorial.newsroom_edition_human_actions h
    where h.run_id=target_run and h.revision_stage=task->>'stage' and h.revision_round=(task->>'round')::smallint;
    if found then
      return jsonb_set(packet,'{revisionInstructions}',(packet->'revisionInstructions')||jsonb_build_array(correction));
    end if;
  end if;
  return packet;
end
$$;

alter function geo_api.newsroom_edition(uuid) set schema editorial;
alter function editorial.newsroom_edition(uuid) rename to newsroom_edition_snapshot;
create function geo_api.newsroom_edition(target_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  snapshot jsonb;
  history jsonb;
  current_decision text;
  ready boolean;
begin
  if not app.has_role('newsroom_operator') then perform app.require_human('human_editor'); end if;
  perform 1 from ai_ops.workflow_runs where id=target_run and fixture_kind for share;
  snapshot:=editorial.newsroom_edition_snapshot(target_run);
  if snapshot is null then return null; end if;
  ready:=(snapshot->>'readyForHumanReview')::boolean;
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'action',h.action,'versionId',h.version_id,
    'digest',encode(h.version_digest,'hex'),'reviewerId',h.reviewer_id,'createdAt',h.created_at,
    'note',h.note,'revisionStage',h.revision_stage,'verificationAttemptId',h.verification_attempt_id,
    'editorialAttemptId',h.editorial_attempt_id) order by h.created_at,h.id),'[]') into history
  from editorial.newsroom_edition_human_actions h where h.run_id=target_run;
  select h.action into current_decision from editorial.newsroom_edition_human_actions h
    where h.version_id=(snapshot->>'currentVersionId')::uuid and h.action in ('approve','reject');
  return snapshot||jsonb_build_object('humanActions',history,'currentDecision',current_decision,
    'approvalCurrent',ready and current_decision is not distinct from 'approve',
    'readyForHumanReview',ready and current_decision is null);
end
$$;

create or replace function geo_api.newsroom_fixture_review_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_human('human_editor');
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id) from (
    select w.id,w.fixture_event_id as event_id,w.fixture_state as state,w.state_reason as reason,w.created_at,true as synthetic
    from ai_ops.workflow_runs w where w.fixture_state in ('human_review','escalated') and not exists (
      select 1 from editorial.newsroom_edition_runs e join editorial.newsroom_edition_human_actions h on h.version_id=e.current_version_id
      where w.fixture_state='human_review' and e.run_id=w.id and h.action in ('approve','reject')
    )
    order by w.created_at desc,w.id limit 50
  ) q),'[]');
end
$$;

revoke all on function editorial.newsroom_edition_snapshot(uuid),editorial.fixture_production_input(uuid,jsonb),
  geo_api.scan_newsroom_integration(jsonb),geo_api.claim_newsroom_integration(uuid,jsonb),
  geo_api.review_newsroom_edition(uuid,uuid,text,uuid,text,text,text),geo_api.newsroom_edition(uuid)
  from public,anon,authenticated,service_role;
grant execute on function geo_api.scan_newsroom_integration(jsonb),geo_api.claim_newsroom_integration(uuid,jsonb),
  geo_api.review_newsroom_edition(uuid,uuid,text,uuid,text,text,text),geo_api.newsroom_edition(uuid) to authenticated;
