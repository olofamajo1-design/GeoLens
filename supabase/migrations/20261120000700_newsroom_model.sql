-- Stage 5A runs have no sealed article version. Legacy, version-bound runs retain their review path.
insert into app.roles(code) values ('newsroom_operator');

create table ai_ops.newsroom_policy (
  id boolean primary key default true check (id),
  critical numeric(5,2) not null default 85,
  high numeric(5,2) not null default 70,
  standard numeric(5,2) not null default 55,
  monitor numeric(5,2) not null default 40,
  high_impact numeric(5,2) not null default 75 check (high_impact between 0 and 100),
  weak_evidence numeric(5,2) not null default 50 check (weak_evidence between 0 and 100),
  model text not null default 'geolens-fixture' check (model ~ '^[A-Za-z0-9._-]{1,80}$'),
  max_input_tokens integer not null default 4096 check (max_input_tokens between 1 and 32000),
  max_output_tokens integer not null default 512 check (max_output_tokens between 1 and 4096),
  input_micros_per_token integer not null default 2 check (input_micros_per_token between 1 and 1000),
  output_micros_per_token integer not null default 8 check (output_micros_per_token between 1 and 1000),
  development_limit_minor bigint not null default 5000 check (development_limit_minor between 0 and 5000),
  launch_limit_minor bigint not null default 30000 check (launch_limit_minor between 0 and 30000),
  check (0 <= monitor and monitor < standard and standard < high and high < critical and critical <= 100)
);
insert into ai_ops.newsroom_policy default values;

create table ai_ops.newsroom_stages (
  stage text primary key,
  agent_code text not null references ai_ops.agents(code),
  timeout_seconds integer not null check (timeout_seconds in (180, 300))
);
insert into ai_ops.newsroom_stages values
  ('discovery','GL-AGENT-002',180), ('history','GL-AGENT-003',300), ('verification','GL-AGENT-004',180),
  ('analysis','GL-AGENT-005',180), ('writing','GL-AGENT-006',180), ('visual','GL-AGENT-007',300),
  ('reverification','GL-AGENT-004',180), ('editorial','GL-AGENT-008',180);

create table ai_ops.newsroom_assessments (
  event_id uuid primary key references news.events(id),
  rank_id uuid not null references news.discovery_ranks(id),
  assessed_at timestamptz not null,
  components jsonb not null,
  independent_origins integer not null,
  score numeric(5,2) not null check (score between 0 and 100),
  priority text not null check (priority in ('critical','high','standard','monitor','archive')),
  verification_attention boolean not null
);
create index newsroom_ranks_by_event on news.discovery_ranks(event_id);

alter table ai_ops.workflow_runs
  alter column version_id drop not null,
  add column fixture_event_id uuid unique references ai_ops.newsroom_assessments(event_id),
  add column fixture_story_id uuid unique references editorial.stories(id),
  add column orchestrator_prompt_id uuid references ai_ops.prompt_versions(id),
  add column fixture_state text check (fixture_state in ('active','human_review','escalated','cancelled')),
  add column state_reason text,
  add column budget_retry_at timestamptz,
  add column model text,
  add column max_input_tokens integer,
  add column max_output_tokens integer,
  add column input_micros_per_token integer,
  add column output_micros_per_token integer,
  add column fixture_kind boolean generated always as (fixture_event_id is not null) stored,
  add unique (id, fixture_kind),
  add constraint newsroom_run_kind check (
    (version_id is not null and fixture_event_id is null and fixture_story_id is null and fixture_state is null)
    or (version_id is null and fixture_event_id is not null and fixture_story_id is not null and fixture_state is not null
      and orchestrator_prompt_id is not null and model is not null and max_input_tokens > 0 and max_input_tokens is not null
      and max_output_tokens > 0 and max_output_tokens is not null and input_micros_per_token > 0
      and input_micros_per_token is not null and output_micros_per_token > 0 and output_micros_per_token is not null)
  );
create index newsroom_active_runs on ai_ops.workflow_runs(created_at) where fixture_state = 'active';

