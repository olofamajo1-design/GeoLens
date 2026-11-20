create schema app;
create schema news;
create schema research;
create schema editorial;
create schema ai_ops;
create schema media;
create schema forecasting;
create schema community;
create schema billing;
create schema governance;
create schema geo_api;

create extension if not exists pgcrypto with schema extensions;

revoke all on schema app, news, research, editorial, ai_ops, media, forecasting,
  community, billing, governance, geo_api from public, anon, authenticated, service_role;
grant usage on schema geo_api to anon, authenticated;

create table app.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 120),
  created_at timestamptz not null default now()
);
create table app.preferences (
  user_id uuid primary key references app.profiles(id) on delete cascade,
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);
create table app.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique
);
insert into app.roles (code) values
  ('super_admin'), ('human_editor'), ('human_publisher'), ('verification_agent'), ('ai_editor');

create table app.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  role_id uuid not null references app.roles(id),
  granted_by uuid references auth.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= granted_at)
);
create unique index active_user_role on app.user_roles(user_id, role_id) where revoked_at is null;
create index active_role_members on app.user_roles(role_id, user_id) where revoked_at is null;

create table governance.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete restrict,
  action text not null,
  target_id uuid not null,
  details jsonb not null default '{}',
  occurred_at timestamptz not null default clock_timestamp()
);
create index audit_target_history on governance.audit_events(target_id, occurred_at);

create function app.has_role(role_code text) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from app.user_roles ur join app.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.code = role_code and ur.revoked_at is null
  )
$$;

create function app.require_human(role_code text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if (auth.jwt()->>'aal') is distinct from 'aal2'
    or not app.has_role(role_code)
    or app.has_role('verification_agent') or app.has_role('ai_editor') then
    raise exception 'Privileged human session required' using errcode = '42501';
  end if;
end
$$;

create function governance.log_event(event_action text, target uuid, context jsonb default '{}') returns void
language sql set search_path = '' as $$
  insert into governance.audit_events(actor_id, action, target_id, details)
  values (auth.uid(), event_action, target, context)
$$;

create function geo_api.set_role(target_user uuid, role_code text, enabled boolean) returns void
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
      and ((r.code in ('verification_agent', 'ai_editor')) <> (role_code in ('verification_agent', 'ai_editor')))
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

alter table app.profiles enable row level security;
alter table app.preferences enable row level security;
alter table app.roles enable row level security;
alter table app.user_roles enable row level security;
alter table governance.audit_events enable row level security;

revoke all on all functions in schema app, governance, geo_api from public, anon, authenticated, service_role;
grant execute on function geo_api.set_role(uuid, text, boolean) to authenticated;
