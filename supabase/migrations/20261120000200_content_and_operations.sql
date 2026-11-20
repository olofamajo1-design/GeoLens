create table news.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);
create table news.source_permissions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references news.sources(id),
  attribution text not null,
  valid_from timestamptz not null,
  valid_until timestamptz,
  revoked_at timestamptz,
  unique (id, source_id),
  check (valid_until is null or valid_until > valid_from)
);
create table news.documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references news.sources(id),
  external_reference text not null,
  digest bytea not null check (octet_length(digest) = 32),
  retrieved_at timestamptz not null default now(),
  unique (source_id, external_reference, digest),
  unique (id, source_id)
);
create table news.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  occurred_at timestamptz
);
create table news.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  unique (country_code, name)
);
create table news.event_locations (
  event_id uuid references news.events(id),
  location_id uuid references news.locations(id),
  primary key (event_id, location_id)
);
create table news.event_documents (
  event_id uuid references news.events(id),
  document_id uuid references news.documents(id),
  primary key (event_id, document_id)
);
create table research.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
create table research.claims (
  id uuid primary key default gen_random_uuid(),
  statement text not null
);
create table research.claim_entities (
  claim_id uuid references research.claims(id),
  entity_id uuid references research.entities(id),
  primary key (claim_id, entity_id)
);
create table research.evidence (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references news.documents(id),
  excerpt text not null
);
create table research.claim_evidence (
  claim_id uuid references research.claims(id),
  evidence_id uuid references research.evidence(id),
  relationship text not null check (relationship in ('supports', 'disputes', 'contextualizes')),
  primary key (claim_id, evidence_id)
);
create table research.historical_research (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references news.events(id),
  evidence_id uuid not null references research.evidence(id),
  summary text not null
);

create table media.assets (
  id uuid primary key default gen_random_uuid(),
  label text not null
);
create table media.asset_versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references media.assets(id),
  version integer not null check (version > 0),
  object_key text not null unique,
  storage_version text not null,
  digest bytea not null check (octet_length(digest) = 32),
  unique (asset_id, version),
  unique (id, asset_id)
);
create table media.licences (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references media.assets(id),
  terms text not null,
  valid_from timestamptz not null,
  valid_until timestamptz,
  revoked_at timestamptz,
  unique (id, asset_id),
  check (valid_until is null or valid_until > valid_from)
);

create table ai_ops.agents (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null
);
insert into ai_ops.agents(code, name) values
  ('GL-AGENT-001', 'Central Editorial Orchestrator'),
  ('GL-AGENT-002', 'News Discovery Agent'),
  ('GL-AGENT-003', 'Historical Research Agent'),
  ('GL-AGENT-004', 'Verification Agent'),
  ('GL-AGENT-005', 'Geopolitical Analysis Agent'),
  ('GL-AGENT-006', 'Editorial Writing Agent'),
  ('GL-AGENT-007', 'Visual Intelligence Agent'),
  ('GL-AGENT-008', 'AI Editor-in-Chief');

create table ai_ops.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references ai_ops.agents(id),
  version integer not null check (version > 0),
  digest bytea not null check (octet_length(digest) = 32),
  unique (agent_id, version),
  unique (id, agent_id)
);

create index source_permissions_source on news.source_permissions(source_id);
create index event_locations_location on news.event_locations(location_id);
create index event_documents_document on news.event_documents(document_id);
create index claim_entities_entity on research.claim_entities(entity_id);
create index evidence_document on research.evidence(document_id);
create index claim_evidence_evidence on research.claim_evidence(evidence_id);
create index historical_research_event on research.historical_research(event_id);
create index historical_research_evidence on research.historical_research(evidence_id);
create index licences_asset on media.licences(asset_id);

do $$
declare relation record;
begin
  for relation in select schemaname, tablename from pg_tables
    where schemaname in ('news', 'research', 'media', 'ai_ops')
  loop
    execute format('alter table %I.%I enable row level security', relation.schemaname, relation.tablename);
  end loop;
end
$$;
