import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseLeads } from "../../src/ingestion/adapters.ts";
import { fixturePayloads } from "../../src/ingestion/fixtures.ts";
import { normalize } from "../../src/ingestion/normalize.ts";
import { fixtureStore } from "../../src/ingestion/store.ts";

const cli = process.env.GEOLENS_SUPABASE_CLI ?? "supabase";
const api = "http://127.0.0.1:54321";
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const cycle = () => new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();

function sql(query) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_geolens-security", "psql",
    "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"], { input: query, encoding: "utf8" }).trim();
}

test("private fixture discovery uses licensed, idempotent persistence", { timeout: 60_000 }, async (t) => {
  const config = JSON.parse(execFileSync(cli, ["status", "-o", "json"], { encoding: "utf8" }));
  assert.equal(config.API_URL, api);
  assert.ok(config.ANON_KEY && config.SERVICE_ROLE_KEY);

  function request(path, { key = config.ANON_KEY, token = key, body } = {}) {
    return fetch(api + path, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { apikey: key, authorization: "Bearer " + token, "content-type": "application/json",
        "content-profile": "geo_api", "accept-profile": "geo_api" },
      body: JSON.stringify(body ?? {}),
    });
  }

  const email = "synthetic-discovery-" + randomUUID() + "@example.com";
  const password = randomUUID();
  const created = await request("/auth/v1/admin/users", {
    key: config.SERVICE_ROLE_KEY, body: { email, password, email_confirm: true },
  });
  assert.ok(created.ok, "create isolated fixture operator");
  const user = await created.json();
  sql(`insert into app.user_roles(user_id,role_id)
    select ${quote(user.id)},id from app.roles where code='ingestion_operator';`);
  const signedIn = await request("/auth/v1/token?grant_type=password", { body: { email, password } });
  assert.ok(signedIn.ok, "sign in synthetic operator");
  const { access_token: token } = await signedIn.json();
  const rpc = fixtureStore(api, config.ANON_KEY, token);

  function seed(adapter, { licensed = true } = {}) {
    const id = randomUUID();
    sql(`with s as (insert into news.sources(name) values (${quote("Fixture " + id)}) returning id)
      insert into news.discovery_endpoints(id,source_id,locator,adapter,fixture,enabled)
      select ${quote(id)},id,${quote("fixture:" + id)},${quote(adapter)},true,true from s;`);
    if (licensed) sql(`insert into news.acquisition_licences(endpoint_id,terms_reference,attribution,fields,
      retention_until,valid_from,valid_until)
      values (${quote(id)},'synthetic licence', 'Fixture attribution',array['metadata'],
        now()+interval '2 days',now()-interval '1 hour',now()+interval '1 day');`);
    return id;
  }

  async function documents(adapter) {
    return (await Promise.all(parseLeads(adapter, fixturePayloads[adapter])
      .map((lead) => normalize(lead, adapter)))).filter(Boolean);
  }
  const begin = (id) => rpc("begin_discovery", { source_endpoint: id, cycle_time: cycle() });
  const finish = (run, batch, extra = {}) =>
    rpc("finish_discovery", { target_run: run.id, documents: batch, ...extra });

  await t.test("guest and the discovery operator cannot cross the editorial boundary", async () => {
    const guest = await request("/rest/v1/rpc/due_discovery");
    assert.equal(guest.ok, false);
    const publish = await request("/rest/v1/rpc/release_version", {
      token, body: { target_version: randomUUID(), expected_digest: "0".repeat(64), operation_id: randomUUID() },
    });
    assert.equal(publish.status, 403);
    assert.equal(sql(`select count(*) from news.discovery_endpoints where not fixture and not enabled;`), "3");
    const restricted = sql("select id from news.discovery_endpoints where not fixture limit 1;");
    assert.equal(await begin(restricted), null);
    assert.equal(await begin(seed("rss", { licensed: false })), null);
  });

  await t.test("simultaneous claims reuse one lease and wire mirrors count once", async () => {
    const endpoint = seed("gdelt");
    assert.ok((await rpc("due_discovery", {})).includes(endpoint));
    const [run, replay] = await Promise.all([begin(endpoint), begin(endpoint)]);
    assert.equal(run.id, replay.id);
    const batch = await documents("gdelt");
    assert.equal(await finish(run, [...batch, batch[0]]), "complete");
    assert.equal(await finish(run, batch), "complete");
    assert.equal(await begin(endpoint), null);
    assert.equal(sql(`select count(*) from news.discovery_provenance where run_id=${quote(run.id)};`), "2");
    assert.equal(sql(`select independent_origins from news.discovery_ranks where run_id=${quote(run.id)};`), "1");
    const rssRun = await begin(seed("rss"));
    assert.equal(await finish(rssRun, await documents("rss")), "complete");
    assert.equal(sql(`select independent_origins from news.discovery_ranks where run_id=${quote(rssRun.id)};`), "2");
    assert.equal(sql(`select count(*) from news.discovery_clusters;`), "1");
    assert.equal(sql(`select count(*) from news.discovery_provenance where attribution='Fixture attribution';`), "3");
  });

  await t.test("mid-run revocation, record cap and backoff preserve source health", async () => {
    const revokedEndpoint = seed("world-bank");
    const revoked = await begin(revokedEndpoint);
    sql(`update news.acquisition_licences set revoked_at=now() where endpoint_id=${quote(revokedEndpoint)};`);
    assert.equal(await finish(revoked, await documents("world-bank")), "failed");
    assert.equal(sql(`select count(*) from news.discovery_provenance where run_id=${quote(revoked.id)};`), "0");
    const endpoint = seed("world-bank");
    const run = await begin(endpoint);
    const [lead] = await documents("world-bank");
    await assert.rejects(finish(run, Array(11).fill(lead)), /ingestion_store_400/);
    await assert.rejects(finish(run, [{ ...lead, body: "Unlicensed body" }]), /ingestion_store_400/);
    assert.equal(await finish(run, [], { failure: "rate_limited", retry_seconds: 3600 }), "failed");
    assert.equal(sql(`select consecutive_failures=1 and next_due>now()+interval '50 minutes'
      from news.discovery_endpoints where id=${quote(endpoint)};`), "t");
  });

  await t.test("budget notices and blocking thresholds match the approved policy", async () => {
    sql(`update ai_ops.discovery_usage set amount_minor=4500 where scope='development';
      insert into ai_ops.discovery_usage(month,scope,amount_minor)
      values (date_trunc('month',now())::date,'launch',27000);`);
    const fiscal = await request("/rest/v1/rpc/discovery_budget", { token });
    assert.equal(fiscal.status, 200);
    const { development, launch } = await fiscal.json();
    assert.deepEqual(development.alerts, [3500, 4500]);
    assert.deepEqual(launch.alerts, [21000, 25000, 27000]);
    assert.equal(launch.blocked, false);
    sql("update ai_ops.discovery_usage set amount_minor=limit_value from (values ('development',5000),('launch',30000)) v(s,limit_value) where scope=v.s;");
    assert.equal(await begin(seed("rss")), null);
    const ceiling = await request("/rest/v1/rpc/discovery_budget", { token });
    assert.equal((await ceiling.json()).launch.blocked, true);
  });
});
