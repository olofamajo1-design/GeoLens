import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";

const project = "geolens-security";
const cli = process.env.GEOLENS_SUPABASE_CLI ?? "supabase";
const localApi = "http://127.0.0.1:54321";

function sql(query) {
  return execFileSync("docker", [
    "exec", "-i", "supabase_db_" + project, "psql", "-X", "-U", "postgres",
    "-v", "ON_ERROR_STOP=1", "-qAt",
  ], { input: query, encoding: "utf8" }).trim();
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

  const slug = "synthetic-" + randomUUID();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FEkAAAAASUVORK5CYII=", "base64");
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

  function seal(title, includeMedia = true) {
    const id = sql(`
      select editorial.seal_version(${sqlValue(fixture.story)}, jsonb_build_object('title',${sqlValue(title)},'body','Fictional article'),
        jsonb_build_array(jsonb_build_object('document_id',${sqlValue(fixture.document)},'permission_id',${sqlValue(fixture.permission)})),
        case when ${includeMedia} then
          jsonb_build_array(jsonb_build_object('asset_version_id',${sqlValue(fixture.media)},'licence_id',${sqlValue(fixture.licence)}))
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
