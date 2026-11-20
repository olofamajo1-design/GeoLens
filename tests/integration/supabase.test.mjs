import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const project = "geolens-security";
const cli = process.env.GEOLENS_SUPABASE_CLI ?? "supabase";
const localApi = "http://127.0.0.1:54321";

const psql = [
  "exec", "-i", "supabase_db_" + project, "psql", "-X", "-U", "postgres",
  "-v", "ON_ERROR_STOP=1", "-qAt",
];

function sql(query) {
  return execFileSync("docker", psql, { input: query, encoding: "utf8" }).trim();
}

async function withOpenTransaction(query, run) {
  const name = "geolens-race-" + randomUUID();
  const connection = spawn("docker", psql);
  const closed = once(connection, "close");
  let errors = "";
  connection.stdout.resume();
  connection.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  // A failed SQL statement can close stdin before cleanup sends ROLLBACK.
  connection.stdin.on("error", () => {});
  function finish(action) {
    connection.stdin.end(action + ";\n\\q\n");
  }
  try {
    connection.stdin.write(`begin; set local idle_in_transaction_session_timeout = '15s';
      ${query}
      set local application_name = ${sqlValue(name)};
`);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && connection.exitCode === null) {
      const ready = sql(`select exists (select 1 from pg_stat_activity
        where application_name = ${sqlValue(name)} and state = 'idle in transaction');`);
      if (ready === "t") {
        return await run(async () => {
          finish("commit");
          assert.equal((await closed)[0], 0, errors);
        });
      }
      await delay(30);
    }
    assert.fail("Could not stage concurrent database operation: " + errors);
  } finally {
    if (!connection.stdin.writableEnded) finish("rollback");
    await closed;
  }
}

async function waitForBlockedRequests(name, count = 1) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const blocked = Number(sql(`select count(*) from pg_stat_activity
      where pid <> pg_backend_pid() and wait_event_type = 'Lock'
        and usename = 'authenticator' and query like ${sqlValue("%" + name + "%")};`));
    if (blocked >= count) return;
    await delay(30);
  }
  assert.fail(`Expected ${count} ${name} request(s) waiting for a database lock`);
}

