import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { api, localSupabase, quote, sql } from "../helpers/newsroom-fixtures.mjs";
import { runResearchFixture, seedEditorialVisuals } from "../helpers/editorial-fixtures.mjs";

test("local Workerd dispatches the explicitly queued editorial fixture through private human review", { timeout: 75_000 }, async () => {
  const { key, adminKey, createUser, caller } = localSupabase();
  const token = await createUser("newsroom_operator");
  const ingestionToken = await createUser("ingestion_operator");
  const operator = caller(token);
  sql("update ai_ops.discovery_usage set amount_minor=0 where scope='development';");
  const fixture = await runResearchFixture(operator, caller(ingestionToken));
  await seedEditorialVisuals(operator, fixture, adminKey);
  assert.equal(await operator("queue_newsroom_edition", { target_run: fixture.run, prompt_manifest: promptManifest }), true);

  const directory = await mkdtemp(join(tmpdir(), "geolens-editorial-"));
  const envFile = join(directory, "fixture.env");
  await writeFile(envFile, `NEWSROOM_DB_URL=${api}\nNEWSROOM_DB_PUBLIC_KEY=${key}\nNEWSROOM_OPERATOR_JWT=${token}\n`, { mode: 0o600 });
  const worker = "http://127.0.0.1:4179";
  const server = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--config", "build/server/wrangler.json",
    "--local", "--ip", "127.0.0.1", "--port", "4179", "--test-scheduled",
    "--var", "NEWSROOM_MODE:editorial-fixture", "--env-file", envFile, "--persist-to", directory,
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

    let state;
    for (let attempt = 0; attempt < 150; attempt++) {
      state = await operator("newsroom_fixture_status", { target_run: fixture.run });
      if (state.state !== "active") break;
      await delay(200);
    }
    assert.equal(state?.state, "human_review", JSON.stringify(state) + "\n" + diagnostics());
    const saved = await operator("newsroom_edition", { target_run: fixture.run });
    assert.equal(saved.versions.length, 1);
    assert.equal(saved.readyForHumanReview, true);
    assert.equal(saved.versions[0].visual.assets.length, 7);
    assert.equal(saved.versions[0].reviews.length, 2);
    assert.ok(state.tasks.every(({ attempts }) => attempts.length === 1 && attempts[0].actualMinor === 0));
    assert.ok((await dispatch()).ok, diagnostics());
    assert.equal(sql(`select count(*) from editorial.newsroom_edition_versions where run_id=${quote(fixture.run)};`), "1");
  } finally {
    server.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
