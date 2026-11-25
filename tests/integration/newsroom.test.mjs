import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { promptManifest as manifest } from "../../src/newsroom/generated/prompts.mjs";
import {
  addFixtureRank, allScores, localSupabase, quote, seedDiscoveryRun, seedEndpoint, seedRankedEvent, sql, workflowFor,
} from "../helpers/newsroom-fixtures.mjs";

const complete = { synthetic: true, disposition: "complete", summary: "Synthetic fixture completed.", revisionStage: null };
const revision = (revisionStage) => ({ ...complete, disposition: "revision_requested", revisionStage });
const month = "date_trunc('month',now() at time zone 'UTC')::date";

test("local Supabase orchestrates fixture agents and preserves editorial boundaries", { timeout: 120_000 }, async (t) => {
  const { createUser, response, caller } = localSupabase();
  const token = await createUser("newsroom_operator");
  const rpc = caller(token);
  const endpoint = seedEndpoint();
  const discovery = seedDiscoveryRun(endpoint);
  const scan = () => rpc("scan_newsroom_fixtures", { prompt_manifest: manifest });
  const claim = (target_run) => rpc("claim_newsroom_fixtures", { target_run });
  const status = (target_run) => rpc("newsroom_fixture_status", { target_run });
  const cancel = (target_run) => rpc("cancel_newsroom_fixture", { target_run });
  const lease = ({ task }) => ({ target_run: task.runId, target_attempt: task.attemptId });
  const start = (item) => rpc("start_newsroom_fixture", lease(item));
  const finish = (item, result = complete, usage = { in_tokens: 80, out_tokens: 20 }) =>
    rpc("finish_newsroom_fixture", { ...lease(item), result, ...usage });
  const failure = (item, code) => rpc("finish_newsroom_fixture", { ...lease(item), failure: code });
  const runFixture = async (ranking) => {
    const event = seedRankedEvent(discovery, ranking);
    await scan();
    const run = workflowFor(event);
    assert.match(run, /^[a-f0-9-]{36}$/);
    return run;
  };
  const execute = async (item, output) => {
    assert.equal(await start(item), true);
    return finish(item, output);
  };

  sql(`insert into ai_ops.discovery_usage(month,scope,amount_minor) values (${month},'development',0) on conflict do nothing;`);
  const previousSpend = sql(`select amount_minor from ai_ops.discovery_usage where scope='development' and month=${month};`);
  const setSpend = (value) => sql(`update ai_ops.discovery_usage set amount_minor=${value} where scope='development' and month=${month};`);
  setSpend(0);
  try {
    await t.test("only the scoped operator can drive fixtures and no operator can approve or publish", async () => {
      const member = await createUser();
      for (const credential of [undefined, member]) {
        const denied = await response("scan_newsroom_fixtures", { prompt_manifest: manifest }, credential);
        assert.ok(denied.status === 401 || denied.status === 403);
      }
      assert.equal((await response("newsroom_fixture_review_queue", {}, token)).status, 403);
      const target_version = randomUUID();
      const expected_digest = "0".repeat(64);
      assert.equal((await response("release_version", { target_version, expected_digest, operation_id: randomUUID() }, token)).status, 403);
      assert.equal((await response("record_review", {
        target_version, expected_digest, review_kind: "verification", target_attempt: randomUUID(), passed: true,
      }, token)).status, 403);
      assert.equal(sql(`select has_table_privilege('authenticated','ai_ops.newsroom_assessments','select')
        or has_table_privilege('authenticated','ai_ops.task_attempts','insert');`), "f");
      await scan();
      const altered = manifest.map((entry, index) => index === 0 ? { ...entry, digest: expected_digest } : entry);
      const mismatch = await response("scan_newsroom_fixtures", { prompt_manifest: altered }, token);
      assert.equal(mismatch.status, 400);
      assert.match(await mismatch.text(), /Fixture prompt version digest mismatch/);
    });

    await t.test("weights, priority boundaries, prompt pins and significance use only eligible discovery fixtures", async () => {
      const cases = [
        [85, "critical"], [84.99, "high"], [70, "high"], [69.99, "standard"], [55, "standard"],
        [54.99, "monitor"], [40, "monitor"], [39.99, "archive"],
      ].map(([value, priority]) => ({ event: seedRankedEvent(discovery, { scores: allScores(value) }), priority }));
      const weak = seedRankedEvent(discovery, {
        scores: { impact: 90, evidence: 20, urgency: 60, regional: 80, historical: 10 }, origins: 1,
      });
      const urgentVerification = seedRankedEvent(discovery, { scores: { ...allScores(0), impact: 90 }, origins: 0 });
      const low = seedRankedEvent(discovery, { scores: allScores(10) });
      const live = seedRankedEvent(seedDiscoveryRun(seedEndpoint({ fixture: false })), { fixture: false });
      const wrongEndpoint = seedRankedEvent(seedDiscoveryRun(seedEndpoint({ fixture: false })));
      await Promise.all([scan(), scan()]);
      const assessment = (event, expression) => sql(`select ${expression} from ai_ops.newsroom_assessments where event_id=${quote(event)};`);
      for (const { event, priority } of cases) assert.equal(assessment(event, "priority"), priority);
      assert.equal(assessment(weak, "score"), "57.00");
      const run = workflowFor(weak);
      assert.equal((await status(run)).verificationAttention, true);
      assert.equal((await claim(run)).claims[0].task.verificationAttention, true);
      assert.equal(assessment(live, "priority"), "");
      assert.equal(assessment(wrongEndpoint, "priority"), "");
      assert.equal(assessment(urgentVerification, "priority"), "archive");
      assert.equal((await status(workflowFor(urgentVerification))).verificationAttention, true);
      assert.equal(workflowFor(low), "");
      assert.equal(sql(`select count(*) from ai_ops.workflow_runs where fixture_event_id=${quote(weak)};`), "1");
      const first = assessment(weak, "assessed_at");
      await scan();
      assert.equal(assessment(weak, "assessed_at"), first);

      const replacement = addFixtureRank(weak, seedDiscoveryRun(endpoint, "1 minute"));
      await scan();
      assert.equal(assessment(weak, "rank_id"), replacement);
      assert.equal(assessment(weak, "priority"), "critical");
      assert.equal(assessment(weak, "verification_attention"), "f");
      assert.equal(workflowFor(weak), run);
      sql(`update ai_ops.newsroom_assessments set assessed_at=now()-interval '31 minutes' where event_id=${quote(weak)};`);
      await scan();
      assert.equal(assessment(weak, "(assessed_at>now()-interval '1 minute')"), "t");
      await cancel(run);
      await cancel(workflowFor(urgentVerification));
      for (const { event } of cases) {
        const seeded = workflowFor(event);
        if (seeded) await cancel(seeded);
      }
    });

    await t.test("duplicate claims, starts and settlements run once and require every dependency", async () => {
      const run = await runFixture();
      sql(`do $$ begin
        begin
          insert into ai_ops.agent_tasks(workflow_id,agent_id)
            select ${quote(run)},id from ai_ops.agents where code='GL-AGENT-004';
          raise exception 'Legacy task accepted under a fixture run';
        exception when foreign_key_violation then null;
        end;
        begin
          insert into ai_ops.task_attempts(task_id,attempt,contract_version,input,output,synthetic)
            select id,1,1,'{}','{}',true from ai_ops.agent_tasks
            where workflow_id=${quote(run)} and stage='verification';
          raise exception 'Legacy attempt accepted under a fixture task';
        exception when foreign_key_violation then null;
        end;
      end $$;`);
      const batches = await Promise.all([claim(run), claim(run)]);
      const [first] = batches.flatMap(({ claims }) => claims);
      assert.equal(batches.flatMap(({ claims }) => claims).length, 1);
      assert.equal(first.task.stage, "discovery");
      assert.equal(first.model, "geolens-fixture");
      assert.equal(await finish(first), "stale");
      assert.deepEqual((await Promise.all([start(first), start(first)])).sort(), [false, true]);
      assert.deepEqual((await Promise.all([finish(first), finish(first)])).sort(), ["stale", "succeeded"]);

      const tasks = (await claim(run)).claims;
      assert.deepEqual(tasks.map(({ task }) => task.stage), ["history", "verification"]);
      const [history, verification] = tasks;
      assert.ok(Date.parse(history.leaseExpiresAt) - Date.parse(verification.leaseExpiresAt) >= 119_000);
      assert.equal(await execute(history), "succeeded");
      assert.deepEqual((await claim(run)).claims, []);
      assert.equal(await execute(verification), "succeeded");
      const [analysis] = (await claim(run)).claims;
      assert.equal(analysis.task.stage, "analysis");
      assert.equal(analysis.task.dependencies.length, 2);
      await execute(analysis);
      const production = (await claim(run)).claims;
      assert.deepEqual(production.map(({ task }) => task.stage).sort(), ["visual", "writing"]);
      await Promise.all(production.map((item) => execute(item)));
      const [check] = (await claim(run)).claims;
      assert.equal(check.task.stage, "reverification");
      assert.equal(check.task.dependencies.length, 2);
      await execute(check);
      const [editor] = (await claim(run)).claims;
      assert.equal(editor.task.stage, "editorial");
      assert.equal(editor.task.dependencies.length, 3);
      assert.equal(await execute(editor), "human_review");
      assert.equal((await status(run)).state, "human_review");
      assert.equal((await claim(run)).state, "human_review");
      assert.equal(await cancel(run), false);
      assert.equal(sql(`select count(*) from governance.audit_events
        where action='newsroom.human_review_requested' and target_id=${quote(run)};`), "1");
      assert.equal(sql(`select count(*) from editorial.story_versions v join ai_ops.workflow_runs w
        on w.fixture_story_id=v.story_id where w.id=${quote(run)};`), "0");
      const metered = (await status(run)).tasks.flatMap(({ attempts }) => attempts);
      assert.equal(metered.length, 8);
      assert.ok(metered.every((attempt) => attempt.actualMinor === 0 && attempt.estimatedMicros === 320 && attempt.elapsedMs >= 0));
    });

    await t.test("concurrent ready tasks enforce three slots and cancellation fences late results", async () => {
      const run = await runFixture();
      // Fan out the disposable fixture graph to exercise the cap above the normal two-task frontier.
      sql(`delete from ai_ops.newsroom_dependencies where workflow_id=${quote(run)};`);
      const batches = await Promise.all(Array.from({ length: 5 }, () => claim(run)));
      const attempts = batches.flatMap(({ claims }) => claims);
      assert.equal(attempts.length, 3);
      assert.equal(new Set(attempts.map(({ task }) => task.taskId)).size, 3);
      assert.ok(batches.every((batch) => batch.claims.length || Date.parse(batch.wakeAt) > Date.now()));
      assert.equal(await start(attempts[0]), true);
      assert.deepEqual((await Promise.all([cancel(run), cancel(run)])).sort(), [false, true]);
      assert.equal(await finish(attempts[0]), "stale");
      assert.equal(await start(attempts[1]), false);
      assert.equal((await claim(run)).state, "cancelled");
      const stopped = (await status(run)).tasks.flatMap(({ attempts: items }) => items);
      assert.equal(stopped.length, 3);
      assert.equal(stopped.filter(({ estimatedMicros }) => estimatedMicros === 0).length, 2);
      assert.ok(stopped.every((item) => item.state === "cancelled" && item.failure === "cancelled" && item.actualMinor === 0));
    });

    await t.test("atomic budget reservations serialize stories against discovery spend and release unused holds", async () => {
      const a = await runFixture();
      const b = await runFixture();
      // Leave enough room for exactly one default (12,288 microdollar) reservation.
      setSpend(`floor((50000000-ai_ops.newsroom_reserved_cost(${month})-12288)/10000)`);
      try {
        const both = await Promise.all([claim(a), claim(b)]);
        assert.equal(both.flatMap(({ claims }) => claims).length, 1);
        const runner = both[0].claims.length ? a : b;
        const blocked = runner === a ? b : a;
        assert.equal((await status(blocked)).reason, "budget_blocked");
        assert.ok((await status(blocked)).tasks.every(({ attempts }) => attempts.length === 0));
        const budget = await rpc("newsroom_fixture_budget");
        assert.ok(budget.developmentMicros <= 50_000_000);
        assert.equal(budget.launchLimitMinor, 30_000);
        assert.equal(budget.fixtureActualMinor, 0);
        assert.equal(await cancel(runner), true);
        sql(`update ai_ops.workflow_runs set budget_retry_at=now()-interval '1 second' where id=${quote(blocked)};`);
        assert.equal((await claim(blocked)).claims[0].task.attempt, 1);
        await cancel(blocked);
      } finally {
        setSpend(0);
      }
    });

    await t.test("expired leases and invalid output retry after 5 and 30 seconds, then escalate", async () => {
      const run = await runFixture();
      const [first] = (await claim(run)).claims;
      sql(`update ai_ops.task_attempts set lease_expires_at=now()-interval '1 second' where id=${quote(first.task.attemptId)};`);
      assert.equal(await start(first), false);
      const replay = await claim(run);
      assert.deepEqual(replay.claims, []);
      const wait = (attempt) => Number(sql(`select extract(epoch from (t.available_at-a.finished_at))
        from ai_ops.agent_tasks t join ai_ops.task_attempts a on a.task_id=t.id where a.id=${quote(attempt.task.attemptId)};`));
      const backdate = (attempt) => sql(`update ai_ops.agent_tasks set available_at=now()-interval '1 second'
        where id=${quote(attempt.task.taskId)};`);
      assert.ok(wait(first) >= 5 && wait(first) < 6);
      backdate(first);
      const [second] = (await claim(run)).claims;
      assert.equal(second.task.attempt, 2);
      assert.equal(await finish(first), "stale");
      assert.equal(await execute(second, { ...complete, publish: true }), "retry");
      assert.equal((await claim(run)).claims.length, 0);
      assert.ok(wait(second) >= 30 && wait(second) < 31);
      backdate(second);
      const [third] = (await claim(run)).claims;
      assert.equal(third.task.attempt, 3);
      assert.equal(await start(third), true);
      assert.equal(await failure(third, "provider_error"), "escalated");
      assert.equal((await claim(run)).state, "escalated");
      const outcome = await status(run);
      assert.equal(outcome.reason, "attempts_exhausted:provider_error");
      assert.deepEqual(outcome.tasks.find(({ stage }) => stage === "discovery").attempts.map(({ failure }) => failure),
        ["timeout", "invalid_output", "provider_error"]);
    });

    await t.test("critical verification and incomplete investigations cannot be overridden", async () => {
      const run = await runFixture();
      await execute((await claim(run)).claims[0]);
      const [history, verification] = (await claim(run)).claims;
      assert.equal(await start(history), true);
      assert.equal(await execute(verification, { ...complete, disposition: "critical" }), "escalated");
      assert.equal(await finish(history), "stale");
      assert.equal(await finish(verification), "stale");
      assert.equal(await cancel(run), false);
      assert.equal((await status(run)).reason, "critical_finding:verification");
      assert.equal((await claim(run)).claims.length, 0);

      const incomplete = await runFixture();
      assert.equal(await execute((await claim(incomplete)).claims[0], { ...complete, disposition: "incomplete" }), "escalated");
      assert.equal((await status(incomplete)).reason, "incomplete_finding:discovery");
    });

    await t.test("revisions retain context, rerun downstream checks and stop after two per stage", async () => {
      const run = await runFixture();
      for (const stages of [["discovery"], ["history", "verification"], ["analysis"], ["visual", "writing"], ["reverification"]]) {
        const { claims } = await claim(run);
        assert.deepEqual(claims.map(({ task }) => task.stage).sort(), stages);
        await Promise.all(claims.map((item) => execute(item)));
      }
      const revisionStages = ["writing", "visual", "writing", "visual"];
      for (const [index, stage] of revisionStages.entries()) {
        const [editor] = (await claim(run)).claims;
        assert.equal(editor.task.stage, "editorial");
        assert.equal(await execute(editor, revision(stage)), "revision_queued");
        const [work] = (await claim(run)).claims;
        assert.equal(work.task.stage, stage);
        assert.equal(work.task.round, index + 1);
        assert.deepEqual(work.task.revisionRequest, revision(stage));
        await execute(work);
        const [check] = (await claim(run)).claims;
        assert.equal(check.task.stage, "reverification");
        assert.ok(check.task.dependencies.some(({ taskId }) => taskId === work.task.taskId));
        await execute(check);
      }
      const [editor] = (await claim(run)).claims;
      assert.equal(await execute(editor, revision("writing")), "escalated");
      const outcome = await status(run);
      assert.equal(outcome.reason, "revision_limit:writing");
      assert.equal(outcome.tasks.filter(({ stage }) => stage === "writing").length, 3);
      assert.equal(outcome.tasks.filter(({ stage }) => stage === "visual").length, 3);
      assert.equal(outcome.tasks.filter(({ stage }) => stage === "reverification").length, 5);
    });
  } finally {
    setSpend(previousSpend);
  }
});