function sqlValue(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function totp(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/=+$/, "")].map((char) =>
    alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("local Supabase enforces GeoLens Auth, editorial and Storage boundaries", { timeout: 120_000 }, async (t) => {
  const config = JSON.parse(execFileSync(cli, ["status", "-o", "json"], { encoding: "utf8" }));
  assert.equal(config.API_URL, localApi, "Integration tests require the disposable loopback API");
  const publicKey = config.ANON_KEY;
  const adminKey = config.SERVICE_ROLE_KEY;
  assert.ok(publicKey && adminKey, "Local Supabase status must provide fixture keys");

  async function request(path, { token, admin = false, method = "GET", body, contentType, headers = {} } = {}) {
    const result = await fetch(localApi + path, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        apikey: admin ? adminKey : publicKey,
        Authorization: "Bearer " + (token ?? (admin ? adminKey : publicKey)),
        "Content-Type": contentType ?? "application/json",
        "Accept-Profile": "geo_api",
        "Content-Profile": "geo_api",
        ...headers,
      },
      body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
    });
    const mediaType = result.headers.get("content-type") ?? "";
    if (mediaType.startsWith("image/")) {
      return { status: result.status, ok: result.ok, data: Buffer.from(await result.arrayBuffer()) };
    }
    const raw = await result.text();
    return { status: result.status, ok: result.ok, data: result.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw };
  }

  function success(response, label) {
    const error = response.ok ? "" : response.data?.message ?? response.data?.msg ?? response.data?.code ?? "";
    assert.ok(response.ok, label + " returned " + response.status + " " + error);
    return response.data;
  }

  async function fixtureUser(label, roles = []) {
    const email = label + "-" + randomUUID() + "@example.com";
    const password = "Synthetic-" + randomUUID();
    const user = success(await request("/auth/v1/admin/users", {
      admin: true, method: "POST", body: { email, password, email_confirm: true },
    }), "create synthetic user");
    assert.match(user.id, /^[a-f0-9-]{36}$/);
    if (roles.length) {
      sql(`insert into app.user_roles (user_id, role_id) select ${sqlValue(user.id)}, id from app.roles
        where code in (${roles.map(sqlValue).join(",")});
        insert into governance.audit_events(action, target_id, details)
        values ('fixture.roles_bootstrapped', ${sqlValue(user.id)}, '{"synthetic": true}');`);
    }
    const session = success(await request("/auth/v1/token?grant_type=password", {
      method: "POST", body: { email, password },
    }), "synthetic user sign-in");
    return { id: user.id, email, token: session.access_token };
  }

  function rpc(name, body, token) {
    return request("/rest/v1/rpc/" + name, { token, method: "POST", body });
  }

  function insert(table, body, token) {
    return request("/rest/v1/" + table, {
      method: "POST", body, token, headers: { Prefer: "return=representation" },
    });
  }

  const founder = await fixtureUser("founder", ["super_admin", "human_editor", "human_publisher"]);
  const verifier = await fixtureUser("verifier", ["verification_agent"]);
  const aiEditor = await fixtureUser("ai-editor", ["ai_editor"]);
  const owner = await fixtureUser("owner");
  const other = await fixtureUser("other");
  let elevated;

  await t.test("local passwordless email OTP works without registering a phone", async () => {
    success(await request("/auth/v1/otp", {
      method: "POST", body: { email: founder.email, create_user: false },
    }), "request OTP");
    const mailApi = "http://127.0.0.1:54324/api/v1";
    const search = new URLSearchParams({ query: "to:" + founder.email });
    let messages = [];
    for (let attempt = 0; attempt < 20 && !messages.length; attempt++) {
      const response = await fetch(mailApi + "/search?" + search);
      if (response.ok) messages = (await response.json()).messages ?? [];
      if (!messages.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(messages.length, "local mailbox received the sign-in message");
    const mail = await (await fetch(mailApi + "/message/" + messages[0].ID)).json();
    const code = ((mail.Text ?? "") + (mail.HTML ?? "")).match(/\b\d{6}\b/)?.[0];
    assert.ok(code, "sign-in template contains a six-digit token");
    const verify = () => request("/auth/v1/verify", {
      method: "POST", body: { email: founder.email, token: code, type: "email" },
    });
    const session = success(await verify(), "verify OTP");
    assert.equal(session.user.id, founder.id);
    founder.token = session.access_token;
    assert.equal((await verify()).ok, false);
  });

  await t.test("founder completes a real local TOTP challenge", async () => {
    const factor = success(await request("/auth/v1/factors", {
      token: founder.token, method: "POST", body: { factor_type: "totp", friendly_name: "Synthetic founder" },
    }), "TOTP enrollment");
    const path = "/auth/v1/factors/" + factor.id;
    const challenge = success(await request(path + "/challenge", {
      token: founder.token, method: "POST", body: {},
    }), "TOTP challenge");
    const code = totp(factor.totp.secret);
    const verify = (value) => request(path + "/verify", {
      token: founder.token, method: "POST", body: { challenge_id: challenge.id, code: value },
    });
    assert.equal((await verify(code === "000000" ? "111111" : "000000")).ok, false);
    elevated = success(await verify(code), "TOTP verification").access_token;
    assert.equal(JSON.parse(Buffer.from(elevated.split(".")[1], "base64url")).aal, "aal2");
    assert.equal((await rpc("newsroom_fixture_review_queue", {}, founder.token)).status, 403);
    assert.ok(Array.isArray(success(await rpc("newsroom_fixture_review_queue", {}, elevated), "MFA fixture review queue")));
    assert.equal((await rpc("set_role", { target_user: other.id, role_code: "human_editor", enabled: true }, founder.token)).status, 403);
    assert.equal((await rpc("set_role", { target_user: other.id, role_code: "human_editor", enabled: true }, other.token)).status, 403);
  });

  await t.test("profiles, private records and synthetic attachment bytes are owner-only", async () => {
    success(await insert("profiles", { id: owner.id, display_name: "Synthetic owner" }, owner.token), "profile create");
    assert.equal((await insert("profiles", { id: owner.id, display_name: "Impersonator" }, other.token)).ok, false);
    success(await insert("preferences", { user_id: owner.id, settings: { region: "NG" } }, owner.token), "save preferences");
    const [session] = success(await insert("ask_sessions", { title: "Synthetic Ask conversation" }, owner.token), "create Ask session");
    success(await insert("ask_messages", { session_id: session.id, body: "Fictional question" }, owner.token), "add Ask message");
    assert.equal((await insert("ask_messages", { session_id: session.id, body: "Intruder" }, other.token)).ok, false);
    const [factcheck] = success(await insert("factcheck_requests", { question: "Fictional claim" }, owner.token), "create FactCheck");
    assert.equal((await insert("factcheck_attachments", { request_id: factcheck.id }, other.token)).ok, false);
    const [attachment] = success(await insert("factcheck_attachments", { request_id: factcheck.id }, owner.token), "register attachment");
    const object = "/storage/v1/object/factcheck-private/" + attachment.object_key;
    const upload = (token, key = object, method = "POST") =>
      request(key, { token, method, body: "synthetic fixture only", contentType: "text/plain" });
    assert.equal((await upload(other.token)).ok, false);
    assert.equal((await upload(owner.token, "/storage/v1/object/factcheck-private/" + owner.id + "/" + randomUUID())).ok, false);
    success(await upload(owner.token), "upload synthetic attachment");
    assert.equal((await upload(owner.token, object, "PUT")).ok, false);
    const download = "/storage/v1/object/authenticated/factcheck-private/" + attachment.object_key;
    assert.equal(success(await request(download, { token: owner.token }), "owner download"), "synthetic fixture only");
    for (const token of [other.token, elevated, undefined]) {
      assert.equal((await request(download, { token })).ok, false);
      assert.equal((await request("/storage/v1/object/sign/factcheck-private/" + attachment.object_key, {
        token, method: "POST", body: { expiresIn: 30 },
      })).ok, false);
    }
    for (const table of ["profiles", "preferences", "ask_sessions", "ask_messages", "factcheck_requests", "factcheck_attachments"]) {
      for (const token of [other.token, elevated]) {
        assert.deepEqual(success(await request("/rest/v1/" + table + "?select=*", { token }), "RLS read"), []);
      }
    }
    assert.equal((await request("/storage/v1/object/sign/factcheck-private/" + attachment.object_key, {
      token: owner.token, method: "POST", body: { expiresIn: 30 },
    })).ok, false, "owner cannot mint a shareable URL");
    const listed = success(await request("/storage/v1/object/list/factcheck-private", {
      token: other.token, method: "POST", body: { prefix: owner.id, limit: 100 },
    }), "other user listing");
    assert.deepEqual(listed, []);
  });

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FEkAAAAASUVORK5CYII=", "base64");

  async function editorialFixture() {
    const slug = "synthetic-" + randomUUID();
    const digest = createHash("sha256").update(png).digest("hex");
    const objectKey = "synthetic/" + randomUUID() + ".png";
    success(await request("/storage/v1/object/editorial-private/" + objectKey, {
      admin: true, method: "POST", contentType: "image/png", body: png,
      headers: { "Cache-Control": "no-store" },
    }), "store synthetic editorial media");

    const fixture = JSON.parse(sql(`
      begin;
      create temporary table fixture(key text primary key, id uuid);
      with inserted as (insert into editorial.stories(slug, synthetic) values (${sqlValue(slug)}, true) returning id)
        insert into fixture select 'story', id from inserted;
      with inserted as (insert into news.sources(name) values (${sqlValue(slug)}) returning id)
        insert into fixture select 'source', id from inserted;
      with inserted as (insert into news.source_permissions(source_id, attribution, valid_from)
        select id, 'Synthetic citation', now()-interval '1 day' from fixture where key='source' returning id)
        insert into fixture select 'permission', id from inserted;
      with inserted as (insert into news.documents(source_id, external_reference, digest)
        select id, 'synthetic-source', extensions.digest('fictional document','sha256') from fixture where key='source' returning id)
        insert into fixture select 'document', id from inserted;
      with inserted as (insert into media.assets(label) values ('Synthetic media') returning id)
        insert into fixture select 'asset', id from inserted;
      with inserted as (insert into media.asset_versions(asset_id, version, object_key, digest, storage_version)
        select f.id, 1, o.name, decode(${sqlValue(digest)}, 'hex'), o.version
        from fixture f cross join storage.objects o
        where f.key='asset' and o.bucket_id='editorial-private' and o.name=${sqlValue(objectKey)} returning id)
        insert into fixture select 'media', id from inserted;
      with inserted as (insert into media.licences(asset_id, terms, valid_from)
        select id, 'Synthetic licence', now()-interval '1 day' from fixture where key='asset' returning id)
        insert into fixture select 'licence', id from inserted;
      select jsonb_object_agg(key,id) from fixture;
      commit;
    `));
    return { ...fixture, slug, digest, objectKey };
  }

  const fixture = await editorialFixture();
  const { slug, digest, objectKey } = fixture;

  function seal(title, includeMedia = true, fixtureForStory = fixture) {
    const id = sql(`
      select editorial.seal_version(${sqlValue(fixtureForStory.story)}, jsonb_build_object('title',${sqlValue(title)},'body','Fictional article'),
        jsonb_build_array(jsonb_build_object('document_id',${sqlValue(fixtureForStory.document)},'permission_id',${sqlValue(fixtureForStory.permission)})),
        case when ${includeMedia} then
          jsonb_build_array(jsonb_build_object('asset_version_id',${sqlValue(fixtureForStory.media)},'licence_id',${sqlValue(fixtureForStory.licence)}))
          else '[]'::jsonb end);
    `);
    return JSON.parse(sql(`select jsonb_build_object('id',id,'digest',encode(digest,'hex'))
      from editorial.story_versions where id=${sqlValue(id)};`));
  }

  function seedAttempts(version, synthetic = true) {
    return sql(`
      with workflow as (insert into ai_ops.workflow_runs(version_id, request_key)
        values (${sqlValue(version.id)}, ${sqlValue(randomUUID())}) returning id),
      tasks as (insert into ai_ops.agent_tasks(workflow_id,agent_id)
        select w.id,a.id from workflow w cross join ai_ops.agents a
          where a.code in ('GL-AGENT-004','GL-AGENT-008') returning id,agent_id),
      attempts as (insert into ai_ops.task_attempts(task_id,attempt,contract_version,input,output,synthetic)
        select id,1,1,'{}','{}',${synthetic} from tasks returning id,task_id)
      select at.id from attempts at join tasks t on t.id=at.task_id
        join ai_ops.agents a on a.id=t.agent_id order by a.code;
    `).split("\n");
  }

  const target = (version) => ({ target_version: version.id, expected_digest: version.digest });
  const publicStory = () => rpc("published_story", { story_slug: slug });
  const publicMedia = () => rpc("publication_media", { story_slug: slug, position_number: 1 });

  async function reviews(version) {
    const [verification, editorial] = seedAttempts(version);
    const verificationInput = { ...target(version), review_kind: "verification", target_attempt: verification, passed: true };
    assert.equal((await rpc("record_review", verificationInput, aiEditor.token)).status, 403);
    success(await rpc("record_review", verificationInput, verifier.token), "record verification");
    assert.equal((await rpc("record_review", verificationInput, verifier.token)).ok, false);
    success(await rpc("record_review", {
      ...target(version), review_kind: "ai_editorial", target_attempt: editorial, passed: true,
    }, aiEditor.token), "record AI review");
  }

  await t.test("exact-version editorial reviews, approval, release replay, correction and rights", async () => {
    const first = seal("Synthetic story");
    const second = seal("Synthetic correction");
    const withoutMedia = seal("Synthetic story", false);
    assert.notEqual(first.digest, second.digest);
    assert.notEqual(first.digest, withoutMedia.digest);
    const approve = { ...target(first), approve: true };
    const release = { ...target(first), operation_id: randomUUID() };
    assert.deepEqual(success(await publicStory(), "guest before release"), []);
    assert.equal((await request("/rest/v1/human_decisions?select=*", { token: verifier.token })).ok, false);
    assert.equal((await rpc("decide_version", approve, elevated)).ok, false);
    for (const token of [founder.token, owner.token, verifier.token, aiEditor.token, undefined]) {
      assert.equal((await rpc("decide_version", approve, token)).ok, false);
      assert.equal((await rpc("release_version", release, token)).ok, false);
    }
    const [wrongAttempt] = seedAttempts(first, false);
    assert.equal((await rpc("record_review", {
      ...target(first), review_kind: "verification", target_attempt: wrongAttempt, passed: true,
    }, verifier.token)).ok, false);
    await reviews(first);
    const [failedVerification] = seedAttempts(first);
    success(await rpc("record_review", {
      ...target(first), review_kind: "verification", target_attempt: failedVerification, passed: false,
    }, verifier.token), "record failed verification");
    assert.equal((await rpc("decide_version", approve, elevated)).ok, false);
    await reviews(first);
    assert.equal((await rpc("decide_version", { ...approve, expected_digest: second.digest }, elevated)).ok, false);
    success(await rpc("decide_version", approve, elevated), "founder approval");
    success(await rpc("invalidate_review", { ...target(first), review_kind: "verification", reason_text: "Synthetic evidence challenge" }, elevated), "invalidate review");
    assert.equal((await rpc("release_version", release, elevated)).ok, false);
    await reviews(first);
    assert.equal((await rpc("release_version", release, elevated)).ok, false, "old approval binds old review IDs");
    success(await rpc("decide_version", approve, elevated), "renew approval");
    const [published, replay] = await Promise.all([
      rpc("release_version", release, elevated), rpc("release_version", release, elevated),
    ]);
    const publication = success(published, "publish");
    assert.equal(success(replay, "concurrent release replay"), publication);
    assert.equal((await rpc("release_version", { ...target(second), operation_id: release.operation_id }, elevated)).ok, false);
    assert.equal((await rpc("release_version", {
      ...target(withoutMedia), operation_id: randomUUID(), replaces: publication, correction_note: "Media changed",
    }, elevated)).ok, false);
    const [publicArticle] = success(await publicStory(), "guest can see published story");
    assert.equal(publicArticle.synthetic, true);
    assert.deepEqual(publicArticle.article.attributions, ["Synthetic citation"]);
    assert.deepEqual(success(await publicMedia(), "guest resolves exact media"), [{ object_key: objectKey, sha256: digest }]);
    const mediaDownload = "/storage/v1/object/authenticated/editorial-private/" + objectKey;
    assert.deepEqual(success(await request(mediaDownload), "guest downloads approved bytes"), png);
    assert.equal((await request("/storage/v1/object/sign/editorial-private/" + objectKey, {
      method: "POST", body: { expiresIn: 30 },
    })).ok, false);
    const listing = await request("/storage/v1/object/list/editorial-private", {
      method: "POST", body: { prefix: "synthetic", limit: 100 },
    });
    assert.ok(!listing.ok || Array.isArray(listing.data) && listing.data.length === 0);

    await reviews(second);
    const correction = { ...target(second), operation_id: randomUUID(), replaces: publication, correction_note: "Synthetic correction notice" };
    assert.equal((await rpc("release_version", correction, elevated)).ok, false);
    success(await rpc("decide_version", { ...target(second), approve: true }, elevated), "approve exact corrected version");
    sql(`update news.source_permissions set valid_until=now()-interval '1 hour' where id=${sqlValue(fixture.permission)};`);
    assert.equal((await rpc("release_version", correction, elevated)).ok, false);
    sql(`update news.source_permissions set valid_until=null where id=${sqlValue(fixture.permission)};`);
    const replacement = success(await rpc("release_version", correction, elevated), "publish correction");
    assert.equal(success(await rpc("release_version", correction, elevated), "replay correction"), replacement);
    assert.equal((await rpc("release_version", { ...correction, correction_note: "Different note" }, elevated)).ok, false);
    assert.equal(success(await publicStory(), "guest correction")[0].correction, correction.correction_note);

    sql(`update media.licences set valid_until=now()-interval '1 hour' where id=${sqlValue(fixture.licence)};`);
    assert.deepEqual(success(await publicMedia(), "expired media hidden"), []);
    assert.equal((await request(mediaDownload)).ok, false);
    assert.deepEqual(success(await publicStory(), "publication with expired rights hidden"), []);
    sql(`update media.licences set valid_until=null where id=${sqlValue(fixture.licence)};`);
    success(await rpc("revoke_right", { right_kind: "source", right_id: fixture.permission, reason_text: "Synthetic revocation" }, elevated), "revoke source");
    assert.deepEqual(success(await publicStory(), "revoked source hidden"), []);
    assert.deepEqual(success(await publicMedia(), "media with revoked source hidden"), []);
    const mediaRevocation = { right_kind: "media", right_id: fixture.licence, reason_text: "Synthetic licence revocation" };
    assert.equal((await rpc("revoke_right", mediaRevocation, owner.token)).status, 403);
    success(await rpc("revoke_right", mediaRevocation, elevated), "revoke licence");
    success(await rpc("revoke_right", mediaRevocation, elevated), "repeat licence revocation");
    assert.equal(sql(`select count(*) from governance.audit_events where action='rights.revoked'
      and target_id=${sqlValue(fixture.licence)};`), "1");
    success(await rpc("withdraw_publication", { publication: replacement, reason_text: "Synthetic withdrawal" }, elevated), "withdraw publication");
    assert.equal(sql(`select count(*) from editorial.publications where story_id=${sqlValue(fixture.story)};`), "2");
    assert.equal(sql(`select count(*) from governance.audit_events where action='publication.released'
      and target_id in (${sqlValue(publication)}, ${sqlValue(replacement)});`), "2");
    assert.equal(sql(`select count(*) from editorial.corrections where story_id=${sqlValue(fixture.story)};`), "1");
  });

  async function approvedFixture(title) {
    const story = await editorialFixture();
    const version = seal(title, true, story);
    await reviews(version);
    success(await rpc("decide_version", { ...target(version), approve: true }, elevated), "approve race fixture");
    return { story, version };
  }

  function releaseCounts(storyId) {
    return JSON.parse(sql(`
      select jsonb_build_object(
        'rows', count(*),
        'active', count(*) filter (where withdrawn_at is null),
        'audit', (select count(*) from governance.audit_events e
          join editorial.publications p on p.id = e.target_id
          where p.story_id = ${sqlValue(storyId)} and e.action = 'publication.released')
      ) from editorial.publications where story_id = ${sqlValue(storyId)};
    `));
  }

  await t.test("simultaneous releases with different keys commit exactly one publication", async () => {
    const { story, version } = await approvedFixture("Synthetic competing release");
    const competingVersion = seal("Synthetic alternative release", true, story);
    await reviews(competingVersion);
    success(await rpc("decide_version", { ...target(competingVersion), approve: true }, elevated), "approve competing version");
    const versions = [version, competingVersion];
    const operations = [randomUUID(), randomUUID()];
    const outcomes = await withOpenTransaction(
      `select id from editorial.stories where id = ${sqlValue(story.story)} for update;`,
      async (commit) => {
        const pending = Promise.allSettled(operations.map((operation_id, index) =>
          rpc("release_version", { ...target(versions[index]), operation_id }, elevated)));
        await waitForBlockedRequests("release_version", 2);
        await commit();
        return (await pending).map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          return outcome.value;
        });
      },
    );
    const winner = outcomes.findIndex((outcome) => outcome.ok);
    assert.notEqual(winner, -1, "one competing operation succeeds");
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.equal(outcomes[1 - winner].data.message, "Existing release requires a correction");
    const stored = JSON.parse(sql(`select jsonb_build_object('request', request_id, 'version', version_id)
      from editorial.publications where story_id = ${sqlValue(story.story)};`));
    assert.deepEqual(stored, { request: operations[winner], version: versions[winner].id });
    assert.deepEqual(releaseCounts(story.story), { rows: 1, active: 1, audit: 1 });
  });

  await t.test("publication and concurrent rights revocation serialize in both orders", async () => {
    // Hold one real RPC transaction open as the founder while the competing
    // request enters through PostgREST. These claims come from verified local MFA.
    const claims = JSON.parse(Buffer.from(elevated.split(".")[1], "base64url"));
    const asFounder = `set local role authenticated;
      select set_config('request.jwt.claims', ${sqlValue(JSON.stringify(claims))}, true) is not null;`;

    async function assertGuestDenied(story) {
      const args = { story_slug: story.slug };
      assert.deepEqual(success(await rpc("published_story", args), "guest article after revocation"), []);
      assert.deepEqual(success(await rpc("publication_media", {
        ...args, position_number: 1,
      }), "guest media metadata after revocation"), []);
      assert.equal((await request("/storage/v1/object/authenticated/editorial-private/" + story.objectKey)).ok,
        false, "guest cannot retrieve revoked media bytes");
    }

    const sourceRace = await approvedFixture("Synthetic source revocation wins");
    const sourceResult = await withOpenTransaction(`${asFounder}
      select geo_api.revoke_right('source', ${sqlValue(sourceRace.story.permission)}, 'Synthetic concurrent revocation');`,
    async (commit) => {
      const pending = rpc("release_version", {
        ...target(sourceRace.version), operation_id: randomUUID(),
      }, elevated).catch((error) => ({ error }));
      await waitForBlockedRequests("release_version");
      await commit();
      return pending;
    });
    assert.equal(sourceResult.ok, false);
    assert.equal(sourceResult.data.message, "Active rights required");
    assert.deepEqual(releaseCounts(sourceRace.story.story), { rows: 0, active: 0, audit: 0 });
    await assertGuestDenied(sourceRace.story);

    const mediaRace = await approvedFixture("Synthetic publication wins before licence revocation");
    const operation = randomUUID();
    await withOpenTransaction(`${asFounder}
      select geo_api.release_version(${sqlValue(mediaRace.version.id)}, ${sqlValue(mediaRace.version.digest)}, ${sqlValue(operation)});`,
    async (commit) => {
      const pending = rpc("revoke_right", {
        right_kind: "media", right_id: mediaRace.story.licence, reason_text: "Synthetic concurrent revocation",
      }, elevated).catch((error) => ({ error }));
      await waitForBlockedRequests("revoke_right");
      await commit();
      success(await pending, "concurrent licence revocation");
    });
    assert.equal(sql(`select request_id from editorial.publications
      where story_id = ${sqlValue(mediaRace.story.story)};`), operation);
    assert.deepEqual(releaseCounts(mediaRace.story.story), { rows: 1, active: 1, audit: 1 });
    assert.equal(sql(`select count(*) from governance.audit_events
      where action = 'rights.revoked' and target_id = ${sqlValue(mediaRace.story.licence)};`), "1");
    await assertGuestDenied(mediaRace.story);
  });

  await t.test("SQL grants, immutable snapshots, and live role revocation", async () => {
    assert.equal(sql("show timezone;"), "UTC");
    assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and not c.relrowsecurity
        and n.nspname in ('app','news','research','editorial','ai_ops','media','forecasting','community','billing','governance');`), "0");
    assert.equal(sql(`select has_table_privilege('authenticated','editorial.publications','INSERT')
      or has_table_privilege('authenticated','governance.audit_events','DELETE');`), "f");
    assert.throws(() => sql(`update editorial.story_versions set article='{}'
      where story_id=${sqlValue(fixture.story)};`), /Sealed records are immutable/);
    assert.equal((await rpc("set_role", { target_user: founder.id, role_code: "super_admin", enabled: false }, elevated)).ok, false);
    success(await rpc("set_role", { target_user: founder.id, role_code: "human_publisher", enabled: false }, elevated), "revoke publishing role");
    assert.equal((await rpc("withdraw_publication", { publication: randomUUID(), reason_text: "Synthetic" }, elevated)).status, 403);
  });
});
