import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { articleWords } from "../../src/newsroom/editorial/writing.ts";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { attemptLease, fixtureResult, seedEditorialVisuals, seedEvidenceChart } from "../helpers/editorial-fixtures.mjs";
import { localSupabase, quote, sql } from "../helpers/newsroom-fixtures.mjs";
import { ingestResearchFixture, researchRunFor } from "../helpers/research-fixtures.mjs";

const month = "date_trunc('month',now() at time zone 'UTC')::date";

test("the integrated synthetic newsroom protects evidence, revisions and human decisions", { timeout: 120_000 }, async (t) => {
  const { createUser, caller, response, adminKey, elevate } = localSupabase();
  const token = await createUser("newsroom_operator");
  const operator = caller(token);
  const ingestion = caller(await createUser("ingestion_operator"));
  const reviewerAal1 = await createUser("human_editor", "human_publisher");
  const reviewer = await elevate(reviewerAal1);
  const human = caller(reviewer);
  const member = await createUser();
  const scanArgs = { prompt_manifest: promptManifest };
  const scan = () => operator("scan_newsroom_integration", scanArgs);
  const claim = (target_run) => operator("claim_newsroom_integration", { target_run, ...scanArgs });
  const status = (target_run) => operator("newsroom_fixture_status", { target_run });
  const edition = (target_run) => operator("newsroom_edition", { target_run });
  const start = (item) => operator("start_newsroom_fixture", attemptLease(item));
  const spend = () => sql(`select amount_minor from ai_ops.discovery_usage where scope='development' and month=${month};`);
  const setSpend = (value) => sql(`update ai_ops.discovery_usage set amount_minor=${value} where scope='development' and month=${month};`);
  const targets = new Set();

  async function enroll({ variant = "complete", chart = true } = {}) {
    const fixture = await ingestResearchFixture(ingestion, variant);
    if (chart) assert.ok(seedEvidenceChart(fixture.event));
    await scan();
    const run = researchRunFor(fixture.event);
    assert.match(run, /^[a-f0-9-]{36}$/);
    targets.add(run);
    return { ...fixture, run };
  }

  async function finish(item, result) {
    const lease = attemptLease(item);
    const usage = { in_tokens: result.inputTokens, out_tokens: result.outputTokens };
    return item.productionInput
      ? operator("finish_newsroom_edition", { ...lease, ...usage, production_result: result.productionResult })
      : operator("finish_newsroom_fixture", { ...lease, ...usage, result: result.output, research_result: result.researchResult });
  }

  async function advance(run, expected, alter = (result) => result) {
    for (let batch = 0; batch < 18; batch++) {
      const next = await claim(run);
      assert.ok(next.claims.length, JSON.stringify({ expected, next, status: await status(run) }));
      const outcomes = await Promise.all(next.claims.map(async (item) => {
        if (!await start(item)) return "stale";
        return finish(item, alter(await fixtureResult(item), item));
      }));
      if (outcomes.includes(expected)) return;
    }
    assert.fail("The fixture did not reach " + expected);
  }

  function decision(run, version, action, args = {}) {
    return { target_run: run, target_version: version.id, expected_digest: version.digest,
      operation_key: randomUUID(), human_action: action, ...args };
  }

  function release(version, token) {
    return response("release_version", { target_version: version.id, expected_digest: version.digest,
      operation_id: randomUUID() }, token);
  }

  function storySlug(run) {
    return sql(`select s.slug from ai_ops.workflow_runs w join editorial.stories s on s.id=w.fixture_story_id where w.id=${quote(run)};`);
  }

  async function assertPrivate(run, version) {
    const story_slug = storySlug(run);
    assert.deepEqual(await caller()("published_story", { story_slug }), []);
    assert.deepEqual(await caller()("publication_media", { story_slug, position_number: 1 }), []);
    assert.equal(sql(`select count(*) from editorial.publications p join editorial.stories s on s.id=p.story_id
      where s.slug=${quote(story_slug)};`), "0");
    if (version) assert.equal(sql(`select count(*) from editorial.story_versions where id=${quote(version.id)};`), "0");
  }

  sql(`insert into ai_ops.discovery_usage(month,scope,amount_minor) values (${month},'development',0) on conflict do nothing;`);
  const previous = Number(spend());
  setSpend(0);
  try {
    await t.test("B. independent contradictory evidence keeps the investigation in verification escalation", async () => {
      const { run } = await enroll({ variant: "conflict", chart: false });
      await advance(run, "escalated");
      const findings = await operator("newsroom_research_findings", { target_run: run });
      const verification = findings.find(({ payload }) => payload.stage === "verification").payload;
      const disputed = verification.claims.find(({ sensitive }) => sensitive);
      assert.ok(disputed.supporting.evidenceIds.length && disputed.contradictory.evidenceIds.length);
      assert.equal(disputed.recommendedAction, "escalate");
      assert.equal((await status(run)).reason, "critical_finding:verification");
      assert.equal(await edition(run), null);
      assert.equal(findings.some(({ payload }) => payload.stage === "analysis"), false);
      assert.ok((await human("newsroom_fixture_review_queue")).some(({ id, state }) => id === run && state === "escalated"));
    });

    await t.test("C. a fabricated citation is rejected before the edition can be sealed", async () => {
      const { run } = await enroll();
      await advance(run, "research_ready");
      const { claims } = await claim(run);
      const writing = claims.find(({ task }) => task.stage === "writing");
      assert.ok(await start(writing));
      const result = await fixtureResult(writing);
      const fact = result.productionResult.articles[0].sections.flatMap(({ blocks }) => blocks)
        .find(({ frame }) => frame === "verified_fact");
      fact.evidenceIds = [randomUUID()];
      assert.equal(await finish(writing, result), "retry");
      assert.deepEqual((await edition(run)).versions, []);
      assert.equal((await status(run)).tasks.find(({ stage }) => stage === "writing").attempts[0].failure, "invalid_output");
      assert.ok(await operator("cancel_newsroom_fixture", { target_run: run }));
    });

    await t.test("D. a drafting proposal triggers an independent recheck and stays outside the article", async () => {
      const { run } = await enroll();
      const statement = "The exercise reached every coastal settlement.";
      await advance(run, "escalated", (result, { task }) => {
        if (task.stage === "writing") result.productionResult.proposedClaims = [{ statement, evidenceIds: [] }];
        return result;
      });
      const [version] = (await edition(run)).versions;
      assert.equal((await status(run)).reason, "critical_finding:reverification");
      assert.equal(version.reviews.length, 1);
      const [check] = version.reviews;
      assert.equal(check.status, "hold");
      assert.deepEqual(check.critical, ["unverified_claim"]);
      assert.equal(check.unresolved[0].statement, statement);
      assert.ok(!JSON.stringify(version.article.articles).includes(statement));
      await assertPrivate(run, version);
    });

    await t.test("E. a revoked media licence overrides an otherwise passing AI review", async () => {
      const fixture = await enroll({ chart: false });
      await advance(fixture.run, "research_ready");
      const { photo } = await seedEditorialVisuals(operator, fixture, adminKey);
      await advance(fixture.run, "escalated", (result, { task }) => {
        if (task.stage === "editorial") {
          assert.equal(result.productionResult.decision, "ready_for_human_review");
          sql(`update media.licences set revoked_at=clock_timestamp() where id=${quote(photo.licence)};`);
        }
        return result;
      });
      const saved = await edition(fixture.run);
      const [version] = saved.versions;
      const review = version.reviews.find(({ stage }) => stage === "editorial");
      assert.equal(review.decision, "hold");
      assert.ok(review.score >= 85);
      assert.ok(review.issues.some(({ code, severity }) => code === "rights" && severity === "critical"));
      assert.equal(saved.readyForHumanReview, false);
      assert.equal((await response("review_newsroom_edition", decision(fixture.run, version, "approve"), reviewer)).ok, false);
      await assertPrivate(fixture.run, version);
    });

    await t.test("E. source rights revoked during a paused handoff stop edition work", async () => {
      const { run, sourceIds } = await enroll();
      await advance(run, "research_ready");
      sql(`update news.acquisition_licences set revoked_at=clock_timestamp() where id=(
        select licence_id from news.discovery_provenance where document_id=${quote(sourceIds[0])});`);
      const paused = await claim(run);
      assert.equal(paused.state, "escalated");
      assert.deepEqual(paused.claims, []);
      assert.equal((await status(run)).reason, "edition_source_rights");
      assert.equal(await edition(run), null);
    });

    await t.test("F. major writing and minor visual corrections each trigger successful exact-version re-review", async () => {
      const { run, event } = await enroll({ chart: false });
      await advance(run, "revision_queued", (result, { task }) => {
        if (task.stage === "writing") {
          const deep = result.productionResult.articles.find(({ format }) => format === "deep_dive");
          deep.sections = deep.sections.filter(({ kind }) => kind !== "history");
          deep.wordCount = articleWords(deep.standfirst, deep.sections.flatMap(({ blocks }) => blocks));
        }
        return result;
      });
      const major = (await edition(run)).versions[0].reviews.find(({ stage }) => stage === "editorial");
      assert.equal(major.decision, "major_revision");
      assert.equal(major.issues[0].agentId, "GL-AGENT-006");
      await advance(run, "revision_queued", (result, item) => {
        if (item.task.stage === "writing") assert.deepEqual(item.productionInput.revisionIssues[0], major.issues[0]);
        return result;
      });
      const minor = (await edition(run)).versions[1].reviews.find(({ stage }) => stage === "editorial");
      assert.equal(minor.decision, "minor_revision");
      assert.equal(minor.issues[0].agentId, "GL-AGENT-007");
      assert.ok(seedEvidenceChart(event));
      await advance(run, "human_review", (result, item) => {
        if (item.task.stage === "visual") assert.deepEqual(item.productionInput.revisionIssues, minor.issues);
        return result;
      });
      const saved = await edition(run);
      assert.equal(saved.readyForHumanReview, true);
      assert.equal(saved.versions.length, 3);
      assert.equal(new Set(saved.versions.map(({ digest }) => digest)).size, 3);
      for (const version of saved.versions) {
        assert.equal(version.reviews.length, 2);
        assert.ok(version.reviews.every(({ version: reviewed }) => reviewed.digest === version.digest));
      }
    });

    await t.test("G. a third visual revision request escalates and retains every review", async () => {
      const { run } = await enroll({ chart: false });
      await advance(run, "escalated");
      const record = await status(run);
      const saved = await edition(run);
      assert.equal(record.reason, "revision_limit:visual");
      assert.equal(record.tasks.filter(({ stage }) => stage === "visual").length, 3);
      assert.equal(saved.versions.length, 3);
      assert.equal(saved.readyForHumanReview, false);
      assert.equal(saved.currentVersionId, null);
      assert.ok(saved.versions.every(({ reviews }) => reviews.some(({ decision }) => decision === "minor_revision")));
    });

    await t.test("H and I. a withheld or rejected decision keeps the exact edition private", async () => {
      const { run } = await enroll();
      await advance(run, "human_review");
      const pending = await edition(run);
      assert.equal(pending.currentDecision, null);
      assert.equal(pending.approvalCurrent, false);
      assert.equal(pending.readyForHumanReview, true);
      const [version] = pending.versions;
      const approve = decision(run, version, "approve");
      for (const actor of [token, member, reviewerAal1]) {
        assert.equal((await response("review_newsroom_edition", approve, actor)).status, 403);
        assert.equal((await release(version, actor)).status, 403);
      }
      assert.equal((await response("newsroom_edition", { target_run: run }, member)).status, 403);
      assert.equal((await response("scan_newsroom_integration", scanArgs, reviewer)).status, 403);
      assert.equal((await response("claim_newsroom_integration", { target_run: run, ...scanArgs }, member)).status, 403);
      assert.match(await (await release(version, reviewer)).text(), /Version or digest mismatch/);
      await assertPrivate(run, version);

      const reject = decision(run, version, "reject", { note_text: "Synthetic reviewer declines this version." });
      const actionId = await human("review_newsroom_edition", reject);
      assert.equal(await human("review_newsroom_edition", reject), actionId);
      const declined = await edition(run);
      assert.equal(declined.currentDecision, "reject");
      assert.equal(declined.approvalCurrent, false);
      assert.equal(declined.readyForHumanReview, false);
      assert.equal(declined.humanActions.length, 1);
      assert.ok(!(await human("newsroom_fixture_review_queue")).some(({ id }) => id === run));
      assert.equal((await response("review_newsroom_edition", approve, reviewer)).ok, false);
      await assertPrivate(run, version);
    });

    await t.test("J. parallel leases, retries and budget exhaustion keep their original fences", async () => {
      const { run } = await enroll();
      const [discovery] = (await claim(run)).claims;
      assert.ok(await start(discovery));
      assert.equal(await finish(discovery, await fixtureResult(discovery)), "succeeded");
      const parallel = (await Promise.all([claim(run), claim(run), claim(run)])).flatMap(({ claims }) => claims);
      assert.deepEqual(parallel.map(({ task }) => task.stage).sort(), ["history", "verification"]);
      assert.equal(new Set(parallel.map(({ task }) => task.taskId)).size, 2);
      for (const item of parallel) {
        const seconds = Number(sql(`select extract(epoch from (a.lease_expires_at-t.available_at))
          from ai_ops.task_attempts a join ai_ops.agent_tasks t on t.id=a.task_id where a.id=${quote(item.task.attemptId)};`));
        assert.ok(seconds >= (item.task.stage === "history" ? 300 : 180));
      }
      const check = parallel.find(({ task }) => task.stage === "verification");
      const fail = async (item) => {
        assert.ok(await start(item));
        return operator("finish_newsroom_fixture", { ...attemptLease(item), failure: "provider_error" });
      };
      assert.equal(await fail(check), "retry");
      const reschedule = ({ task }, pause) => {
        const elapsed = Number(sql(`select extract(epoch from (t.available_at-a.finished_at))
          from ai_ops.agent_tasks t join ai_ops.task_attempts a on a.task_id=t.id where a.id=${quote(task.attemptId)};`));
        assert.ok(elapsed >= pause && elapsed < pause + 1);
        sql(`update ai_ops.agent_tasks set available_at=clock_timestamp() where id=${quote(task.taskId)};`);
      };
      reschedule(check, 5);
      const [second] = (await claim(run)).claims;
      assert.equal(second.task.attempt, 2);
      assert.equal(await fail(second), "retry");
      reschedule(second, 30);
      setSpend(5000);
      try {
        const blocked = await claim(run);
        assert.equal(blocked.budgetBlocked, true);
        assert.deepEqual(blocked.claims, []);
        assert.equal((await status(run)).reason, "budget_blocked");
        const budget = await operator("newsroom_fixture_budget");
        assert.equal(budget.launchLimitMinor, 30_000);
        assert.equal(budget.fixtureActualMinor, 0);
      } finally {
        setSpend(0);
      }
      sql(`update ai_ops.workflow_runs set budget_retry_at=clock_timestamp() where id=${quote(run)};`);
      const [third] = (await claim(run)).claims;
      assert.equal(third.task.attempt, 3);
      assert.equal(await fail(third), "escalated");
      assert.equal((await claim(run)).state, "escalated");
      assert.equal(await start(parallel.find(({ task }) => task.stage === "history")), false);
      assert.equal((await status(run)).reason, "attempts_exhausted:provider_error");
    });

    await t.test("K. competing scans recover a stopped research handoff without duplicate work", async () => {
      const { run } = await enroll();
      await advance(run, "research_ready");
      assert.equal(await edition(run), null);
      const scans = await Promise.all([scan(), scan()]);
      assert.ok(scans.every((runs) => runs.includes(run)));
      const batches = await Promise.all([claim(run), claim(run)]);
      const work = batches.flatMap(({ claims }) => claims);
      assert.deepEqual(work.map(({ task }) => task.stage).sort(), ["visual", "writing"]);
      await Promise.all(work.map(async (item) => {
        const launches = await Promise.all([start(item), start(item)]);
        assert.deepEqual(launches.sort(), [false, true]);
        const result = await fixtureResult(item);
        assert.equal(await finish(item, result), "succeeded");
        assert.equal(await finish(item, result), "stale");
      }));
      await advance(run, "human_review");
      assert.equal((await edition(run)).versions.length, 1);
      assert.ok((await status(run)).tasks.every(({ attempts }) => attempts.length === 1));
      const actions = sql(`select string_agg(action,',' order by occurred_at) from governance.audit_events where target_id=${quote(run)};`);
      assert.equal(actions.split(",").filter((action) => action === "newsroom.integration_advanced").length, 1);
      assert.equal(actions.split(",").filter((action) => action === "newsroom.human_review_requested").length, 1);
    });

    await t.test("L. a material visual revision invalidates an MFA decision on the previous exact edition", async () => {
      const fixture = await enroll();
      const { run } = fixture;
      await advance(run, "human_review");
      const [first] = (await edition(run)).versions;
      const approve = decision(run, first, "approve");
      const invalid = { ...approve, expected_digest: "0".repeat(64) };
      assert.match(await (await response("review_newsroom_edition", invalid, reviewer)).text(), /Current exact private edition required/);
      const recorded = await human("review_newsroom_edition", approve);
      assert.equal(await human("review_newsroom_edition", approve), recorded);
      const approved = await edition(run);
      assert.equal(approved.approvalCurrent, true);
      assert.ok(!(await human("newsroom_fixture_review_queue")).some(({ id }) => id === run));
      assert.equal(approved.humanActions[0].digest, first.digest);
      assert.equal(approved.humanActions[0].verificationAttemptId, first.reviews.find(({ stage }) => stage === "reverification").attemptId);
      await assertPrivate(run, first);

      const note = "Add the licensed synthetic media with a descriptive caption.";
      const revise = decision(run, first, "revise", { note_text: note, requested_stage: "visual" });
      const request = await human("review_newsroom_edition", revise);
      assert.equal(await human("review_newsroom_edition", revise), request);
      assert.equal((await edition(run)).approvalCurrent, false);
      const { photo } = await seedEditorialVisuals(operator, fixture, adminKey, { includeDerived: false });
      await advance(run, "human_review", (result, item) => {
        if (item.task.stage === "visual") assert.ok(item.productionInput.revisionInstructions.includes(note));
        return result;
      });
      const revised = await edition(run);
      const second = revised.versions[1];
      assert.notEqual(second.digest, first.digest);
      assert.equal(second.visual.assets.length, first.visual.assets.length + 2);
      assert.ok(second.visual.assets.some(({ data, caption }) => data.kind === "photo" && caption));
      assert.equal(revised.currentDecision, null);
      assert.equal(revised.approvalCurrent, false);
      assert.equal(revised.readyForHumanReview, true);
      assert.ok((await human("newsroom_fixture_review_queue")).some(({ id }) => id === run));
      assert.deepEqual(revised.humanActions.map(({ action }) => action), ["approve", "revise"]);
      assert.equal((await response("review_newsroom_edition", decision(run, first, "approve"), reviewer)).ok, false);
      assert.match(await (await release(second, reviewer)).text(), /Version or digest mismatch/);
      await human("review_newsroom_edition", decision(run, second, "approve"));
      assert.equal((await edition(run)).approvalCurrent, true);
      sql(`update media.licences set revoked_at=clock_timestamp() where id=${quote(photo.licence)};`);
      const revoked = await edition(run);
      assert.equal(revoked.approvalCurrent, false);
      assert.equal(revoked.readyForHumanReview, false);
      assert.equal(revoked.humanActions.length, 3);
      const blocked = await response("review_newsroom_edition", decision(run, second, "approve"), reviewer);
      assert.match(await blocked.text(), /Active edition rights required/);
      await assertPrivate(run, second);
    });
  } finally {
    for (const target_run of targets) await operator("cancel_newsroom_fixture", { target_run });
    setSpend(previous);
  }
});
