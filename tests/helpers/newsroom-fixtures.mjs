import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export const api = "http://127.0.0.1:54321";
const cli = process.env.GEOLENS_SUPABASE_CLI ?? "supabase";
export const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export function sql(query) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_geolens-security", "psql",
    "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"], { input: query, encoding: "utf8" }).trim();
}

export function localSupabase() {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(execFileSync(cli, ["status", "-o", "json"]));
  assert.equal(API_URL, api);
  async function request(path, body, { key = ANON_KEY, token = key } = {}) {
    return fetch(api + path, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: {
        apikey: key, authorization: "Bearer " + token, "content-type": "application/json",
        "content-profile": "geo_api",
      },
      body: JSON.stringify(body),
    });
  }
  async function createUser(role) {
    const email = "newsroom-fixture-" + randomUUID() + "@example.com";
    const password = randomUUID();
    const created = await request("/auth/v1/admin/users", { email, password, email_confirm: true }, { key: SERVICE_ROLE_KEY });
    assert.ok(created.ok, "synthetic account created");
    const { id } = await created.json();
    if (role) sql(`insert into app.user_roles(user_id,role_id)
      select ${quote(id)},id from app.roles where code=${quote(role)};`);
    const session = await request("/auth/v1/token?grant_type=password", { email, password });
    assert.ok(session.ok, "synthetic session created");
    return (await session.json()).access_token;
  }
  const response = (method, body, token) => request("/rest/v1/rpc/" + method, body, { token });
  const caller = (token) => async (method, body = {}) => {
    const reply = await response(method, body, token);
    assert.ok(reply.ok, await reply.clone().text());
    return reply.json();
  };
  return { key: ANON_KEY, adminKey: SERVICE_ROLE_KEY, createUser, response, caller };
}

export function seedEndpoint({ enabled = false, fixture = true, adapter = "gdelt" } = {}) {
  const endpoint = randomUUID();
  sql(`with s as (insert into news.sources(name) values ('Newsroom synthetic ${endpoint}') returning id)
    insert into news.discovery_endpoints(id,source_id,locator,adapter,fixture,enabled)
      select '${endpoint}',id,'fixture:${endpoint}',${quote(adapter)},${fixture},${enabled} from s;
    insert into news.acquisition_licences(endpoint_id,terms_reference,attribution,fields,retention_until,valid_from,valid_until)
      values ('${endpoint}','synthetic fixture','Synthetic newsroom fixture',array['metadata'],
        now()+interval '2 days',now()-interval '1 hour',now()+interval '1 day');`);
  return endpoint;
}

export function seedDiscoveryRun(endpoint, offset = "0 seconds") {
  const run = randomUUID();
  sql(`insert into ai_ops.discovery_runs(id,endpoint_id,licence_id,cycle,state,finished_at)
    select '${run}',endpoint_id,id,now()+${quote(offset)}::interval,'complete',now()
    from news.acquisition_licences where endpoint_id=${quote(endpoint)};`);
  return run;
}

export const allScores = (value) => ({ impact: value, evidence: value, urgency: value, regional: value, historical: value });

export function addFixtureRank(event, run, { scores = allScores(90), origins = 2 } = {}) {
  return sql(`insert into news.discovery_ranks(event_id,run_id,independent_origins,score_components,label)
    values (${quote(event)},${quote(run)},${origins},${quote(JSON.stringify(scores))}::jsonb,'review') returning id;`);
}

export function seedRankedEvent(run, { fixture = true, ...ranking } = {}) {
  const id = randomUUID();
  sql(`insert into news.events(id,title,discovery_pilot) values ('${id}','Synthetic investigation',${!fixture});
    insert into news.discovery_clusters values ('fixture:${id}','${id}',${fixture});`);
  addFixtureRank(id, run, ranking);
  return id;
}

export function workflowFor(event) {
  return sql(`select id from ai_ops.workflow_runs where fixture_event_id=${quote(event)};`);
}
