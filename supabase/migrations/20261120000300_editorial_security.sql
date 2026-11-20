create table editorial.stories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  synthetic boolean not null default false,
  created_at timestamptz not null default now()
);
create table editorial.story_versions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references editorial.stories(id),
  version integer not null check (version > 0),
  article jsonb not null check (jsonb_typeof(article) = 'object'),
  digest bytea not null check (octet_length(digest) = 32),
  created_at timestamptz not null default now(),
  unique (story_id, version),
  unique (id, story_id)
);
create table editorial.version_citations (
  version_id uuid references editorial.story_versions(id),
  position integer check (position > 0),
  source_id uuid not null,
  document_id uuid not null,
  permission_id uuid not null,
  snapshot jsonb not null,
  primary key (version_id, position),
  foreign key (document_id, source_id) references news.documents(id, source_id),
  foreign key (permission_id, source_id) references news.source_permissions(id, source_id)
);
create table editorial.version_claims (
  version_id uuid references editorial.story_versions(id),
  claim_id uuid references research.claims(id),
  position integer not null check (position > 0),
  snapshot jsonb not null,
  primary key (version_id, claim_id),
  unique (version_id, position)
);
create table editorial.version_media (
  version_id uuid references editorial.story_versions(id),
  position integer check (position > 0),
  asset_id uuid not null,
  asset_version_id uuid not null,
  licence_id uuid not null,
  snapshot jsonb not null,
  primary key (version_id, position),
  foreign key (asset_version_id, asset_id) references media.asset_versions(id, asset_id),
  foreign key (licence_id, asset_id) references media.licences(id, asset_id)
);

create table ai_ops.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references editorial.story_versions(id),
  request_key text not null unique,
  created_at timestamptz not null default now()
);
create table ai_ops.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references ai_ops.workflow_runs(id),
  agent_id uuid not null references ai_ops.agents(id),
  prompt_version_id uuid,
  unique (workflow_id, agent_id),
  foreign key (prompt_version_id, agent_id) references ai_ops.prompt_versions(id, agent_id)
);
create table ai_ops.task_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references ai_ops.agent_tasks(id),
  attempt smallint not null check (attempt between 1 and 3),
  contract_version smallint not null check (contract_version > 0),
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  output jsonb not null check (jsonb_typeof(output) = 'object'),
  synthetic boolean not null,
  finished_at timestamptz not null default now(),
  unique (task_id, attempt)
);

create table ai_ops.usage_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references ai_ops.task_attempts(id),
  provider_reference text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null default now(),
  unique (attempt_id, provider_reference)
);

create table ai_ops.budget_limits (
  id uuid primary key default gen_random_uuid(),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor >= 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  unique (currency, starts_at),
  check (ends_at > starts_at)
);

create table editorial.reviews (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references editorial.story_versions(id),
  kind text not null check (kind in ('verification', 'ai_editorial')),
  attempt_id uuid unique references ai_ops.task_attempts(id),
  outcome text not null check (outcome in ('pass', 'fail', 'invalidated')),
  actor_id uuid not null references auth.users(id),
  reason text,
  sequence bigint generated always as identity unique,
  created_at timestamptz not null default clock_timestamp(),
  check ((outcome = 'invalidated') = (attempt_id is null))
);
create index reviews_version_history on editorial.reviews(version_id, kind, sequence desc);

create table editorial.human_decisions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references editorial.story_versions(id),
  verification_id uuid not null references editorial.reviews(id),
  ai_review_id uuid not null references editorial.reviews(id),
  reviewer_id uuid not null references auth.users(id),
  approved boolean not null,
  sequence bigint generated always as identity unique,
  created_at timestamptz not null default clock_timestamp(),
  unique (id, version_id)
);
create index decisions_version_history on editorial.human_decisions(version_id, sequence desc);

