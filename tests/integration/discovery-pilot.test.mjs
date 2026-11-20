import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePilotLeads } from "../../src/ingestion/adapters.ts";
import { normalize } from "../../src/ingestion/normalize.ts";
import { runPilotSource } from "../../src/ingestion/pilot.ts";
import { endpoints } from "../../src/ingestion/retrieval.ts";
import { fixtureStore, pilotStore } from "../../src/ingestion/store.ts";

const api = "http://127.0.0.1:54321";
const cli = process.env.GEOLENS_SUPABASE_CLI ?? "supabase";
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

function sql(query, variables = []) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_geolens-security", "psql",
    "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", ...variables],
  { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("local restricted pilot enforces the security gates with synthetic provider replies", { timeout: 90_000 }, async (t) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(execFileSync(cli, ["status", "-o", "json"], { encoding: "utf8" }));
  assert.equal(API_URL, api);
  assert.ok(ANON_KEY && SERVICE_ROLE_KEY);
  assert.equal(sql(`select count(*) from news.discovery_endpoints where not enabled and not fixture
    and not exists(select 1 from news.acquisition_licences l where l.endpoint_id=discovery_endpoints.id and l.revoked_at is null);`),
  "3", "run against a disposable database with the live pilot disabled");

  async function auth(path, body, key = ANON_KEY) {
    const response = await fetch(api + "/auth/v1/" + path, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, "local fixture authentication returned " + response.status);
    return response.json();
  }
  async function operator() {
    const email = "pilot-test-" + randomUUID() + "@example.com";
    const password = randomUUID();
    const user = await auth("admin/users", { email, password, email_confirm: true }, SERVICE_ROLE_KEY);
    sql(`insert into app.user_roles(user_id,role_id) select ${quote(user.id)},id from app.roles where code='ingestion_operator';`);
    const { access_token: token } = await auth("token?grant_type=password", { email, password });
    return { id: user.id, token, rpc: pilotStore(api, ANON_KEY, token) };
  }

  const owner = await operator();
  const other = await operator();
  const initialSpend = sql("select coalesce((select amount_minor from ai_ops.discovery_usage where scope='development' and month=date_trunc('month',now() at time zone 'UTC')::date),0);");
  const activation = {};
  function scope(adapter) {
    return `select id from news.discovery_endpoints where locator=${quote(endpoints[adapter])} and not fixture`;
  }
  function authorizeMock(adapter, retentionDays) {
    const day = 86_400_000;
    const now = Date.now();
    const script = readFileSync(new URL("../../scripts/discovery-pilot-authorize.sql", import.meta.url), "utf8");
    sql(script, ["-v", "source_adapter=" + adapter, "-v", "operator_id=" + owner.id,
      "-v", "licensed_until=" + new Date(now + day).toISOString(),
      "-v", "retention_until=" + new Date(now + retentionDays * day).toISOString()]);
    activation[adapter] = sql(`select l.id from news.acquisition_licences l
      where l.endpoint_id in (${scope(adapter)}) and l.revoked_at is null;`);
  }
  function nextCycle(adapter) {
    // Test-only clock state in the disposable DB. The application has no such override.
    sql(`update ai_ops.discovery_runs set cycle=(select min(r.cycle)-interval '15 minutes' from ai_ops.discovery_runs r
      where r.endpoint_id in (${scope(adapter)})) where endpoint_id in (${scope(adapter)})
      and cycle=date_bin('15 minutes',now(),'2000-01-01'::timestamptz);
      update news.discovery_endpoints set next_due=now()-interval '1 second' where id in (${scope(adapter)});`);
  }
  function reserve(operatorValue, adapter) {
    return operatorValue.rpc("reserve_discovery_pilot", { source_adapter: adapter });
  }

  t.after(() => {
    sql(`delete from ai_ops.discovery_pilot_operators where user_id in (${quote(owner.id)},${quote(other.id)});
      update news.discovery_endpoints set enabled=false where id in (${scope("gdelt")}) or id in (${scope("world-bank")});
      update news.acquisition_licences set revoked_at=coalesce(revoked_at,now())
        where id in (${Object.values(activation).map(quote).join(",") || "null"});
      update ai_ops.discovery_usage set amount_minor=${Number(initialSpend)}
        where scope='development' and month=date_trunc('month',now() at time zone 'UTC')::date;
      select ai_ops.purge_discovery_pilot();`);
  });

  const base = { title: "Synthetic Lagos flood response (Reuters)", url: "https://paper.example/story?utm_source=fixture",
    seendate: "20261119T120000Z", language: "English", body: "Never retain this full text" };
  const second = { ...base, title: "Synthetic Lagos flood response expands (Reuters)", url: "https://paper.example/second" };
  const observation = { countryiso3code: "NGA", indicator: { id: "SP.POP.TOTL" }, date: "2024", value: 1600 };
  const wbBody = [{ sourceid: "2" }, [observation, { ...observation, date: "2023", value: null }]];

  await t.test("only a current, separately granted operator can reserve the two licensed endpoints", async () => {
    await assert.rejects(reserve(owner, "gdelt"), /ingestion_store_403/);
    sql(`insert into ai_ops.discovery_pilot_operators(user_id,expires_at) values
      (${quote(owner.id)},now()+interval '1 hour'),(${quote(other.id)},now()-interval '1 hour');`);
    await assert.rejects(reserve(other, "gdelt"), /ingestion_store_403/);
    assert.deepEqual(await reserve(owner, "gdelt"), { status: "inactive" });
    assert.deepEqual(await reserve(owner, "world-bank"), { status: "inactive" });
    assert.deepEqual(await reserve(owner, "rss"), { status: "inactive" });
    sql(`update ai_ops.discovery_pilot_operators set expires_at=now()+interval '1 hour' where user_id=${quote(other.id)};`);
    const fixture = fixtureStore(api, ANON_KEY, owner.token);
    assert.throws(() => authorizeMock("rss", 45), /no rows returned for/);
    authorizeMock("gdelt", 45);
    authorizeMock("world-bank", 10);
    assert.deepEqual(await fixture("due_discovery", {}), []);
    assert.equal(await fixture("begin_discovery", {
      source_endpoint: sql(scope("gdelt")),
      cycle_time: new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString(),
    }), null);
    const publication = await fetch(api + "/rest/v1/rpc/release_version", {
      method: "POST", headers: { apikey: ANON_KEY, authorization: "Bearer " + owner.token,
        "content-type": "application/json", "content-profile": "geo_api" },
      body: JSON.stringify({ target_version: randomUUID(), expected_digest: "0".repeat(64), operation_id: randomUUID() }),
    });
    assert.equal(publication.status, 403);
    assert.equal(sql("select not enabled from news.discovery_endpoints where adapter='rss' and not fixture;"), "t");
  });

  await t.test("one request per cycle, stable GDELT deduplication, authorized attribution and retention", async () => {
    let requests = 0;
    const transport = async (url) => {
      requests++;
      assert.equal(url.href, endpoints.gdelt);
      return json({ articles: [base, { ...base, seendate: "20261119T123000Z" }, second] });
    };
    const results = await Promise.all([
      runPilotSource("gdelt", owner.rpc, transport), runPilotSource("gdelt", other.rpc, transport),
    ]);
    assert.equal(requests, 1);
    assert.equal(results.filter((result) => result.status === "not_due").length, 1);
    assert.deepEqual(results.find((result) => result.status === "complete"),
      { adapter: "gdelt", status: "complete", received: 3, inserted: 2, duplicates: 1 });
    assert.equal(sql(`select bool_and(p.attribution='The GDELT Project (DOC 2.0 API)' and p.original_url is null
      and p.pilot_expires_at=d.retrieved_at+interval '720 hours' and p.time_basis='observed')
      from news.discovery_provenance p join news.documents d on d.id=p.document_id
      where p.licence_id=${quote(activation.gdelt)};`), "t");
    assert.equal(sql(`select count(*) from news.discovery_clusters where not fixture;`), "1");
    assert.equal(sql(`select e.next_due>=r.started_at+interval '15 minutes'
      from news.discovery_endpoints e join ai_ops.discovery_runs r on r.endpoint_id=e.id where e.id in (${scope("gdelt")});`), "t");

    const previousExpiry = sql(`select max(pilot_expires_at) from news.discovery_provenance where licence_id=${quote(activation.gdelt)};`);
    nextCycle("gdelt");
    const replay = await runPilotSource("gdelt", owner.rpc, async () =>
      json({ articles: [{ ...base, seendate: "20261120T090000Z" }, second] }));
    assert.deepEqual(replay, { adapter: "gdelt", status: "complete", received: 2, inserted: 0, duplicates: 2 });
    assert.equal(sql(`select max(pilot_expires_at) from news.discovery_provenance where licence_id=${quote(activation.gdelt)};`), previousExpiry);
  });

  await t.test("validates typed Nigeria population rows at the adapter and Supabase boundaries", async () => {
    const run = await reserve(owner, "world-bank");
    assert.equal(run.status, "reserved");
    const [lead] = parsePilotLeads("world-bank", JSON.stringify(wbBody));
    const document = await normalize(lead, "world-bank", { pilot: true });
    const finish = (rpc, documents) => rpc("finish_discovery_pilot", { target_run: run.id, documents });
    await assert.rejects(finish(other.rpc, [document]), /ingestion_store_403/);
    await assert.rejects(fixtureStore(api, ANON_KEY, owner.token)("finish_discovery", {
      target_run: run.id, documents: [document],
    }), /ingestion_store_403/);
    await assert.rejects(finish(owner.rpc, Array(11).fill(document)), /ingestion_store_400/);
    await assert.rejects(finish(owner.rpc, [{ ...document, observation: { ...document.observation, country: "GHA" } }]),
      /ingestion_store_400/);
    await assert.rejects(finish(owner.rpc, [{ ...document, body: "Not licensed" }]), /ingestion_store_400/);
    assert.deepEqual(await finish(owner.rpc, [document]), { status: "complete", received: 1, inserted: 1 });
    assert.deepEqual(JSON.parse(sql(`select jsonb_build_object('year',p.population_year,'value',p.population_value,
      'attribution',p.attribution,'shorterDeadline',p.pilot_expires_at=l.retention_until)
      from news.discovery_provenance p join news.acquisition_licences l on l.id=p.licence_id
      where p.run_id=${quote(run.id)};`)), {
      year: 2024, value: 1600, attribution: "World Bank, World Development Indicators: Population, total (SP.POP.TOTL), Nigeria",
      shorterDeadline: true,
    });

    nextCycle("world-bank");
    const updated = await runPilotSource("world-bank", owner.rpc, async (url) => {
      assert.equal(url.href, endpoints["world-bank"]);
      return json([wbBody[0], [{ ...observation, value: 1700 }]]);
    });
    assert.equal(updated.inserted, 1, "a changed provider value is a new revision");
  });

  await t.test("blocks further HTTP at the budget cap and discards a fetch if its licence is revoked", async () => {
    nextCycle("world-bank");
    sql("update ai_ops.discovery_usage set amount_minor=5000 where scope='development';");
    const never = () => assert.fail("over-budget source must not reach the network");
    assert.deepEqual(await runPilotSource("world-bank", owner.rpc, never), { adapter: "world-bank", status: "quota_blocked" });
    sql("update ai_ops.discovery_usage set amount_minor=0 where scope='development';");
    const revoked = await runPilotSource("world-bank", owner.rpc, async () => {
      sql(`update news.acquisition_licences set revoked_at=now() where id=${quote(activation["world-bank"])};`);
      return json([wbBody[0], [{ ...observation, value: 1800 }]]);
    });
    assert.deepEqual(revoked, { adapter: "world-bank", status: "failed", received: 0, inserted: 0, error: "licence_unavailable" });
  });

  await t.test("scheduled retention removes expired metadata and derived titles and blocks long-lived citation links", () => {
    const doc = sql(`select document_id from news.discovery_provenance where licence_id=${quote(activation.gdelt)}
      and title='Synthetic Lagos flood response (Reuters)';`);
    assert.throws(() => sql(`insert into research.evidence(document_id,excerpt) values(${quote(doc)},'fixture');`),
      /Pilot metadata cannot become an editorial or research citation/);
    assert.equal(sql("select count(*) from cron.job where jobname='geolens-discovery-pilot-retention' and active;"), "1");
    assert.equal(sql(`begin; do $$ begin perform pg_advisory_xact_lock(78294221); end $$;
      update news.discovery_provenance set pilot_expires_at=now()-interval '1 minute' where document_id=${quote(doc)};
      select ai_ops.purge_discovery_pilot()>=1; commit;`), "t");
    assert.equal(sql(`select count(*) from news.documents where id=${quote(doc)};`), "0");
    assert.equal(sql(`select title from news.events where discovery_pilot;`), second.title);
    assert.equal(sql(`select count(*) from news.discovery_ranks r join news.events e on e.id=r.event_id where e.discovery_pilot;`), "0");
    assert.equal(sql(`select count(*) from news.discovery_provenance where licence_id=${quote(activation["world-bank"])};`), "0");
  });
});