alter table ai_ops.agent_tasks
  drop constraint agent_tasks_workflow_id_agent_id_key,
  add column stage text references ai_ops.newsroom_stages(stage),
  add column round smallint not null default 0 check (round between 0 and 4),
  add column task_state text check (task_state in ('queued','active','succeeded','failed','cancelled')),
  add column available_at timestamptz,
  add column revision_attempt_id uuid,
  add column fixture_kind boolean generated always as (stage is not null) stored,
  add constraint newsroom_task_kind check (
    (stage is null and task_state is null)
    or (stage is not null and prompt_version_id is not null and task_state is not null and available_at is not null)
  ),
  add foreign key (workflow_id, fixture_kind) references ai_ops.workflow_runs(id, fixture_kind),
  add unique (id, fixture_kind),
  add unique (id, workflow_id),
  add unique (workflow_id, stage, round);
create unique index legacy_one_task_per_agent on ai_ops.agent_tasks(workflow_id, agent_id) where stage is null;

create table ai_ops.newsroom_dependencies (
  workflow_id uuid not null,
  task_id uuid not null,
  prerequisite_id uuid not null,
  primary key (task_id, prerequisite_id),
  foreign key (task_id, workflow_id) references ai_ops.agent_tasks(id, workflow_id),
  foreign key (prerequisite_id, workflow_id) references ai_ops.agent_tasks(id, workflow_id),
  check (task_id <> prerequisite_id)
);

alter table ai_ops.task_attempts
  alter column output drop not null,
  alter column finished_at drop not null,
  add column attempt_state text check (attempt_state in ('leased','running','succeeded','failed','cancelled')),
  add column lease_expires_at timestamptz,
  add column started_at timestamptz,
  add column failure_code text check (failure_code in ('invalid_input','invalid_output','provider_error','usage_limit','timeout','cancelled')),
  add column budget_month date,
  add column reserved_micros bigint check (reserved_micros > 0),
  add column fixture_kind boolean generated always as (attempt_state is not null) stored,
  add foreign key (task_id, fixture_kind) references ai_ops.agent_tasks(id, fixture_kind),
  add constraint newsroom_attempt_kind check (
    (attempt_state is null and output is not null and finished_at is not null and budget_month is null and reserved_micros is null)
    or (attempt_state is not null and synthetic and lease_expires_at is not null and budget_month is not null
      and reserved_micros is not null and ((finished_at is null) = (attempt_state in ('leased','running')))
      and ((output is not null) = (attempt_state = 'succeeded'))
      and ((failure_code is not null) = (attempt_state in ('failed','cancelled'))))
  );
alter table ai_ops.agent_tasks add foreign key (revision_attempt_id) references ai_ops.task_attempts(id);
create index newsroom_attempt_budget on ai_ops.task_attempts(budget_month) where attempt_state is not null;

alter table ai_ops.usage_events
  add column input_tokens integer check (input_tokens >= 0),
  add column output_tokens integer check (output_tokens >= 0),
  add column estimated_micros bigint check (estimated_micros >= 0),
  add constraint newsroom_fixture_usage check (
    provider_reference <> 'newsroom-fixture-v1' or (currency = 'USD' and amount_minor = 0 and estimated_micros is not null)
  );

alter table ai_ops.newsroom_policy enable row level security;
alter table ai_ops.newsroom_stages enable row level security;
alter table ai_ops.newsroom_assessments enable row level security;
alter table ai_ops.newsroom_dependencies enable row level security;
revoke all on ai_ops.newsroom_policy, ai_ops.newsroom_stages, ai_ops.newsroom_assessments,
  ai_ops.newsroom_dependencies from public, anon, authenticated, service_role;

create or replace function app.require_human(role_code text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if (auth.jwt()->>'aal') is distinct from 'aal2'
    or not app.has_role(role_code)
    or app.has_role('verification_agent') or app.has_role('ai_editor')
    or app.has_role('ingestion_operator') or app.has_role('newsroom_operator') then
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
        and (r.code <> role_code and (r.code = 'newsroom_operator' or role_code = 'newsroom_operator')
          or ((r.code in ('verification_agent', 'ai_editor', 'ingestion_operator'))
            <> (role_code in ('verification_agent', 'ai_editor', 'ingestion_operator'))))
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
