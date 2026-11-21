-- Private synthetic editions share the newsroom run and story identity. The publication
-- API accepts editorial.story_versions, which are intentionally outside this fixture path.
alter table ai_ops.newsroom_policy
  add column editorial_input_tokens integer not null default 28672 check (editorial_input_tokens between 1 and 32000),
  add column editorial_output_tokens integer not null default 8192 check (editorial_output_tokens between 1 and 12000);

create table editorial.newsroom_edition_runs (
  run_id uuid primary key references ai_ops.workflow_runs(id),
  context jsonb not null check (jsonb_typeof(context)='object'),
  current_version_id uuid,
  created_at timestamptz not null default clock_timestamp()
);

create table media.newsroom_fixture_visual_records (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references news.events(id),
  version integer not null default 1 check (version>0),
  data jsonb not null check (jsonb_typeof(data)='object'
    and data->>'kind' in ('map','chart','timeline','infographic','relationship','photo','illustration')),
  caption text not null check (char_length(trim(caption)) between 1 and 400),
  alt text not null check (char_length(trim(alt)) between 1 and 400),
  uncertainty text not null check (char_length(trim(uncertainty)) between 1 and 400),
  evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 48),
  licence_id uuid references media.licences(id),
  asset_version_id uuid references media.asset_versions(id),
  check ((data->>'kind' in ('photo','illustration'))=(asset_version_id is not null)),
  check (licence_id is null or asset_version_id is not null),
  check (asset_version_id is null or data->>'assetVersionId'=asset_version_id::text)
);
create index newsroom_visuals_event on media.newsroom_fixture_visual_records(event_id);

create table editorial.newsroom_edition_products (
  attempt_id uuid primary key references ai_ops.task_attempts(id),
  run_id uuid not null references editorial.newsroom_edition_runs(run_id),
  stage text not null check (stage in ('writing','visual')),
  round smallint not null check (round between 0 and 4),
  payload jsonb not null check (jsonb_typeof(payload)='object' and payload->'synthetic'='true'::jsonb),
  created_at timestamptz not null default clock_timestamp(),
  unique (attempt_id,run_id),
  unique (run_id,stage,round)
);

create table editorial.newsroom_edition_versions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references editorial.newsroom_edition_runs(run_id),
  number integer not null check (number between 1 and 5),
  article_attempt uuid not null,
  visual_attempt uuid not null,
  digest bytea not null check (octet_length(digest)=32),
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id,number),
  unique (id,run_id),
  unique (id,run_id,digest),
  foreign key (article_attempt,run_id) references editorial.newsroom_edition_products(attempt_id,run_id),
  foreign key (visual_attempt,run_id) references editorial.newsroom_edition_products(attempt_id,run_id)
);
alter table editorial.newsroom_edition_runs
  add foreign key (current_version_id,run_id) references editorial.newsroom_edition_versions(id,run_id);

create table editorial.newsroom_edition_reviews (
  attempt_id uuid primary key references ai_ops.task_attempts(id),
  run_id uuid not null,
  version_id uuid not null,
  version_digest bytea not null,
  stage text not null check (stage in ('reverification','editorial')),
  payload jsonb not null check (jsonb_typeof(payload)='object' and payload->'synthetic'='true'::jsonb),
  created_at timestamptz not null default clock_timestamp(),
  unique (version_id,stage),
  foreign key (version_id,run_id,version_digest) references editorial.newsroom_edition_versions(id,run_id,digest)
);

alter table media.newsroom_fixture_visual_records enable row level security;
alter table editorial.newsroom_edition_runs enable row level security;
alter table editorial.newsroom_edition_products enable row level security;
alter table editorial.newsroom_edition_versions enable row level security;
alter table editorial.newsroom_edition_reviews enable row level security;
revoke all on media.newsroom_fixture_visual_records,editorial.newsroom_edition_runs,editorial.newsroom_edition_products,
  editorial.newsroom_edition_versions,editorial.newsroom_edition_reviews from public,anon,authenticated,service_role;

create trigger immutable_fixture_visual before update or delete on media.newsroom_fixture_visual_records
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_edition_product before update or delete on editorial.newsroom_edition_products
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_edition_version before update or delete on editorial.newsroom_edition_versions
  for each row execute function editorial.reject_snapshot_change();
create trigger immutable_edition_review before update or delete on editorial.newsroom_edition_reviews
  for each row execute function editorial.reject_snapshot_change();

create function editorial.fixture_hash(value jsonb) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.digest(convert_to(value::text,'UTF8'),'sha256')
$$;

