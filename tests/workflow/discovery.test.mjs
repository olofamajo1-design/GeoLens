import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureStore } from "../../src/ingestion/store.ts";

const api = "http://127.0.0.1:54321";
const worker = "http://127.0.0.1:4176";
const cli = process.env.GEOLENS_SUPABASE_CLI ?? "supabase";

function sql(query) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_geolens-security", "psql",
    "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"], { input: query, encoding: "utf8" }).trim();
}

test("local cron dispatch runs a fixture Workflow once and saves its result", { timeout: 60_000 }, async () => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(execFileSync(cli, ["status", "-o", "json"]));
  assert.equal(API_URL, api);
  const email = "workflow-" + randomUUID() + "@example.com";
  const password = randomUUID();
  async function auth(path, body, key = ANON_KEY) {
    const response = await fetch(api + "/auth/v1/" + path, {
      method: "POST", headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, path + " returned " + response.status);
    return response.json();
  }
  const user = await auth("admin/users", { email, password, email_confirm: true }, SERVICE_ROLE_KEY);
  assert.match(user.id, /^[a-f0-9-]{36}$/);
  const { access_token: jwt } = await auth("token?grant_type=password", { email, password });
  const endpoint = randomUUID();
  // Synthetic integration tests set spend observations to the ceiling. Restore the
  // disposable fixture ledger before exercising the real Workerd dispatch.
  sql(`update ai_ops.discovery_usage set amount_minor=0 where scope='development';
    insert into app.user_roles(user_id,role_id) select '${user.id}',id from app.roles where code='ingestion_operator';
    with s as (insert into news.sources(name) values ('Workflow fixture ${endpoint}') returning id)
    insert into news.discovery_endpoints(id,source_id,locator,adapter,fixture,enabled)
      select '${endpoint}',id,'fixture:${endpoint}','world-bank',true,true from s;
    insert into news.acquisition_licences(endpoint_id,terms_reference,attribution,fields,retention_until,valid_from,valid_until)
      values ('${endpoint}','synthetic fixture','Synthetic institutional evidence',array['metadata'],
        now()+interval '2 days',now()-interval '1 hour',now()+interval '1 day');`);
  assert.ok((await fixtureStore(api, ANON_KEY, jwt)("due_discovery", {})).includes(endpoint));

  const directory = await mkdtemp(join(tmpdir(), "geolens-workflow-"));
  const envFile = join(directory, "fixture.env");
  await writeFile(envFile, `DISCOVERY_MODE=fixture\nDISCOVERY_DB_URL=${api}\nDISCOVERY_DB_PUBLIC_KEY=${ANON_KEY}\nDISCOVERY_OPERATOR_JWT=${jwt}\n`, { mode: 0o600 });
  const server = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--config", "build/server/wrangler.json",
    "--local", "--ip", "127.0.0.1", "--port", "4176", "--test-scheduled",
    "--var", "DISCOVERY_MODE:fixture", "--env-file", envFile, "--persist-to", directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(server, "close");
  let logs = "";
  for (const output of [server.stdout, server.stderr]) {
    output.setEncoding("utf8").on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
  }
  const diagnostics = () => [jwt, ANON_KEY, SERVICE_ROLE_KEY].reduce(
    (safe, secret) => safe.replaceAll(secret, "[redacted]"), logs,
  );

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && server.exitCode === null; attempt++) {
      ready = await fetch(worker + "/health", { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false);
      if (ready) break;
      await delay(200);
    }
    assert.ok(ready, "local scheduled Worker started");
    const dispatch = () => fetch(worker + "/cdn-cgi/local/scheduled?cron=" + encodeURIComponent("*/15 * * * *"),
      { signal: AbortSignal.timeout(5000) });
    const dispatched = await dispatch();
    assert.ok(dispatched.ok, "local cron returned " + dispatched.status + ": " + (await dispatched.text()).slice(0, 500));
    let state;
    for (let attempt = 0; attempt < 60; attempt++) {
      state = sql(`select state from ai_ops.discovery_runs where endpoint_id='${endpoint}';`);
      if (state === "complete" || state === "failed") break;
      await delay(200);
    }
    assert.equal(state, "complete", diagnostics());
    assert.ok((await dispatch()).ok, "local cron replay accepted");
    assert.equal(sql(`select count(*) from ai_ops.discovery_runs where endpoint_id='${endpoint}';`), "1");
    assert.equal(sql(`select count(*) from news.discovery_provenance p join ai_ops.discovery_runs r on r.id=p.run_id
      where r.endpoint_id='${endpoint}' and p.attribution='Synthetic institutional evidence';`), "1");
  } finally {
    server.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
