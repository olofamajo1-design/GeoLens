import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { api, localSupabase, quote, sql } from "../helpers/newsroom-fixtures.mjs";
import { ingestResearchFixture, researchRunFor } from "../helpers/research-fixtures.mjs";

const worker = "http://127.0.0.1:4178";

test("local Workerd runs the four research roles from fixture ingestion through a research-only handoff", { timeout: 60_000 }, async () => {
  const { key, adminKey, createUser, caller } = localSupabase();
  const token = await createUser("newsroom_operator");
  const ingestionToken = await createUser("ingestion_operator");
  sql("update ai_ops.discovery_usage set amount_minor=0 where scope='development';");
  const { event } = await ingestResearchFixture(caller(ingestionToken));

  const directory = await mkdtemp(join(tmpdir(), "geolens-research-"));
  const envFile = join(directory, "fixture.env");
  await writeFile(envFile, `NEWSROOM_DB_URL=${api}\nNEWSROOM_DB_PUBLIC_KEY=${key}\nNEWSROOM_OPERATOR_JWT=${token}\n`, { mode: 0o600 });
  const server = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--config", "build/server/wrangler.json",
    "--local", "--ip", "127.0.0.1", "--port", "4178", "--test-scheduled",
    "--var", "NEWSROOM_MODE:research-fixture", "--env-file", envFile, "--persist-to", directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(server, "close");
  let logs = "";
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
  }
  const diagnostics = () => [key, adminKey, token, ingestionToken].reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"), logs,
  );

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && server.exitCode === null; attempt++) {
      ready = await fetch(worker + "/health", { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false);
      if (ready) break;
      await delay(200);
    }
    assert.ok(ready, diagnostics());
    const dispatch = () => fetch(worker + "/cdn-cgi/local/scheduled?cron=" + encodeURIComponent("*/15 * * * *"),
      { signal: AbortSignal.timeout(5000) });
    assert.ok((await dispatch()).ok, diagnostics());
    let runId;
    let state;
    for (let attempt = 0; attempt < 150; attempt++) {
      runId ||= researchRunFor(event);
      if (runId) {
        state = await caller(token)("newsroom_fixture_status", { target_run: runId });
        if (state.state !== "active") break;
      }
      await delay(200);
    }
    assert.equal(state?.state, "research_ready", JSON.stringify(state) + "\n" + diagnostics());
    const saved = await caller(token)("newsroom_research_findings", { target_run: runId });
    assert.equal(saved.length, 4);
    assert.ok(saved.some(({ payload }) => payload.stage === "verification" && payload.claims.every(({ verdict }) => verdict === "verified")));
    assert.ok(saved.some(({ payload, evidence }) => payload.stage === "analysis" && evidence.length > 0));
    assert.ok((await dispatch()).ok, diagnostics());
    assert.equal(sql(`select count(*) from research.newsroom_fixture_findings where run_id=${quote(runId)};`), "4");
    assert.ok(state.tasks.every(({ attempts }) => attempts.length === 1 && attempts[0].actualMinor === 0));
  } finally {
    server.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
