import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { executeFixture } from "../../src/newsroom/execution.ts";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { createOpenAIFixtureProvider } from "../../src/providers/openai-fixture.server.ts";
import { api, quote, sql } from "./newsroom-fixtures.mjs";
import { ingestResearchFixture, researchRunFor } from "./research-fixtures.mjs";

const provider = createOpenAIFixtureProvider();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/H1kAAAAASUVORK5CYII=", "base64");

export function attemptLease(item) {
  return { target_run: item.task.runId, target_attempt: item.task.attemptId };
}

export async function fixtureResult(item) {
  const result = await executeFixture(item, provider);
  assert.ok(!("failure" in result), item.task.stage + " returned " + JSON.stringify(result));
  return result;
}

export async function runResearchFixture(operator, ingestion) {
  const { event } = await ingestResearchFixture(ingestion);
  await operator("scan_newsroom_fixtures", { research_mode: true, prompt_manifest: promptManifest });
  const run = researchRunFor(event);
  assert.match(run, /^[a-f0-9-]{36}$/);
  for (let step = 0; step < 4; step++) {
    const { claims } = await operator("claim_newsroom_fixtures", { target_run: run });
    assert.ok(claims.length);
    for (const item of claims) {
      const lease = attemptLease(item);
      assert.ok(await operator("start_newsroom_fixture", lease));
      const result = await fixtureResult(item);
      await operator("finish_newsroom_fixture", { ...lease, result: result.output, research_result: result.researchResult,
        in_tokens: result.inputTokens, out_tokens: result.outputTokens });
    }
    const status = await operator("newsroom_fixture_status", { target_run: run });
    if (status.state === "research_ready") return { event, run };
  }
  assert.fail("Synthetic research failed to reach the editorial handoff.");
}

async function privateAsset(adminKey, label) {
  const key = "synthetic/edition-" + randomUUID() + ".png";
  const response = await fetch(api + "/storage/v1/object/editorial-private/" + key, {
    method: "POST", headers: { apikey: adminKey, authorization: "Bearer " + adminKey, "content-type": "image/png" },
    body: png, signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, "synthetic media upload returned " + response.status);
  const digest = createHash("sha256").update(png).digest("hex");
  return JSON.parse(sql(
    `with asset as (insert into media.assets(label) values (${quote(label)}) returning id),
      version as (insert into media.asset_versions(asset_id,version,object_key,storage_version,digest)
        select a.id,1,o.name,o.version,decode(${quote(digest)},'hex')
        from asset a cross join storage.objects o where o.bucket_id='editorial-private' and o.name=${quote(key)} returning id),
      licence as (insert into media.licences(asset_id,terms,valid_from)
        select id,'Synthetic test licence',now()-interval '1 hour' from asset returning id)
    select jsonb_build_object('version',v.id,'licence',l.id) from version v cross join licence l;`
  ));
}

export async function seedEditorialVisuals(operator, fixture, adminKey, {
  includeMedia = true, includeDerived = true, expirePhoto = false, omitIllustrationGrant = false,
} = {}) {
  const findings = await operator("newsroom_research_findings", { target_run: fixture.run });
  const [history, verification, analysis] = ["history", "verification", "analysis"].map((role) =>
    findings.find(({ payload }) => payload.stage === role).payload);
  const dated = history.timeline[0];
  const numeric = verification.claims.find(({ type }) => type === "number");
  const alliance = analysis.alliances[0];
  const captions = {
    map: "Synthetic geographic reference for the coastal exercise",
    chart: "Households recorded in the synthetic exercise",
    timeline: "Earlier synthetic coastal coordination in the archive",
    infographic: "Verified statements about the synthetic exercise",
    relationship: "A documented relationship in the synthetic planning archive",
    photo: "Synthetic licensed media placeholder",
    illustration: "AI-generated synthetic illustration of a record register",
  };
  const derived = [
    [{ kind: "map", renderer: "maplibre", basemap: "stadia_disabled", geojson: {
      type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [3.38, 6.52] },
        properties: { name: "Synthetic coastal study area", accuracy: "approximate", boundary: "disputed" } }],
    } }, dated.evidenceIds, "Approximate fixture location. Disputed boundary classification is part of the simulated record."],
    [{ kind: "chart", scale: "linear", baseline: 0, unit: "households",
      values: [{ label: "Synthetic exercise", claimId: numeric.claimId, value: 1200 }] },
    numeric.supporting.evidenceIds, "A single measured exercise. Regional coverage is unknown."],
    [{ kind: "timeline", entries: [{
      label: dated.statement, startYear: dated.period.earliestYear, endYear: dated.period.latestYear, certainty: dated.period.certainty,
    }] }, dated.evidenceIds, "Date ranges preserve the uncertainty of the archival record."],
    [{ kind: "infographic", points: [numeric.normalizedClaim] }, numeric.supporting.evidenceIds, "The figure covers the synthetic exercise."],
    [{ kind: "relationship", nodes: ["Synthetic board", "Local coordinators"],
      links: [{ from: "Synthetic board", to: "Local coordinators", relationship: alliance.statement }] },
    alliance.evidenceIds, "The link shows a documented objective within the fixture."],
  ];
  const metadata = includeDerived ? derived : [];
  let photo;
  if (includeMedia) {
    photo = await privateAsset(adminKey, "Synthetic licensed fixture media");
    const illustration = await privateAsset(adminKey, "Mock AI illustration fixture");
    if (expirePhoto) sql(`update media.licences set valid_until=clock_timestamp()-interval '10 minutes' where id=${quote(photo.licence)};`);
    metadata.push(
      [{ kind: "photo", assetVersionId: photo.version, disclosure: "Synthetic licensed media fixture" }, dated.evidenceIds,
        "Placeholder media depicts no real event.", photo],
      [{ kind: "illustration", assetVersionId: illustration.version, disclosure: "AI-generated synthetic illustration" }, dated.evidenceIds,
        "Synthetic illustration represents a concept. It supplies no documentary finding.",
        omitIllustrationGrant ? { ...illustration, licence: null } : illustration],
    );
  }
  const ids = {};
  for (const [data, evidence, uncertainty, reference] of metadata) {
    const evidenceIds = "array[" + evidence.map(quote).join(",") + "]::uuid[]";
    const alt = data.kind === "chart" ? "One bar at 1,200 households with an axis starting at zero."
      : data.kind === "map" ? "A single approximate point within the synthetic coastal study area." : captions[data.kind] + ".";
    ids[data.kind] = sql(`insert into media.newsroom_fixture_visual_records(event_id,data,caption,alt,uncertainty,
      evidence_ids,asset_version_id,licence_id,title,purpose) values(${quote(fixture.event)},${quote(JSON.stringify(data))},${quote(captions[data.kind])},
        ${quote(alt)},${quote(uncertainty)},${evidenceIds},${reference ? quote(reference.version) : "null"},
        ${reference?.licence ? quote(reference.licence) : "null"},${quote(captions[data.kind])},'Explain this synthetic fixture evidence') returning id;`);
  }
  return { ids, photo };
}