create table editorial.publications (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null,
  version_id uuid not null,
  decision_id uuid not null,
  publisher_id uuid not null references auth.users(id),
  request_id uuid not null,
  published_at timestamptz not null default clock_timestamp(),
  withdrawn_at timestamptz,
  foreign key (version_id, story_id) references editorial.story_versions(id, story_id),
  foreign key (decision_id, version_id) references editorial.human_decisions(id, version_id),
  unique (story_id, request_id),
  unique (id, story_id),
  unique (id, version_id)
);
create unique index one_active_publication on editorial.publications(story_id) where withdrawn_at is null;

create table editorial.corrections (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null,
  prior_publication_id uuid not null unique,
  replacement_publication_id uuid not null unique,
  note text not null check (length(trim(note)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (prior_publication_id, story_id) references editorial.publications(id, story_id),
  foreign key (replacement_publication_id, story_id) references editorial.publications(id, story_id),
  check (prior_publication_id <> replacement_publication_id)
);

create index version_citation_permission on editorial.version_citations(permission_id);
create index version_media_licence on editorial.version_media(licence_id);
create index version_media_asset on editorial.version_media(asset_version_id);
create index workflow_version on ai_ops.workflow_runs(version_id);
create index publication_version on editorial.publications(version_id);

-- Only the trusted ingestion path can seal content. It is intentionally absent from the Data API.
create function editorial.seal_version(target_story uuid, article_data jsonb, citations jsonb, manifest jsonb, claims jsonb default '[]')
returns uuid language plpgsql set search_path = '' as $$
declare
  result uuid := gen_random_uuid();
  citation_snapshot jsonb;
  media_snapshot jsonb;
  claim_snapshot jsonb;
begin
  perform 1 from editorial.stories where id = target_story for update;
  if not found then raise exception 'Unknown story'; end if;
  if jsonb_typeof(article_data) is distinct from 'object'
    or nullif(trim(article_data->>'title'), '') is null
    or nullif(trim(article_data->>'body'), '') is null
    or jsonb_typeof(citations) is distinct from 'array'
    or jsonb_typeof(manifest) is distinct from 'array'
    or jsonb_typeof(claims) is distinct from 'array'
    or jsonb_array_length(citations) = 0 then
    raise exception 'Article and at least one citation are required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'document_id', d.id, 'source_id', d.source_id, 'permission_id', p.id,
    'external_reference', d.external_reference, 'digest', encode(d.digest, 'hex'), 'attribution', p.attribution
  ) order by c.ord), '[]') into citation_snapshot
  from jsonb_array_elements(citations) with ordinality c(item, ord)
  join news.documents d on d.id = (c.item->>'document_id')::uuid
  join news.source_permissions p on p.id = (c.item->>'permission_id')::uuid and p.source_id = d.source_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'asset_id', a.asset_id, 'asset_version_id', a.id, 'licence_id', l.id,
    'digest', encode(a.digest, 'hex'), 'object_key', a.object_key, 'storage_version', a.storage_version
  ) order by m.ord), '[]') into media_snapshot
  from jsonb_array_elements(manifest) with ordinality m(item, ord)
  join media.asset_versions a on a.id = (m.item->>'asset_version_id')::uuid
  join media.licences l on l.id = (m.item->>'licence_id')::uuid and l.asset_id = a.asset_id;

  select coalesce(jsonb_agg(jsonb_build_object('claim_id', c.id, 'statement', c.statement) order by x.ord), '[]')
    into claim_snapshot
    from jsonb_array_elements_text(claims) with ordinality x(id, ord)
    join research.claims c on c.id = x.id::uuid;
  if jsonb_array_length(citation_snapshot) <> jsonb_array_length(citations)
    or jsonb_array_length(media_snapshot) <> jsonb_array_length(manifest)
    or jsonb_array_length(claim_snapshot) <> jsonb_array_length(claims) then
    raise exception 'Invalid citation, media or claim binding';
  end if;

  insert into editorial.story_versions(id, story_id, version, article, digest)
  select result, target_story, coalesce(max(version), 0) + 1, article_data,
    extensions.digest(convert_to(jsonb_build_object('format', 1, 'article', article_data,
      'citations', citation_snapshot, 'media', media_snapshot, 'claims', claim_snapshot)::text, 'UTF8'), 'sha256')
  from editorial.story_versions where story_id = target_story;
  insert into editorial.version_citations
    select result, ord, (item->>'source_id')::uuid, (item->>'document_id')::uuid, (item->>'permission_id')::uuid, item
    from jsonb_array_elements(citation_snapshot) with ordinality x(item, ord);
  insert into editorial.version_media
    select result, ord, (item->>'asset_id')::uuid, (item->>'asset_version_id')::uuid, (item->>'licence_id')::uuid, item
    from jsonb_array_elements(media_snapshot) with ordinality x(item, ord);
  insert into editorial.version_claims
    select result, (item->>'claim_id')::uuid, ord, item
    from jsonb_array_elements(claim_snapshot) with ordinality x(item, ord);
  perform governance.log_event('version.sealed', result);
  return result;
