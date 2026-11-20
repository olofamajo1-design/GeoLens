create table community.factcheck_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  question text not null check (length(trim(question)) between 1 and 8000),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);
create index factcheck_owner on community.factcheck_requests(owner_id, created_at);

create table community.factcheck_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  owner_id uuid not null default auth.uid(),
  object_key text generated always as (owner_id::text || '/' || id::text) stored unique,
  created_at timestamptz not null default now(),
  foreign key (request_id, owner_id) references community.factcheck_requests(id, owner_id) on delete cascade
);
create index factcheck_attachment_request on community.factcheck_attachments(request_id, owner_id);

create table app.ask_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null check (length(trim(title)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);
create index ask_sessions_owner on app.ask_sessions(owner_id, created_at);

create table app.ask_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  owner_id uuid not null default auth.uid(),
  body text not null check (length(trim(body)) between 1 and 16000),
  created_at timestamptz not null default now(),
  foreign key (session_id, owner_id) references app.ask_sessions(id, owner_id) on delete cascade
);
create index ask_messages_session on app.ask_messages(session_id, owner_id, created_at);

create table governance.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('access', 'deletion')),
  created_at timestamptz not null default now()
);
create index privacy_requests_owner on governance.privacy_requests(owner_id);

alter table community.factcheck_requests enable row level security;
alter table community.factcheck_attachments enable row level security;
alter table app.ask_sessions enable row level security;
alter table app.ask_messages enable row level security;
alter table governance.privacy_requests enable row level security;

create policy own_profile on app.profiles to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
create policy own_preferences on app.preferences to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

do $$
declare relation regclass;
begin
  foreach relation in array array['app.ask_sessions'::regclass, 'app.ask_messages'::regclass,
      'community.factcheck_requests'::regclass, 'community.factcheck_attachments'::regclass]
  loop
    execute format('create policy owner_read on %s for select to authenticated using (owner_id = (select auth.uid()))', relation);
    execute format('create policy owner_insert on %s for insert to authenticated with check (owner_id = (select auth.uid()))', relation);
  end loop;
end
$$;

-- The exposed views retain invoker permissions and enforce the underlying RLS.
grant usage on schema app, community to authenticated;
grant select on app.profiles, app.preferences, app.ask_sessions, app.ask_messages,
  community.factcheck_requests, community.factcheck_attachments to authenticated;
grant insert (id, display_name), update (display_name) on app.profiles to authenticated;
grant insert (user_id, settings), update (settings) on app.preferences to authenticated;
grant insert (title) on app.ask_sessions to authenticated;
grant insert (session_id, body) on app.ask_messages to authenticated;
grant insert (question) on community.factcheck_requests to authenticated;
grant insert (request_id) on community.factcheck_attachments to authenticated;

create view geo_api.profiles with (security_invoker = true) as select * from app.profiles;
create view geo_api.preferences with (security_invoker = true) as select * from app.preferences;
create view geo_api.ask_sessions with (security_invoker = true) as select * from app.ask_sessions;
create view geo_api.ask_messages with (security_invoker = true) as select * from app.ask_messages;
create view geo_api.factcheck_requests with (security_invoker = true) as select * from community.factcheck_requests;
create view geo_api.factcheck_attachments with (security_invoker = true) as select * from community.factcheck_attachments;
grant select on geo_api.profiles, geo_api.preferences, geo_api.ask_sessions, geo_api.ask_messages,
  geo_api.factcheck_requests, geo_api.factcheck_attachments to authenticated;
grant insert (id, display_name), update (display_name) on geo_api.profiles to authenticated;
grant insert (user_id, settings), update (settings) on geo_api.preferences to authenticated;
grant insert (title) on geo_api.ask_sessions to authenticated;
grant insert (session_id, body) on geo_api.ask_messages to authenticated;
grant insert (question) on geo_api.factcheck_requests to authenticated;
grant insert (request_id) on geo_api.factcheck_attachments to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('factcheck-private', 'factcheck-private', false, 1048576, array['text/plain']),
  ('editorial-private', 'editorial-private', false, 1048576, array['image/png']);

-- Storage checks use database-backed attachment bindings. An object prefix alone grants no access.
create policy factcheck_owner_read on storage.objects for select to authenticated using (
  bucket_id = 'factcheck-private'
  and current_setting('storage.operation', true) in (
    'storage.object.get_authenticated', 'storage.object.info_authenticated',
    'storage.object.list', 'storage.object.list_v2'
  )
  and exists (
    select 1 from community.factcheck_attachments a where a.object_key = storage.objects.name
      and a.owner_id = (select auth.uid())
  )
);
create policy factcheck_owner_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'factcheck-private' and exists (
    select 1 from community.factcheck_attachments a where a.object_key = storage.objects.name
      and a.owner_id = (select auth.uid())
  )
);
-- Read access is evaluated live on each authenticated Storage GET, including the
-- anonymous application JWT. Listing and signing have different operation names.
create function editorial.can_read_media(storage_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from media.asset_versions av join editorial.version_media vm on vm.asset_version_id = av.id
    join editorial.publications p on p.version_id = vm.version_id
    where av.object_key = storage_key and p.withdrawn_at is null
      and editorial.rights_active(p.version_id, statement_timestamp())
  )
$$;
revoke all on function editorial.can_read_media(text) from public, anon, authenticated, service_role;
grant execute on function editorial.can_read_media(text) to anon, authenticated;

create policy editorial_eligible_media_download on storage.objects for select to anon, authenticated using (
  bucket_id = 'editorial-private'
  and current_setting('storage.operation', true) = 'storage.object.get_authenticated'
  and editorial.can_read_media(name)
);
create function geo_api.publication_media(story_slug text, position_number integer)
returns table (object_key text, sha256 text)
language sql stable security definer set search_path = '' as $$
  select av.object_key, encode(av.digest, 'hex')
  from editorial.publications p join editorial.stories s on s.id = p.story_id
  join editorial.version_media vm on vm.version_id = p.version_id
  join media.asset_versions av on av.id = vm.asset_version_id
  where s.slug = story_slug and vm.position = position_number and p.withdrawn_at is null
    and editorial.rights_active(p.version_id, statement_timestamp())
$$;
revoke all on function geo_api.publication_media(text, integer) from public, anon, authenticated, service_role;
grant execute on function geo_api.publication_media(text, integer) to anon, authenticated;

revoke all on all tables in schema app, news, research, editorial, ai_ops, media, community, governance, geo_api
  from public, anon, service_role;