create function editorial.fixture_material(target_run uuid) returns jsonb
language sql stable set search_path = '' as $$
  with findings as (
    select stage,payload from research.newsroom_fixture_findings where run_id=target_run
  ), facts as (
    select 'claim:'||(c->>'claimId') as id,
      'facts' as section,
      case when c->>'verdict'='verified' and c->>'outdated'='false' then 'verified_fact'
        else 'unverified_allegation' end as frame,
      case when c->>'verdict'='verified' and c->>'outdated'='false' then c->>'normalizedClaim'
        else 'Unverified source claim: '||(c->>'normalizedClaim') end as text,
      case when c->>'verdict'='verified' and c->>'outdated'='false' then c#>'{supporting,evidenceIds}'
        else c->'evidenceIds' end as evidence,
      jsonb_build_array(c->>'claimId') as claims,
      n as position
    from findings f cross join lateral jsonb_array_elements(f.payload->'claims') with ordinality as v(c,n)
    where f.stage='verification' and c->>'sensitive'='false'
    union all
    select 'claim:'||(c->>'claimId'),'facts','verified_fact',c->>'normalizedClaim',
      c#>'{supporting,evidenceIds}',jsonb_build_array(c->>'claimId'),n
    from findings f cross join lateral jsonb_array_elements(f.payload->'claims') with ordinality as v(c,n)
    where f.stage='verification' and c->>'sensitive'='true' and c->>'verdict'='verified' and c->>'outdated'='false'
  ), methods as (
    select 'method:'||(c->>'claimId') as id,'limitations' as section,'editorial_context' as frame,
      case c->>'type'
        when 'number' then 'The number is tied to the measurement unit in the verification record. Compare it only with figures that cover the same exercise and use the same unit. The source citations let readers check the count at that level of detail.'
        when 'date' then 'The supporting record identifies the reported event date. That date has a different evidentiary status from the estimated periods in the historical timeline. The distinction helps readers compare the current event with older observations whose timing remains uncertain.'
        when 'quotation' then 'The verification links the exact words to the source that records them. The quotation supports the attribution of those words. The analysis examines any broader interpretation separately and labels the assumptions readers would need to make about motives or outcomes.'
        else 'The supporting record identifies who issued the notice. Attribution links that claim to the documented issuer, which readers can distinguish from other institutions mentioned in the research. The citation also lets readers check the issuing body independently of the broader analysis.'
      end as text,c#>'{supporting,evidenceIds}' as evidence,jsonb_build_array(c->>'claimId') as claims,n+2 as position
    from findings f cross join lateral jsonb_array_elements(f.payload->'claims') with ordinality as v(c,n)
    where f.stage='verification' and c->>'verdict'='verified' and c->>'outdated'='false'
      and c->>'type' in ('number','date','quotation','attribution')
  ), history as (
    select distinct on (c#>>'{evidenceIds,0}') 'history:'||(c#>>'{evidenceIds,0}') as id, 'history' as section,
      case when c->>'status'='documented' then 'documented_history' else 'disputed_interpretation' end as frame,
      (c->>'statement')||case
        when c#>>'{period,exactDate}' is not null then ' The source dates this to '||(c#>>'{period,exactDate}')||'.'
        when c#>>'{period,earliestYear}' is null then ' The archive leaves the date open.'
        when c#>>'{period,earliestYear}'=c#>>'{period,latestYear}' then ' The recorded year is '||(c#>>'{period,earliestYear}')||'.'
        else ' The source gives a '||(c#>>'{period,certainty}')||' range from '||(c#>>'{period,earliestYear}')
          ||' to '||coalesce(c#>>'{period,latestYear}','an open end')||'.' end as text,
      c->'evidenceIds' as evidence,'[]'::jsonb as claims,n as position
    from findings f cross join lateral (
      select item as c,ord as n from jsonb_array_elements(
        (f.payload->'timeline')||(f.payload->'rootCauses')||(f.payload->'competingInterpretations')
        ||(f.payload->'actors')||(f.payload->'comparativeAnalysis')) with ordinality a(item,ord)
    ) historical where f.stage='history'
    order by c#>>'{evidenceIds,0}',n
  ), analysis as (
    select distinct on (c#>>'{evidenceIds,0}') 'analysis:'||(c#>>'{evidenceIds,0}') as id,'analysis' as section,
      case c->>'framing' when 'documented_objective' then 'documented_objective'
        when 'inferred_intention' then 'inferred_intention' else 'analytical_assumption' end as frame,
      c->>'statement' as text,c->'evidenceIds' as evidence,'[]'::jsonb as claims,n as position
    from findings f cross join lateral jsonb_array_elements(
      (f.payload->'actors')||(f.payload->'interests')||(f.payload->'capabilities')||(f.payload->'constraints')
      ||(f.payload->'alliances')||(f.payload->'rivalries')||(f.payload->'powerDynamics')
      ||(f.payload->'competingExplanations')||(f.payload->'implications')
      ||(f.payload->'regionalImplications')||(f.payload->'risks')||(f.payload->'opportunities')||(f.payload->'earlyWarnings')
    ) with ordinality as a(c,n)
    where f.stage='analysis' and c->>'framing'<>'established_fact'
    order by c#>>'{evidenceIds,0}',n
  ), scenarios as (
    select 'scenario:'||s.key as id,'scenarios' as section,'conditional_scenario' as frame,
      initcap(s.key)||' ('||(s.value->>'horizon')||' horizon). If '||(s.value->>'condition')||', '
        ||(s.value->>'outcome')||' Assumptions: '||coalesce(
          (select string_agg(a,' ' order by n) from jsonb_array_elements_text(s.value->'assumptions') with ordinality as x(a,n)),'')
        ||' Signals to watch: '||coalesce(
          (select string_agg(w,' ' order by n) from jsonb_array_elements_text(s.value->'earlyWarnings') with ordinality as x(w,n)),'') as text,
      s.value->'evidenceIds' as evidence,'[]'::jsonb as claims,
      case s.key when 'baseline' then 1 when 'alternative' then 2 else 3 end as position
    from findings f cross join lateral jsonb_each(f.payload->'scenarios') s where f.stage='analysis'
  ), guides(id,section,text,position) as (values
    ('guide:brief','overview','This account follows three lines of inquiry. It starts with what the records confirm, then places the findings in their historical setting and examines explanations for what might happen next. Each cited paragraph identifies the evidence behind it. Separating those lines helps readers see where the sources agree and where interpretation begins.',0),
    ('guide:measures','facts','Read any reported figure with its period and definition in view. An exercise count describes what the cited source measured during the exercise. Comparing it with another count requires checking that the underlying definitions, dates and geographic coverage match. The methods used to produce a figure can matter just as much as the figure itself.',0),
    ('guide:history','history','The historical record helps readers understand how earlier practices informed the present case. An approximate range marks an event with uncertain timing. Competing interpretations can survive even when the broad sequence is clear. The timeline keeps those differences visible so an ambiguous date or interpretation does not acquire more precision as it moves through the reporting process.',0),
    ('guide:interpretation','analysis','An institution can state a goal while observers disagree about the reasoning behind it. That distinction matters here because the same practical measure can serve several objectives. A documented objective can be attributed to its source. An inferred intention must be weighed against competing explanations and reconsidered as stronger evidence becomes available.',0),
    ('guide:capacity','analysis','Capacity affects whether actors can put their stated plans into practice. A reporting system can exist even where its users face uneven resources or incompatible methods. To judge an explanation, compare the practical constraints with the behavior the sources document. The reporting distinguishes these interpretations from verified events and keeps the basis for each inference visible.',1),
    ('guide:scenarios','scenarios','The scenarios examine what could follow under different conditions. Their usefulness depends on whether the assumptions hold and whether the early signals appear in the records. A reader can track those signals over time and reconsider a scenario when the evidence changes. The horizons set the period for observation and leave the outcome open.',0),
    ('guide:limits','limitations','The source register shows where the record comes from. Reprints of the same report can spread a claim widely while adding no independent evidence. When records conflict, comparing the reported facts, the chronology and the conditions of observation can help identify which parts agree and which questions remain open.',0),
    ('guide:followup','limitations','Further reporting would follow the audit trail from each claim to the documented observation and then look for independent records covering the same period. Consistent terms, identifiable sources and comparable dates make an assessment easier to reproduce. A gap in the available record is itself worth documenting so readers can judge how much weight to place on the conclusions.',1)
  ), material as (
    select id,section,'editorial_context'::text as frame,text,'[]'::jsonb as evidence,'[]'::jsonb as claims,position::bigint
      from guides
    union all select * from facts
    union all select * from methods
    union all select * from history
    union all select * from analysis
    union all select * from scenarios
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'section',section,'frame',frame,'text',text,
    'evidenceIds',evidence,'claimIds',claims) order by section,(frame<>'editorial_context'),position,id),'[]')
  from material
$$;

create function editorial.fixture_current_visuals(target_event uuid,target_research uuid) returns jsonb
language sql stable set search_path = '' as $$
  with candidates as (
    select r.*,av.version as asset_version,av.asset_id,av.digest as asset_digest,av.object_key,av.storage_version,
      l.id as registered_licence,l.asset_id as licensed_asset,l.revoked_at,l.valid_from,l.valid_until,
      (select coalesce(jsonb_agg(distinct e.document_id order by e.document_id),'[]')
        from research.newsroom_fixture_evidence e where e.event_id=r.event_id and e.id=any(r.evidence_ids)) as documents,
      exists (select 1 from unnest(r.evidence_ids) x(id) where not exists (
        select 1 from research.newsroom_fixture_findings f join research.newsroom_fixture_citations c on c.attempt_id=f.attempt_id
        where f.run_id=target_research and c.event_id=r.event_id and c.evidence_id=x.id
      )) as unknown_evidence
    from media.newsroom_fixture_visual_records r
    left join media.asset_versions av on av.id=r.asset_version_id
    left join media.licences l on l.id=r.licence_id
    where r.event_id=target_event
    order by r.id limit 17
  ), classified as (
    select q.*,
      case
        when q.revoked_at is not null then 'revoked'
        when q.unknown_evidence or exists (
          select 1 from jsonb_array_elements_text(q.documents) d(id)
          where not exists (select 1 from ai_ops.research_source_documents(target_event) s where s.document_id::text=d.id)
        ) then 'missing'
        when q.asset_version_id is not null and (
          q.licensed_asset is distinct from q.asset_id or q.valid_from>statement_timestamp()
          or q.valid_until<=statement_timestamp() or not exists (
            select 1 from storage.objects o where o.bucket_id='editorial-private' and o.name=q.object_key and o.version=q.storage_version
          )
        ) then 'missing'
        when q.data->>'kind'='chart' and exists (
          select 1 from jsonb_array_elements(q.data->'values') point
          where not exists (
            select 1 from research.newsroom_fixture_findings f join ai_ops.task_attempts a on a.id=f.attempt_id
            cross join lateral jsonb_path_query(a.input#>'{researchInput,evidence}','$.**.atoms[*]') atom
            join lateral jsonb_array_elements(f.payload->'claims') claim on claim->>'claimId'=atom->>'claimId'
            where f.run_id=target_research and f.stage='verification' and claim->>'verdict'='verified'
              and claim->>'outdated'='false' and atom->>'claimId'=point->>'claimId' and atom->>'type'='number'
              and ai_ops.fixture_comparison_value(atom->>'value','number')
                =ai_ops.fixture_comparison_value((point->>'value')||' '||(q.data->>'unit'),'number')
              and exists (select 1 from jsonb_array_elements_text(claim#>'{supporting,evidenceIds}') supporting(id)
                where supporting.id::uuid=any(q.evidence_ids))
          )
        ) then 'missing'
        when q.data->>'kind'='timeline' and exists (
          select 1 from jsonb_array_elements(q.data->'entries') item
          where not exists (
            select 1 from research.newsroom_fixture_findings f cross join lateral jsonb_array_elements(f.payload->'timeline') record
            where f.run_id=target_research and f.stage='history' and item->>'label'=record->>'statement'
              and (item->'startYear') is not distinct from (record#>'{period,earliestYear}')
              and (item->'endYear') is not distinct from (record#>'{period,latestYear}')
              and item->>'certainty'=record#>>'{period,certainty}'
              and exists (select 1 from jsonb_array_elements_text(record->'evidenceIds') cited(id)
                where cited.id::uuid=any(q.evidence_ids))
          )
        ) then 'missing'
        else 'active'
      end as rights
    from candidates q
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'version',coalesce(asset_version,version),
    'digest',encode(editorial.fixture_hash(jsonb_build_array(id,version,encode(asset_digest,'hex'),data,
      caption,alt,uncertainty,evidence_ids,licence_id,asset_version_id)),'hex'),
    'data',data,'caption',caption,'alt',alt,'uncertainty',uncertainty,'evidenceIds',to_jsonb(evidence_ids),
    'documentIds',documents,'provenance',case data->>'kind' when 'photo' then 'licensed_fixture'
      when 'illustration' then 'mock_ai' else 'research_fixture' end,
    'licence',jsonb_build_object('status',rights,'reference',coalesce(registered_licence::text,
      case when asset_version_id is null then 'Stage 5B source acquisition licences' else 'Missing media licence' end)))
    order by id),'[]') from classified
$$;

revoke all on function editorial.fixture_hash(jsonb),editorial.fixture_material(uuid),
  editorial.fixture_current_visuals(uuid,uuid) from public,anon,authenticated,service_role;
