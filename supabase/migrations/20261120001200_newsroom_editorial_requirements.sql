-- Extend the existing immutable fixture catalogue and lease packets. Previously
-- sealed edition products and their digests stay readable through the v1 shape.
alter table media.newsroom_fixture_visual_records
  add column title text check (title is null or char_length(trim(title)) between 1 and 160),
  add column purpose text check (purpose is null or char_length(trim(purpose)) between 1 and 320),
  add column observed_on date;

create function editorial.fixture_article_guideline(article_format text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('minWords',g.minimum,'maxWords',g.maximum,'allowsLonger',g.format='investigative_report')
  from (values ('quick_brief',150,300),('deep_dive',900,1500),('historical_explainer',800,1500),
    ('geopolitical_analysis',1000,1800),('investigative_report',1500,3000),('special_feature',1200,2500),
    ('factcheck_report',500,900)) g(format,minimum,maximum)
  where g.format=article_format
$$;

create function editorial.fixture_draft_classification(target_run uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'category',case payload->>'scope' when 'nigeria' then 'nigeria' when 'africa' then 'africa' else 'world' end,
    'tags',(select coalesce(jsonb_agg(name order by name),'[]') from (
      select name from (
        select trim(l->>'name') as name from jsonb_array_elements(payload->'locations') l
        union select trim(e) from jsonb_array_elements_text(payload->'entities') e
      ) terms where name ~ '^[[:alnum:]][[:alnum:][:space:].''&(),-]{0,79}$' order by name limit 12
    ) tags))
  from research.newsroom_fixture_findings where run_id=target_run and stage='discovery'
$$;

create function editorial.fixture_draft_metadata(packet jsonb,article_format text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('seoTitle',packet#>'{headlines,0}',
    'seoDescription',regexp_replace(left(packet->>'standfirst',160),'[[:space:]]+$',''),
    'categories',jsonb_build_array(packet#>'{classification,category}')||case article_format
      when 'historical_explainer' then '["history"]'::jsonb when 'geopolitical_analysis' then '["geopolitics"]'::jsonb
      when 'factcheck_report' then '["factcheck"]'::jsonb else '[]'::jsonb end,
    'tags',packet#>'{classification,tags}','socialSummary',packet->'standfirst',
    'wordCountGuideline',editorial.fixture_article_guideline(article_format))
$$;

alter function editorial.fixture_valid_writing(jsonb,jsonb) rename to fixture_valid_writing_v1;

create function editorial.fixture_valid_writing(packet jsonb,output jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  articles jsonb;
begin
  if not (packet ? 'classification') then return editorial.fixture_valid_writing_v1(packet,output); end if;
  if jsonb_typeof(output->'articles') is distinct from 'array' or exists (
    select 1 from jsonb_array_elements(output->'articles') a
    where a->'metadata' is distinct from editorial.fixture_draft_metadata(packet,a->>'format')
  ) then return false; end if;
  select coalesce(jsonb_agg(a.article-'metadata' order by a.position),'[]') into articles
    from jsonb_array_elements(output->'articles') with ordinality a(article,position);
  return editorial.fixture_valid_writing_v1(packet,output||jsonb_build_object('articles',articles));
end
$$;

create function editorial.fixture_visual_descriptions(candidates jsonb,captured_at timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(c.asset||jsonb_build_object(
    'title',coalesce(trim(r.title),left(trim(r.caption),160)),
    'purpose',coalesce(trim(r.purpose),case r.data->>'kind'
      when 'map' then 'Locate the area described in the sourced fixture.'
      when 'chart' then 'Compare quantities in the verified records.'
      when 'timeline' then 'Place the historical evidence in sequence.'
      when 'infographic' then 'Summarize the documented findings.'
      when 'relationship' then 'Show relationships recorded in the research.'
      when 'photo' then 'Reference the licensed fixture media.'
      else 'Illustrate a documented concept with a synthetic image.' end),
    'snapshot',jsonb_build_object('capturedAt',to_char(captured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'observedOn',r.observed_on,'dataDigest',c.asset->'digest'),
    'licence',(c.asset->'licence')||jsonb_build_object(
      'status',case when c.asset#>>'{licence,status}'='missing' and m.asset_id=v.asset_id and m.valid_until<=captured_at then 'expired'
        else c.asset#>>'{licence,status}' end,
      'terms',coalesce(nullif(left(trim(m.terms),400),''),
        case when r.asset_version_id is null then 'Use under the linked Stage 5B source acquisition terms.'
          else 'Use requires an active media grant for this exact asset version.' end),
      'validUntil',to_char(m.valid_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ) order by c.position),'[]')
  from jsonb_array_elements(candidates) with ordinality c(asset,position)
  join media.newsroom_fixture_visual_records r on r.id=(c.asset->>'id')::uuid
  left join media.asset_versions v on v.id=r.asset_version_id
  left join media.licences m on m.id=r.licence_id
$$;

create function editorial.fixture_visual_quality(asset jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  has_evidence boolean := (jsonb_array_length(asset->'evidenceIds')>0 and jsonb_array_length(asset->'documentIds')>0) is true;
  accurate boolean := (editorial.fixture_eligible_visual(jsonb_set(asset,'{licence,status}','"active"'))
    and has_evidence and asset#>'{snapshot,dataDigest}'=asset->'digest') is true;
  licensed boolean := (asset#>>'{licence,status}'='active' and nullif(trim(asset#>>'{licence,reference}'),'') is not null) is true;
  secure boolean := asset::text !~* '<[[:space:]]*(script|iframe|object|embed)\M|javascript[[:space:]]*:';
  ratings jsonb;
  score numeric;
  critical text[] := '{}';
begin
  ratings:=jsonb_build_object(
    'factual_and_data_accuracy',case when accurate then 100 else 0 end,
    'geographical_accuracy',case when asset#>>'{data,kind}'='map' then case when accurate then 100 else 0 end end,
    'clarity',case when nullif(trim(asset->>'title'),'') is not null and nullif(trim(asset->>'purpose'),'') is not null
      and nullif(trim(asset->>'caption'),'') is not null and char_length(asset->>'caption')<=180 then 100 else 40 end,
    'editorial_relevance',case when has_evidence then 100 else 0 end,
    'accessibility',case when nullif(trim(asset->>'alt'),'') is not null and char_length(asset->>'alt')<=160 then 100 else 30 end,
    'attribution_and_licensing',case when licensed then 100 else 0 end,
    'brand_consistency',100);
  select round(sum((ratings->>w.factor)::numeric*w.weight)/sum(w.weight),2) into score from (values
    ('factual_and_data_accuracy',30),('geographical_accuracy',20),('clarity',15),('editorial_relevance',10),
    ('accessibility',10),('attribution_and_licensing',10),('brand_consistency',5)
  ) w(factor,weight) where ratings->>w.factor is not null;
  if not accurate then critical:=array_append(critical,'accuracy'); end if;
  if not licensed then critical:=array_append(critical,'licensing'); end if;
  if not secure then critical:=array_append(critical,'security'); end if;
  return jsonb_build_object('ratings',ratings,'score',score,'critical',to_jsonb(critical));
end
$$;

alter function editorial.fixture_visual_manifest(jsonb) rename to fixture_visual_manifest_v1;

create function editorial.fixture_visual_manifest(packet jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with assessed as (
    select c.asset,c.position,editorial.fixture_visual_quality(c.asset) as quality
    from jsonb_array_elements(packet->'candidates') with ordinality c(asset,position)
  ), assets as (
    select *,quality->'critical'='[]'::jsonb and (quality->>'score')::numeric>=85 as eligible from assessed
  )
  select case when packet->'qualityRubric' is distinct from '1'::jsonb then editorial.fixture_visual_manifest_v1(packet)
    else jsonb_build_object(
      'assets',coalesce(jsonb_agg(asset||jsonb_build_object('quality',quality) order by position) filter (where eligible),'[]'),
      'blockedAssetIds',coalesce(jsonb_agg(asset->'id' order by position) filter (where not eligible),'[]'),
      'layout',jsonb_build_object('responsive',true,'foreground','--ink','accent','--accent','fallback','text_and_data')
    ) end from assets
$$;

alter function editorial.fixture_production_input(uuid,jsonb) rename to fixture_production_input_v1;

create function editorial.fixture_production_input(target_run uuid,task jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  packet jsonb := editorial.fixture_production_input_v1(target_run,task);
  stage_name text := packet->>'stage';
  revisions jsonb;
begin
  if stage_name='editorial' then return packet||jsonb_build_object('reviewSpec',2); end if;
  if stage_name not in ('writing','visual') then return packet; end if;
  select coalesce(jsonb_agg(c.item order by c.position),'[]') into revisions
  from ai_ops.agent_tasks t join editorial.newsroom_edition_reviews r on r.attempt_id=t.revision_attempt_id
  cross join lateral jsonb_array_elements(r.payload->'issues') with ordinality c(item,position)
  where t.id=(task->>'taskId')::uuid and c.item->>'agentId'=task->>'agentId';
  packet:=packet||jsonb_build_object('revisionIssues',revisions);
  if stage_name='writing' then
    return packet||jsonb_build_object('classification',editorial.fixture_draft_classification(target_run));
  end if;
  return packet||jsonb_build_object('qualityRubric',1,'candidates',
    editorial.fixture_visual_descriptions(packet->'candidates',statement_timestamp()));
end
$$;

create function editorial.fixture_revision_detail(packet jsonb,issue_code text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  section_ref text;
  problem text;
  gap text;
  affected jsonb;
  evidence jsonb := '[]';
  pattern text;
begin
  select i.section_ref,i.problem,i.gap into strict section_ref,problem,gap from (values
    ('rights','edition_rights','The edition contains a blocked asset or its rights check failed.','Confirm an active rights grant for the affected source or media version.'),
    ('privacy','edition_content','The edition contains a private contact detail.',null),
    ('security','edition_content','The edition contains active markup or an executable link.',null),
    ('unverified_claim','proposed_claims','A proposed factual addition is unresolved.','Eligible evidence has yet to verify the proposed claim.'),
    ('invalid_grounding','edition_verification','The edition and verification records do not agree.','A verification record bound to this exact edition is required.'),
    ('missing_history','deep_dive:history','The Deep Dive lacks a sourced historical section.','The edition omits the relevant historical evidence.'),
    ('missing_analysis','deep_dive:analysis_and_scenarios','The Deep Dive lacks sourced analysis or a conditional scenario.','The edition omits the relevant analysis or scenario evidence.'),
    ('missing_visuals','visual_package','The edition contains zero eligible visuals.','An accessible, source-backed visual is required.'),
    ('source_balance','source_register','The edition lacks an attributable independent source.','Source independence is unestablished for the available evidence.'),
    ('below_threshold','editorial_quality','The weighted editorial score is below 85.',null)
  ) i(code,section_ref,problem,gap) where i.code=issue_code;
  if issue_code='rights' then
    select jsonb_agg(jsonb_build_object('kind','visual','ref',v.id) order by v.position) into affected
      from jsonb_array_elements_text(packet#>'{visual,blockedAssetIds}') with ordinality v(id,position);
  elsif issue_code='unverified_claim' then
    with unresolved as (
      select p.item,p.position from jsonb_array_elements(packet#>'{article,proposedClaims}') with ordinality p(item,position)
      where not exists (select 1 from jsonb_array_elements(packet->'material') m where m->>'frame'='verified_fact'
        and m->'text'=p.item->'statement' and m->'evidenceIds'=p.item->'evidenceIds')
    )
    select (select jsonb_agg(jsonb_build_object('kind','claim','ref','proposal:'||u.position) order by position) from unresolved u),
      (select coalesce(jsonb_agg(id order by id),'[]') from (
        select distinct e.id from unresolved u cross join lateral jsonb_array_elements_text(u.item->'evidenceIds') e(id)
        order by e.id limit 48
      ) citations) into affected,evidence;
  elsif issue_code in ('missing_history','missing_analysis') then
    select coalesce(jsonb_agg(id order by id),'[]') into evidence from (
      select distinct e.id from jsonb_array_elements(packet->'material') m
      cross join lateral jsonb_array_elements_text(m->'evidenceIds') e(id)
      where m->>'section'=case issue_code when 'missing_history' then 'history' else 'analysis' end
        or (issue_code='missing_analysis' and m->>'section'='scenarios')
      order by e.id limit 48
    ) citations;
  elsif issue_code in ('privacy','security') then
    pattern:=case issue_code when 'privacy' then '[[:alnum:]_.+-]+@[[:alnum:]_-]+([.][[:alnum:]_-]+)+'
      else '<[[:space:]]*(script|iframe|object|embed)\M|javascript[[:space:]]*:' end;
    with targets as (
      select 'visual' as kind,v.item->>'id' as ref,v.item->'evidenceIds' as ids,1 as priority,v.position as row_no,0::bigint as part
      from jsonb_array_elements(packet#>'{visual,assets}') with ordinality v(item,position)
      where v.item::text ~* pattern
      union all
      select 'section',(a.item->>'format')||':summary','[]',2,a.position,0
      from jsonb_array_elements(packet#>'{article,articles}') with ordinality a(item,position)
      where (a.item-array['format','sections'])::text ~* pattern
      union all
      select 'section',(a.item->>'format')||':'||(s.item->>'kind'),
        coalesce((select jsonb_agg(x) from jsonb_path_query(s.item,'$.blocks[*].evidenceIds[*]') x),'[]'),2,a.position,s.position
      from jsonb_array_elements(packet#>'{article,articles}') with ordinality a(item,position)
      cross join lateral jsonb_array_elements(a.item->'sections') with ordinality s(item,position)
      where s.item::text ~* pattern
      union all
      select 'claim','proposal:'||p.position,p.item->'evidenceIds',3,p.position,0
      from jsonb_array_elements(packet#>'{article,proposedClaims}') with ordinality p(item,position)
      where p.item::text ~* pattern
    )
    select (select jsonb_agg(jsonb_build_object('kind',kind,'ref',ref) order by priority,row_no,part)
      from (select * from targets order by priority,row_no,part limit 16) refs),
      (select coalesce(jsonb_agg(id order by id),'[]') from (
        select distinct e.id from targets t cross join lateral jsonb_array_elements_text(t.ids) e(id)
        order by e.id limit 48
      ) citations) into affected,evidence;
  end if;
  return jsonb_build_object('affected',coalesce(affected,jsonb_build_array(jsonb_build_object('kind','section','ref',section_ref))),
    'problem',problem,'evidenceIds',evidence,'evidenceGap',gap,'blocksPublication',true);
end
$$;

alter function editorial.fixture_review_payload(jsonb,boolean) rename to fixture_review_payload_v1;

create function editorial.fixture_review_payload(packet jsonb,rights_active boolean) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  report jsonb := editorial.fixture_review_payload_v1(packet,rights_active);
  ratings jsonb := report->'ratings';
  issues jsonb := report->'issues';
  decision text := report->>'decision';
  score numeric;
  writing_rating integer;
  visual_rating integer;
begin
  if packet->>'stage' is distinct from 'editorial' or packet->'reviewSpec' is distinct from '2'::jsonb then return report; end if;
  writing_rating:=case when exists (
    select 1 from jsonb_array_elements(packet#>'{article,articles}') a
    cross join lateral (select editorial.fixture_article_guideline(a->>'format') as guideline) g
    where (a->>'wordCount')::int<(g.guideline->>'minWords')::int
      or ((g.guideline->>'allowsLonger')::boolean is false and (a->>'wordCount')::int>(g.guideline->>'maxWords')::int)
  ) then 90 else 100 end;
  select coalesce(floor(min(coalesce((a#>>'{quality,score}')::numeric,100))),60) into visual_rating
    from jsonb_array_elements(packet#>'{visual,assets}') a;
  score:=(report->>'score')::numeric+(writing_rating-(ratings->>'writing_quality')::int)*0.10
    +(visual_rating-(ratings->>'visual_accuracy_and_quality')::int)*0.05;
  ratings:=ratings||jsonb_build_object('writing_quality',writing_rating,'visual_accuracy_and_quality',visual_rating);
  if score<85 and decision='ready_for_human_review' then
    issues:=jsonb_build_array(editorial.fixture_issue('below_threshold'));
    decision:='major_revision';
  end if;
  select coalesce(jsonb_agg(i.item||jsonb_build_object('detail',
    editorial.fixture_revision_detail(packet,i.item->>'code')) order by i.position),'[]') into issues
    from jsonb_array_elements(issues) with ordinality i(item,position);
  return report||jsonb_build_object('ratings',ratings,'score',score,'decision',decision,'issues',issues);
end
$$;

revoke all on function editorial.fixture_article_guideline(text),editorial.fixture_draft_classification(uuid),
  editorial.fixture_draft_metadata(jsonb,text),editorial.fixture_valid_writing(jsonb,jsonb),
  editorial.fixture_visual_descriptions(jsonb,timestamptz),editorial.fixture_visual_quality(jsonb),
  editorial.fixture_visual_manifest(jsonb),editorial.fixture_production_input(uuid,jsonb),
  editorial.fixture_revision_detail(jsonb,text),editorial.fixture_review_payload(jsonb,boolean)
  from public,anon,authenticated,service_role;
