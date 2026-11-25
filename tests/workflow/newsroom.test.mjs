import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { api, localSupabase, quote, seedDiscoveryRun, seedEndpoint, seedRankedEvent, sql, workflowFor } from "../helpers/newsroom-fixtures.mjs";

const worker = "http://127.0.0.1:4177";

async function until(read, { count = 120, interval = 200 } = {}) {
  for (let attempt = 0; attempt < count; attempt++) {
    if (await read()) return true;
    await delay(interval);
  }
  return false;
}

test("local Workerd dispatches the fixture Orchestrator and resumes an expired lease once", { timeout: 60_000 }, async () => {
  const { key, adminKey, createUser, caller } = localSupabase();
  const newsroomToken = await createUser("newsroom_operator");
  const discoveryToken = await createUser("ingestion_operator");
  const endpoint = seedEndpoint({ enabled: true });
  const event = seedRankedEvent(seedDiscoveryRun(endpoint, "-15 minutes"));
  // Reset the disposable fixture observation. The regression suite tests a full budget.
  sql("update ai_ops.discovery_usage set amount_minor=0 where scope='development';");
  const rpc = caller(newsroomToken);
  await rpc("scan_newsroom_fixtures", { prompt_manifest: promptManifest });
  const run = workflowFor(event);
  assert.match(run, /^[a-f0-9-]{36}$/);
  const { claims: [lost] } = await rpc("claim_newsroom_fixtures", { target_run: run });
  sql(`update ai_ops.task_attempts set lease_expires_at=now()-interval '1 second' where id=${quote(lost.task.attemptId)};`);

  const directory = await mkdtemp(join(tmpdir(), "geolens-newsroom-"));
  const envFile = join(directory, "fixture.env");
  await writeFile(envFile, [
    `DISCOVERY_DB_URL=${api}`, `DISCOVERY_DB_PUBLIC_KEY=${key}`, `DISCOVERY_OPERATOR_JWT=${discoveryToken}`,
    `NEWSROOM_DB_URL=${api}`, `NEWSROOM_DB_PUBLIC_KEY=${key}`, `NEWSROOM_OPERATOR_JWT=${newsroomToken}`,
  ].join("\n") + "\n", { mode: 0o600 });
  const server = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--config", "build/server/wrangler.json",
    "--local", "--ip", "127.0.0.1", "--port", "4177", "--test-scheduled",
    "--var", "DISCOVERY_MODE:fixture", "--var", "NEWSROOM_MODE:fixture", "--env-file", envFile, "--persist-to", directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(server, "close");
  let logs = "";
  for (const output of [server.stdout, server.stderr]) {
    output.setEncoding("utf8").on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
  }
  const diagnostics = () => [key, adminKey, newsroomToken, discoveryToken].reduce(
    (safe, secret) => safe.replaceAll(secret, "[redacted]"), logs,
  );

  try {
    assert.ok(await until(() =>
      fetch(worker + "/health", { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false),
    { count: 100 }), diagnostics());
    const dispatch = () => fetch(worker + "/cdn-cgi/local/scheduled?cron=" + encodeURIComponent("*/15 * * * *"),
      { signal: AbortSignal.timeout(5000) });
    assert.ok((await dispatch()).ok, diagnostics());
    assert.ok(await until(async () => (await rpc("newsroom_fixture_status", { target_run: run })).state === "human_review"),
      diagnostics());
    assert.equal(sql(`select count(*) from ai_ops.discovery_runs where endpoint_id=${quote(endpoint)} and received=2
      and state='complete';`), "1");
    assert.equal(sql(`select count(*) from ai_ops.newsroom_assessments a join news.discovery_ranks r on r.id=a.rank_id
      join ai_ops.discovery_runs d on d.id=r.run_id where d.endpoint_id=${quote(endpoint)} and d.received=2;`), "1");
    assert.ok((await dispatch()).ok, diagnostics());
    const outcome = await rpc("newsroom_fixture_status", { target_run: run });
    assert.deepEqual(outcome.tasks.find(({ stage }) => stage === "discovery").attempts.map(({ state, failure }) => [state, failure]),
      [["failed", "timeout"], ["succeeded", null]]);
    assert.equal(sql(`select (b.started_at-a.finished_at >= interval '5 seconds')
      from ai_ops.task_attempts a join ai_ops.task_attempts b on a.task_id=b.task_id and b.attempt=2
      where a.id=${quote(lost.task.attemptId)};`), "t");
    assert.equal(sql(`select count(*) from governance.audit_events where action='newsroom.human_review_requested'
      and target_id=${quote(run)};`), "1");
    const usage = outcome.tasks.flatMap(({ attempts }) => attempts);
    assert.equal(usage.length, 9);
    assert.ok(usage.every(({ actualMinor }) => actualMinor === 0));
  } finally {
    server.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
