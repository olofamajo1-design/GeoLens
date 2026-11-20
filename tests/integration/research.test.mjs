import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { executeFixture } from "../../src/newsroom/execution.ts";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { createOpenAIFixtureProvider } from "../../src/providers/openai-fixture.server.ts";
import { allScores, localSupabase, quote, seedDiscoveryRun, seedEndpoint, seedRankedEvent, sql } from "../helpers/newsroom-fixtures.mjs";
import { ingestResearchFixture, researchRunFor } from "../helpers/research-fixtures.mjs";

const mock = createOpenAIFixtureProvider();
const legacy = { synthetic: true, disposition: "complete", summary: "Synthetic legacy output.", revisionStage: null };

test("the research fixture pipeline persists four scoped, evidence-backed agents in local Supabase", { timeout: 120_000 }, async (t) => {
  const { createUser, response, caller } = localSupabase();
  const token = await createUser("newsroom_operator");
  const rpc = caller(token);
  const ingestion = caller(await createUser("ingestion_operator"));
  const scan = () => rpc("scan_newsroom_fixtures", { prompt_manifest: promptManifest, research_mode: true });
  const claim = (target_run) => rpc("claim_newsroom_fixtures", { target_run });
  const status = (target_run) => rpc("newsroom_fixture_status", { target_run });
  const findings = (target_run) => rpc("newsroom_research_findings", { target_run });
  const lease = ({ task }) => ({ target_run: task.runId, target_attempt: task.attemptId });
  const start = (item) => rpc("start_newsroom_fixture", lease(item));
  const result = async (item) => {
    const response = await executeFixture(item, mock);
    assert.ok(!("failure" in response), JSON.stringify(response));
    return response;
  };
  const finish = (item, outcome) => rpc("finish_newsroom_fixture", {
    ...lease(item), result: outcome.output, research_result: outcome.researchResult,
    in_tokens: outcome.inputTokens, out_tokens: outcome.outputTokens,
  });
  const run = async (item) => {
    assert.ok(await start(item));
    return finish(item, await result(item));
  };
  const enroll = async (variant) => {
    const { event, sourceIds } = await ingestResearchFixture(ingestion, variant);
    await scan();
    const runId = researchRunFor(event);
    assert.match(runId, /^[a-f0-9-]{36}$/);
    return { event, runId, sourceIds };
  };
  const cancelled = (target_run) => rpc("cancel_newsroom_fixture", { target_run });

  const spendFilter = "scope='development' and month=date_trunc('month',now() at time zone 'UTC')::date";
  const priorSpend = sql(`select amount_minor from ai_ops.discovery_usage where ${spendFilter};`);
  sql(`update ai_ops.discovery_usage set amount_minor=0 where ${spendFilter};`);
  try {
    await t.test("reuses ingestion and records licensed, deduplicated findings with the approved dependency order", async () => {
      const { event, runId } = await enroll();
      await Promise.all([scan(), scan()]);
      const [discovery] = (await claim(runId)).claims;
      assert.equal(discovery.researchInput.sources.length, 3);
      assert.equal(discovery.promptVersion, 2);
      assert.equal(discovery.task.stage, "discovery");
      assert.equal((await claim(runId)).claims.length, 0);
      assert.equal(await run(discovery), "succeeded");

      const parallel = (await claim(runId)).claims;
      assert.deepEqual(parallel.map(({ task }) => task.stage).sort(), ["history", "verification"]);
      const history = parallel.find(({ task }) => task.stage === "history");
      const verify = parallel.find(({ task }) => task.stage === "verification");
      assert.equal(history.researchInput.depth, "deep");
      assert.ok(!("history" in verify.researchInput));
      assert.ok(!("scores" in verify.researchInput));
      assert.equal(await run(history), "succeeded");
      assert.equal((await claim(runId)).claims.length, 0);
      assert.equal(await run(verify), "succeeded");

      const [analysis] = (await claim(runId)).claims;
      assert.equal(analysis.task.stage, "analysis");
      assert.equal(analysis.researchInput.history.researchId, history.task.attemptId);
      assert.equal(analysis.researchInput.verification.verificationId, verify.task.attemptId);
      assert.ok(await start(analysis));
      const altered = await result(analysis);
      altered.researchResult.scenarios.escalation.outcome = "Unsubstantiated outcome using a real evidence identifier.";
      assert.equal(await finish(analysis, altered), "retry");
      sql(`update ai_ops.agent_tasks set available_at=now()-interval '1 second' where id=${quote(analysis.task.taskId)};`);
      const [analysisRetry] = (await claim(runId)).claims;
      assert.equal(await run(analysisRetry), "research_ready");
      assert.deepEqual((await claim(runId)).claims, []);
      const state = await status(runId);
      assert.equal(state.state, "research_ready");
      assert.deepEqual(state.tasks.map(({ stage }) => stage).sort(), ["analysis", "discovery", "history", "verification"]);
      assert.ok(state.tasks.every(({ attempts }) => attempts[0].actualMinor === 0 && attempts[0].estimatedMicros > 0));

      const saved = await findings(runId);
      assert.equal(saved.length, 4);
      assert.ok(saved.every(({ payload }) => payload.synthetic && payload.eventId === event));
      assert.deepEqual(saved[0].payload.duplicateGroups.map(({ documentIds }) => documentIds.length), [2]);
      assert.equal(saved[0].payload.independentSourceCount, 2);
      assert.ok(saved.every(({ sources }) => sources.length && sources.every(({ attribution }) => /Synthetic/.test(attribution))));
      const historyResult = saved.find(({ payload }) => payload.stage === "history");
      assert.ok(historyResult.evidence.some(({ id }) => historyResult.payload.timeline[0].evidenceIds.includes(id)));
      const analysisResult = saved.find(({ payload }) => payload.stage === "analysis");
      assert.equal(analysisResult.payload.establishedFacts.length, 4);
      assert.equal(analysisResult.payload.scenarios.escalation.framing, "conditional_forecast");
      assert.ok(analysisResult.evidence.length >= 10);
      assert.equal(sql(`select count(*) from editorial.story_versions v join ai_ops.workflow_runs w
        on v.story_id=w.fixture_story_id where w.id=${quote(runId)};`), "0");
      assert.equal(sql(`select count(*) from governance.audit_events where action='newsroom.research_finding_saved'
        and details->>'run_id'=${quote(runId)};`), "4");
    });

    await t.test("keeps findings private and prevents a generic Stage 5A result or fabricated citation from settling a research lease", async () => {
      const { runId } = await enroll();
      const member = await createUser();
      for (const credential of [undefined, member]) {
        const denied = await response("newsroom_research_findings", { target_run: runId }, credential);
        assert.ok(denied.status === 401 || denied.status === 403);
      }
      const [discovery] = (await claim(runId)).claims;
      assert.ok(await start(discovery));
      assert.equal(await rpc("finish_newsroom_fixture", { ...lease(discovery), result: legacy, in_tokens: 1, out_tokens: 1 }), "retry");
      assert.deepEqual(await findings(runId), []);
      sql(`update ai_ops.agent_tasks set available_at=now()-interval '1 second' where id=${quote(discovery.task.taskId)};`);
      const [retry] = (await claim(runId)).claims;
      assert.equal(await run(retry), "succeeded");

      const history = (await claim(runId)).claims.find(({ task }) => task.stage === "history");
      assert.ok(await start(history));
      const bad = await result(history);
      bad.researchResult.timeline[0].evidenceIds = [randomUUID()];
      assert.equal(await finish(history, bad), "retry");
      assert.deepEqual((await findings(runId)).map(({ payload }) => payload.stage), ["discovery"]);
      assert.ok(await cancelled(runId));
    });

    await t.test("critical unsupported allegations cannot be overridden by a successful generic disposition", async () => {
      const { runId } = await enroll("sensitive");
      assert.equal(await run((await claim(runId)).claims[0]), "succeeded");
      const verification = (await claim(runId)).claims.find(({ task }) => task.stage === "verification");
      assert.ok(await start(verification));
      const unsupported = await result(verification);
      unsupported.output = legacy;
      assert.equal(await finish(verification, unsupported), "escalated");
      assert.equal(await finish(verification, unsupported), "stale");
      assert.equal((await claim(runId)).state, "escalated");
      assert.equal((await status(runId)).reason, "critical_finding:verification");
      const saved = await findings(runId);
      const check = saved.find(({ payload }) => payload.stage === "verification");
      assert.match(check.payload.claims.find(({ sensitive }) => sensitive).verdict, /^unverified$/);
      assert.equal(saved.some(({ payload }) => payload.stage === "analysis"), false);
    });

    await t.test("detects an attempt to hide a licensed contradiction behind a verified sensitive claim", async () => {
      const { runId } = await enroll("conflict");
      assert.equal(await run((await claim(runId)).claims[0]), "succeeded");
      const verification = (await claim(runId)).claims.find(({ task }) => task.stage === "verification");
      assert.ok(await start(verification));
      const misleading = await result(verification);
      const fraud = misleading.researchResult.claims.find(({ sensitive }) => sensitive);
      assert.equal(fraud.verdict, "partially_accurate");
      fraud.verdict = "verified";
      fraud.recommendedAction = "retain";
      fraud.contradictory.evidenceIds = [];
      assert.equal(await finish(verification, misleading), "retry");
      assert.equal((await findings(runId)).length, 1);
      assert.ok(await cancelled(runId));
    });

    await t.test("does not settle results from licences revoked after the packet was leased", async () => {
      const { runId, sourceIds } = await enroll();
      const [item] = (await claim(runId)).claims;
      assert.ok(await start(item));
      sql(`update news.acquisition_licences set revoked_at=clock_timestamp() where id in (
        select licence_id from news.discovery_provenance where document_id=${quote(sourceIds[0])}
      );`);
      assert.equal(await finish(item, await result(item)), "retry");
      assert.deepEqual(await findings(runId), []);
      assert.ok(await cancelled(runId));
    });

    await t.test("low-priority or uncorroborated discovery stays in triage according to the Orchestrator decision", async () => {
      const endpoint = seedEndpoint();
      const ingest = seedDiscoveryRun(endpoint);
      const archivedEvent = seedRankedEvent(ingest, { scores: allScores(10), origins: 0 });
      const blockedLive = seedRankedEvent(seedDiscoveryRun(seedEndpoint({ fixture: false })), { fixture: false });
      await scan();
      assert.equal(researchRunFor(blockedLive), "");
      const runId = researchRunFor(archivedEvent);
      const [item] = (await claim(runId)).claims;
      assert.equal(await run(item), "triaged");
      assert.equal((await claim(runId)).state, "triaged");
      const saved = await findings(runId);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].payload.recommendation, "archive");
    });
  } finally {
    if (priorSpend) sql(`update ai_ops.discovery_usage set amount_minor=${Number(priorSpend)} where ${spendFilter};`);
  }
});
