import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseLeads } from "../../src/ingestion/adapters.ts";
import { fixturePayloads } from "../../src/ingestion/fixtures.ts";
import { normalize } from "../../src/ingestion/normalize.ts";
import { analysisMaterial, historyMaterial, verificationMaterial, evidence, observation, fixtureId } from "../fixtures/research.ts";
import { quote, seedEndpoint, sql } from "./newsroom-fixtures.mjs";

export async function ingestResearchFixture(ingestion, variant = "complete") {
  const cluster = "research-exercise-" + randomUUID();
  const cycle = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  for (const adapter of ["gdelt", "rss"]) {
    const endpoint = seedEndpoint({ adapter, enabled: true });
    const run = await ingestion("begin_discovery", { source_endpoint: endpoint, cycle_time: cycle });
    assert.equal(run.fixture, true);
    const leads = parseLeads(adapter, fixturePayloads[adapter]);
    const docs = (await Promise.all(leads.map((lead) => normalize(lead, adapter)))).filter(Boolean);
    const documents = docs.map((doc) => ({
      ...doc, cluster, occurredAt: new Date().toISOString(),
      title: "Synthetic Lagos coastal relief exercise " + (adapter === "gdelt" ? "dispatch" : "follow-up"),
    }));
    assert.equal(await ingestion("finish_discovery", { target_run: run.id, documents }), "complete");
  }

  const event = sql(`select event_id from news.discovery_clusters where cluster_key=${quote("fixture:" + cluster)};`);
  assert.match(event, /^[a-f0-9-]{36}$/);
  const sourceIds = sql(`select p.document_id from news.event_documents ed join news.discovery_provenance p on p.document_id=ed.document_id
    where ed.event_id=${quote(event)} order by (p.origin='associated-press'),p.canonical_url;`).split("\n");
  assert.equal(sourceIds.length, 3);
  assert.ok(sourceIds.every((id) => /^[a-f0-9-]{36}$/.test(id)));
  const sources = sourceIds.map((documentId) => ({ documentId }));
  const annotated = verificationMaterial(sources);
  if (variant === "sensitive" || variant === "conflict") {
    annotated[0].annotation.atoms[0].sensitive = true;
    if (variant === "sensitive") annotated.splice(1, 2);
    else annotated.push(evidence(79, sourceIds[1], observation(fixtureId(21), "750 households"), "Conflicting synthetic source lists 750 households."));
  }
  const notes = [...historyMaterial(sources), ...annotated, ...analysisMaterial(sources)];
  const rows = notes.map(({ documentId, locator, excerpt, annotation }) => [
    quote(event), quote(documentId), quote(locator), quote(excerpt), quote(JSON.stringify(annotation)) + "::jsonb",
  ].join(",")).map((row) => "(" + row + ")").join(",\n");
  sql(`insert into research.newsroom_fixture_evidence(event_id,document_id,locator,excerpt,annotation) values ${rows};
    update news.discovery_ranks set score_components=score_components||'{"historical":90}'::jsonb
      where event_id=${quote(event)};`);
  return { event, sourceIds };
}

export function researchRunFor(event) {
  return sql(`select id from ai_ops.workflow_runs where fixture_event_id=${quote(event)} and research_only;`);
}