end
$$;

create function editorial.reject_snapshot_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Sealed records are immutable';
end
$$;

create trigger immutable_story_versions before update or delete on editorial.story_versions
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_media_versions before update or delete on media.asset_versions
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_version_citations before update or delete on editorial.version_citations
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_version_media before update or delete on editorial.version_media
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_version_claims before update or delete on editorial.version_claims
  for each row execute function editorial.reject_snapshot_change();

create function editorial.lock_version(target_version uuid, expected_digest text) returns uuid
language plpgsql set search_path = '' as $$
declare
  target_story uuid;
begin
  select story_id into target_story from editorial.story_versions
    where id = target_version and encode(digest, 'hex') = expected_digest;
  if not found then raise exception 'Version or digest mismatch'; end if;
  perform 1 from editorial.stories where id = target_story for update;
  return target_story;
end
$$;

create function editorial.current_review(target_version uuid, review_kind text) returns uuid
language sql stable set search_path = '' as $$
  select case when outcome = 'pass' then id end
  from editorial.reviews where version_id = target_version and kind = review_kind
  order by sequence desc limit 1
$$;

create function geo_api.record_review(target_version uuid, expected_digest text, review_kind text,
  target_attempt uuid, passed boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid;
  expected_agent text;
begin
  if review_kind = 'verification' and app.has_role('verification_agent') then
    expected_agent := 'GL-AGENT-004';
  elsif review_kind = 'ai_editorial' and app.has_role('ai_editor') then
    expected_agent := 'GL-AGENT-008';
  else raise exception 'Scoped reviewer role required' using errcode = '42501';
  end if;
  if passed is null then raise exception 'Review outcome required'; end if;
  perform editorial.lock_version(target_version, expected_digest);
  if not exists (
    select 1 from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id = a.task_id
    join ai_ops.agents g on g.id = t.agent_id join ai_ops.workflow_runs w on w.id = t.workflow_id
    join editorial.story_versions v on v.id = w.version_id join editorial.stories s on s.id = v.story_id
    where a.id = target_attempt and w.version_id = target_version and g.code = expected_agent
      and a.synthetic = s.synthetic
  ) then raise exception 'Attempt does not match the sealed version and reviewer'; end if;
  insert into editorial.reviews(version_id, kind, attempt_id, outcome, actor_id)
    values (target_version, review_kind, target_attempt, case when passed then 'pass' else 'fail' end, auth.uid())
    returning id into result;
  perform governance.log_event('review.recorded', result, jsonb_build_object('version_id', target_version));
  return result;
end
$$;

create function geo_api.invalidate_review(target_version uuid, expected_digest text, review_kind text, reason_text text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  perform app.require_human('human_editor');
  perform editorial.lock_version(target_version, expected_digest);
  if nullif(trim(reason_text), '') is null then raise exception 'Reason required'; end if;
  insert into editorial.reviews(version_id, kind, outcome, actor_id, reason)
    values (target_version, review_kind, 'invalidated', auth.uid(), reason_text) returning id into result;
  perform governance.log_event('review.invalidated', result, jsonb_build_object('version_id', target_version));
  return result;
end
$$;

create function geo_api.decide_version(target_version uuid, expected_digest text, approve boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  verification uuid;
  ai_review uuid;
  result uuid;
begin
  perform app.require_human('human_editor');
  perform editorial.lock_version(target_version, expected_digest);
  verification := editorial.current_review(target_version, 'verification');
  ai_review := editorial.current_review(target_version, 'ai_editorial');
  if verification is null or ai_review is null then raise exception 'Both successful reviews are required'; end if;
  insert into editorial.human_decisions(version_id, verification_id, ai_review_id, reviewer_id, approved)
    values (target_version, verification, ai_review, auth.uid(), approve) returning id into result;
  perform governance.log_event('version.decided', result,
    jsonb_build_object('version_id', target_version, 'approved', approve));
  return result;
end
$$;

create function editorial.rights_active(target_version uuid, at_time timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from editorial.version_citations where version_id = target_version)
    and not exists (
      select 1 from editorial.version_citations c join news.source_permissions p on p.id = c.permission_id
      where c.version_id = target_version and (p.revoked_at is not null or at_time < p.valid_from
        or at_time >= p.valid_until)
    )
    and not exists (
      select 1 from editorial.version_media m join media.licences l on l.id = m.licence_id
      join media.asset_versions av on av.id = m.asset_version_id
      where m.version_id = target_version and (l.revoked_at is not null or at_time < l.valid_from
        or at_time >= l.valid_until or not exists (
          select 1 from storage.objects o where o.bucket_id = 'editorial-private'
            and o.name = av.object_key and o.version = av.storage_version
        ))
    )
$$;

create function geo_api.release_version(target_version uuid, expected_digest text, operation_id uuid,
  replaces uuid default null, correction_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  target_story uuid;
  prior editorial.publications%rowtype;
  existing editorial.publications%rowtype;
  decision editorial.human_decisions%rowtype;
  result uuid;
begin
  perform app.require_human('human_publisher');
  target_story := editorial.lock_version(target_version, expected_digest);
  select * into existing from editorial.publications where story_id = target_story and request_id = operation_id;
  if found then
    if existing.version_id <> target_version or not exists (
      select 1 where replaces is null and correction_note is null and not exists (
        select 1 from editorial.corrections where replacement_publication_id = existing.id)
      union all
      select 1 from editorial.corrections where replacement_publication_id = existing.id
        and prior_publication_id = replaces and note = correction_note
    ) then raise exception 'Idempotency key conflicts with an earlier release'; end if;
    return existing.id;
  end if;
  select * into decision from editorial.human_decisions where version_id = target_version order by sequence desc limit 1;
  if not found or not decision.approved
    or decision.verification_id is distinct from editorial.current_review(target_version, 'verification')
    or decision.ai_review_id is distinct from editorial.current_review(target_version, 'ai_editorial')
    then raise exception 'Current exact-version approval required'; end if;

  perform p.id from news.source_permissions p join editorial.version_citations c on c.permission_id = p.id
    where c.version_id = target_version order by p.id for share of p;
  perform l.id from media.licences l join editorial.version_media m on m.licence_id = l.id
    where m.version_id = target_version order by l.id for share of l;
  if not editorial.rights_active(target_version, clock_timestamp()) then raise exception 'Active rights required'; end if;
  select * into prior from editorial.publications where story_id = target_story and withdrawn_at is null;
  if replaces is null then
    if found or correction_note is not null then raise exception 'Existing release requires a correction'; end if;
  else
    if found and prior.id <> replaces then raise exception 'Correction must replace the current release'; end if;
    select * into prior from editorial.publications where id = replaces and story_id = target_story;
    if not found or prior.version_id = target_version or nullif(trim(correction_note), '') is null
      or exists (select 1 from editorial.corrections where prior_publication_id = replaces)
      then raise exception 'Correction requires an earlier release and a reason'; end if;
    update editorial.publications set withdrawn_at = clock_timestamp() where id = replaces and withdrawn_at is null;
  end if;
  insert into editorial.publications(story_id, version_id, decision_id, publisher_id, request_id)
    values (target_story, target_version, decision.id, auth.uid(), operation_id) returning id into result;
  if replaces is not null then
    insert into editorial.corrections(story_id, prior_publication_id, replacement_publication_id, note)
      values (target_story, replaces, result, correction_note);
  end if;
  perform governance.log_event('publication.released', result,
    jsonb_build_object('version_id', target_version, 'replaces', replaces));
  return result;
end
$$;

create function geo_api.withdraw_publication(publication uuid, reason_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare target_story uuid;
begin
  perform app.require_human('human_publisher');
  if nullif(trim(reason_text), '') is null then raise exception 'Reason required'; end if;
  select story_id into strict target_story from editorial.publications where id = publication;
  perform 1 from editorial.stories where id = target_story for update;
  update editorial.publications set withdrawn_at = clock_timestamp() where id = publication and withdrawn_at is null;
  if found then
    perform governance.log_event('publication.withdrawn', publication, jsonb_build_object('reason', reason_text));
  end if;
end
$$;

create function geo_api.revoke_right(right_kind text, right_id uuid, reason_text text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_human('super_admin');
  if nullif(trim(reason_text), '') is null then raise exception 'Reason required'; end if;
  case right_kind
    when 'source' then update news.source_permissions set revoked_at = clock_timestamp()
      where id = right_id and revoked_at is null;
    when 'media' then update media.licences set revoked_at = clock_timestamp()
      where id = right_id and revoked_at is null;
    else raise exception 'Unknown rights type';
  end case;
  if found then
    perform governance.log_event('rights.revoked', right_id, jsonb_build_object('type', right_kind, 'reason', reason_text));
  end if;
end
$$;

create function geo_api.published_story(story_slug text)
returns table (slug text, article jsonb, synthetic boolean, published_at timestamptz, correction text)
language sql stable security definer set search_path = '' as $$
  select s.slug, jsonb_build_object('title', v.article->>'title', 'body', v.article->>'body',
      'attributions', (select jsonb_agg(vc.snapshot->>'attribution' order by vc.position)
        from editorial.version_citations vc where vc.version_id = v.id)),
    s.synthetic, p.published_at, c.note
  from editorial.publications p join editorial.stories s on s.id = p.story_id
  join editorial.story_versions v on v.id = p.version_id
  left join editorial.corrections c on c.replacement_publication_id = p.id
  where s.slug = story_slug and p.withdrawn_at is null and editorial.rights_active(v.id, statement_timestamp())
$$;

do $$
declare relation record;
begin
  for relation in select schemaname, tablename from pg_tables where schemaname in ('editorial', 'ai_ops')
  loop
    execute format('alter table %I.%I enable row level security', relation.schemaname, relation.tablename);
  end loop;
end
$$;

revoke all on all functions in schema editorial, geo_api from public, anon, authenticated, service_role;
grant execute on function geo_api.set_role(uuid, text, boolean),
  geo_api.record_review(uuid, text, text, uuid, boolean), geo_api.invalidate_review(uuid, text, text, text),
  geo_api.decide_version(uuid, text, boolean), geo_api.release_version(uuid, text, uuid, uuid, text),
  geo_api.withdraw_publication(uuid, text), geo_api.revoke_right(text, uuid, text) to authenticated;
grant execute on function geo_api.published_story(text) to anon, authenticated;
