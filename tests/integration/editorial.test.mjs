import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { articleWords } from "../../src/newsroom/editorial/writing.ts";
import { localSupabase, quote, sql } from "../helpers/newsroom-fixtures.mjs";
import { attemptLease, fixtureResult, runResearchFixture, seedEditorialVisuals } from "../helpers/editorial-fixtures.mjs";

test("the private fixture edition validates writing, visual rights and exact-version review", { timeout: 120_000 }, async (t) => {
  const { caller, createUser, response, adminKey } = localSupabase();
  const token = await createUser("newsroom_operator");
  const operator = caller(token);
  const ingestion = caller(await createUser("ingestion_operator"));
  const outsider = await createUser();
  const spend = sql("select coalesce(max(amount_minor),0) from ai_ops.discovery_usage where scope='development';");
  sql("update ai_ops.discovery_usage set amount_minor=0 where scope='development';");

  async function prepare(options) {
    const research = await runResearchFixture(operator, ingestion);
    const visual = await seedEditorialVisuals(operator, research, adminKey, options);
    assert.equal(await operator("queue_newsroom_edition", {
      target_run: research.run, prompt_manifest: promptManifest, featured_format: "historical_explainer",
    }), true);
    return { ...research, ...visual };
  }
  const edition = (run) => operator("newsroom_edition", { target_run: run });
  const claim = (run) => operator("claim_newsroom_editions", { target_run: run });
  const finish = (item, output, usage = { inputTokens: 500, outputTokens: 400 }) =>
    operator("finish_newsroom_edition", { ...attemptLease(item), production_result: output,
      in_tokens: usage.inputTokens, out_tokens: usage.outputTokens });

  async function execute(item, change = (output) => output) {
    assert.ok(await operator("start_newsroom_fixture", attemptLease(item)));
    const result = await fixtureResult(item);
    return finish(item, change(result.productionResult), result);
  }
  function shorten(output) {
    output.articles = output.articles.map((article) => {
      if (article.format !== "deep_dive") return article;
      const sections = article.sections.filter(({ kind }) => kind !== "history");
      return { ...article, sections, wordCount: articleWords(article.standfirst, sections.flatMap(({ blocks }) => blocks)) };
    });
    return output;
  }
  async function completeAssets(run, writing) {
    const { claims } = await claim(run);
    for (const item of claims) assert.equal(await execute(item, item.task.stage === "writing" ? writing : undefined), "succeeded");
    const { claims: [verify] } = await claim(run);
    assert.equal(verify.task.stage, "reverification");
    return verify;
  }

  try {
    await t.test("independent roles preserve the paired draft, seven visual specs and licensed provenance", async () => {
      const { run } = await prepare();
      assert.equal(await operator("queue_newsroom_edition", { target_run: run, prompt_manifest: promptManifest }), false);
      assert.ok((await operator("ready_newsroom_editions")).includes(run));
      assert.equal((await operator("claim_newsroom_fixtures", { target_run: run })).state, "missing");
      assert.ok(!(await operator("scan_newsroom_fixtures", { research_mode: true, prompt_manifest: promptManifest })).includes(run));
      const verify = await completeAssets(run);
      assert.equal(await execute(verify), "succeeded");
      const [editor] = (await claim(run)).claims;
      assert.equal(editor.productionInput.version.digest, verify.productionInput.version.digest);
      assert.equal(await execute(editor), "human_review");
      const saved = await edition(run);
      assert.equal(saved.readyForHumanReview, true);
      assert.equal(saved.versions.length, 1);
      const version = saved.versions[0];
      assert.deepEqual(version.article.articles.map(({ format }) => format), ["quick_brief", "deep_dive", "historical_explainer"]);
      for (const article of version.article.articles) assert.equal(article.headlines.length, 3);
      const [brief, deep] = version.article.articles;
      assert.ok(brief.wordCount >= 150 && brief.wordCount <= 300, "brief word count " + brief.wordCount);
      assert.ok(deep.wordCount >= 900 && deep.wordCount <= 1500, "deep dive word count " + deep.wordCount);
      const claims = (article) => article.sections.flatMap(({ blocks }) =>
        blocks.filter(({ frame }) => frame === "verified_fact").flatMap(({ claimIds }) => claimIds));
      assert.deepEqual(claims(brief), claims(deep));
      for (const block of deep.sections.flatMap(({ blocks }) => blocks)) {
        assert.ok(block.evidenceIds.every((id) => saved.evidence.some((item) =>
          item.id === id && item.locator && saved.sources.some(({ documentId }) => documentId === item.documentId))));
      }
      assert.ok(deep.sections.some(({ kind }) => kind === "history") && deep.sections.some(({ kind }) => kind === "scenarios"));
      assert.equal(brief.metadata.seoTitle, brief.headlines[0]);
      assert.equal(brief.metadata.socialSummary, brief.standfirst);
      assert.ok(brief.metadata.seoDescription.length <= 160);
      assert.ok(brief.metadata.tags.length > 0);
      assert.deepEqual(brief.metadata.wordCountGuideline, { minWords: 150, maxWords: 300, allowsLonger: false });
      assert.ok(version.article.articles[2].metadata.categories.includes("history"));
      assert.deepEqual(version.article.articles[2].metadata.tags, brief.metadata.tags);
      assert.equal(version.visual.assets.length, 7);
      for (const asset of version.visual.assets) {
        assert.equal(asset.licence.status, "active");
        assert.ok(asset.alt && asset.caption && asset.uncertainty && asset.documentIds.length);
        assert.ok(asset.title && asset.purpose && asset.licence.terms);
        assert.equal(asset.snapshot.dataDigest, asset.digest);
        assert.match(asset.snapshot.capturedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
        assert.equal(asset.quality.score, 100);
        assert.equal(asset.quality.ratings.geographical_accuracy, asset.data.kind === "map" ? 100 : null);
      }
      assert.equal(version.visual.assets.find(({ data }) => data.kind === "chart").data.values[0].value, 1200);
      assert.equal(version.visual.assets.find(({ data }) => data.kind === "illustration").data.disclosure, "AI-generated synthetic illustration");
      assert.ok(version.reviews.every((review) => review.version.digest === version.digest));
      const review = version.reviews.find(({ stage }) => stage === "editorial");
      assert.equal(review.decision, "ready_for_human_review");
      assert.ok(review.score >= 85);

      assert.equal((await response("newsroom_edition", { target_run: run }, outsider)).status, 403);
      assert.equal((await response("queue_newsroom_edition", { target_run: run, prompt_manifest: promptManifest }, outsider)).status, 403);
      assert.equal((await response("release_version", { target_version: version.id, expected_digest: version.digest,
        operation_id: randomUUID() }, token)).status, 403);
      assert.equal(sql(`select count(*) from editorial.story_versions where id=${quote(version.id)};`), "0");
      assert.equal(sql(`select count(*) from editorial.publications p join ai_ops.workflow_runs w on w.fixture_story_id=p.story_id
        where w.id=${quote(run)};`), "0");
    });

    await t.test("fabricated quotations and citation references fail at the database boundary", async () => {
      const { run } = await prepare({ includeMedia: false });
      const { claims } = await claim(run);
      const writing = claims.find(({ task }) => task.stage === "writing");
      assert.equal(await execute(writing, (output) => {
        const fact = output.articles[0].sections.flatMap(({ blocks }) => blocks).find(({ frame }) => frame === "verified_fact");
        fact.text = "The director said “A fabricated interview.”";
        fact.evidenceIds = [randomUUID()];
        return output;
      }), "retry");
      assert.deepEqual((await edition(run)).versions, []);
    });

    await t.test("new factual proposals reach GL-AGENT-004 and stay outside the article pending verification", async () => {
      const { run } = await prepare({ includeMedia: false });
      const verify = await completeAssets(run, (output) => {
        output.proposedClaims = [{ statement: "The board doubled the number of covered households.", evidenceIds: [] }];
        return output;
      });
      assert.equal(verify.task.agentId, "GL-AGENT-004");
      assert.equal(await execute(verify), "escalated");
      const saved = await edition(run);
      assert.equal(saved.readyForHumanReview, false);
      const [check] = saved.versions[0].reviews;
      assert.deepEqual(check.critical, ["unverified_claim"]);
      assert.equal(check.unresolved.length, 1);
      assert.ok(!JSON.stringify(saved.versions[0].article.articles).includes("doubled"));
    });

    await t.test("the database rejects forged search metadata, snapshot dates and rubric scores", async () => {
      const { run } = await prepare({ includeMedia: false });
      const { claims } = await claim(run);
      const writing = claims.find(({ task }) => task.stage === "writing");
      const visual = claims.find(({ task }) => task.stage === "visual");
      assert.equal(await execute(writing, (output) => {
        output.articles[0].metadata.tags = ["Invented topic"];
        return output;
      }), "retry");
      assert.equal(await execute(visual, (output) => {
        output.assets[0].snapshot.observedOn = "2026-01-01";
        output.assets[0].quality.ratings.geographical_accuracy = 20;
        return output;
      }), "retry");
      assert.deepEqual((await edition(run)).versions, []);
    });

    await t.test("expired and missing image grants stay out of the edition", async () => {
      const { run } = await prepare({ expirePhoto: true, omitIllustrationGrant: true });
      const { claims } = await claim(run);
      const writing = claims.find(({ task }) => task.stage === "writing");
      const visual = claims.find(({ task }) => task.stage === "visual");
      const expired = visual.productionInput.candidates.find((asset) => asset.data.kind === "photo");
      const missing = visual.productionInput.candidates.find((asset) => asset.data.kind === "illustration");
      assert.equal(expired.licence.status, "expired");
      assert.ok(Date.parse(expired.licence.validUntil) < Date.parse(expired.snapshot.capturedAt));
      assert.equal(missing.licence.status, "missing");
      const result = await fixtureResult(visual);
      assert.equal(result.productionResult.assets.length, 5);
      assert.deepEqual(new Set(result.productionResult.blockedAssetIds), new Set([expired.id, missing.id]));
      assert.equal(await execute(writing), "succeeded");
      assert.equal(await execute(visual), "succeeded");
      const [recheck] = (await claim(run)).claims;
      assert.equal(await execute(recheck), "escalated");
      assert.equal((await edition(run)).readyForHumanReview, false);
    });

    await t.test("a media licence revoked during review blocks a score above the threshold", async () => {
      const { run, photo } = await prepare();
      const verify = await completeAssets(run);
      assert.equal(await execute(verify), "succeeded");
      const [editor] = (await claim(run)).claims;
      assert.ok(await operator("start_newsroom_fixture", attemptLease(editor)));
      const result = await fixtureResult(editor);
      assert.equal(result.productionResult.decision, "ready_for_human_review");
      sql(`update media.licences set revoked_at=clock_timestamp() where id=${quote(photo.licence)};`);
      assert.equal(await finish(editor, result.productionResult, result), "escalated");
      const saved = await edition(run);
      const review = saved.versions[0].reviews.find(({ stage }) => stage === "editorial");
      assert.ok(review.score >= 85);
      assert.equal(review.decision, "hold");
      assert.equal(review.issues[0].severity, "critical");
      assert.equal(review.issues[0].detail.blocksPublication, true);
      assert.ok(review.issues[0].detail.evidenceGap);
      assert.equal(saved.readyForHumanReview, false);
    });

    await t.test("each material revision retires the old package and requires fresh review, with a two-cycle cap", async () => {
      const { run } = await prepare({ includeMedia: false });
      let verification = await completeAssets(run, shorten);
      const digests = [];
      for (let round = 0; round <= 2; round++) {
        digests.push(verification.productionInput.version.digest);
        assert.equal(await execute(verification), "succeeded");
        const [editor] = (await claim(run)).claims;
        assert.equal(editor.productionInput.verification.version.digest, digests[round]);
        assert.equal(await execute(editor), round === 2 ? "escalated" : "revision_queued");
        const saved = await edition(run);
        assert.equal(saved.currentVersionId, null);
        assert.equal(saved.readyForHumanReview, false);
        assert.equal(saved.versions.length, round + 1);
        const correction = saved.versions[round].reviews.find(({ stage }) => stage === "editorial").issues[0];
        assert.deepEqual(correction.detail.affected, [{ kind: "section", ref: "deep_dive:history" }]);
        assert.ok(correction.detail.problem && correction.detail.evidenceIds.length > 0);
        assert.equal(correction.detail.blocksPublication, true);
        if (round < 2) {
          const [writing] = (await claim(run)).claims;
          assert.ok(writing.productionInput.revisionInstructions.some((text) => text.includes("historical")));
          assert.deepEqual(writing.productionInput.revisionIssues[0], correction);
          assert.equal(await execute(writing, shorten), "succeeded");
          [verification] = (await claim(run)).claims;
        }
      }
      assert.equal(new Set(digests).size, 3);
      const status = await operator("newsroom_fixture_status", { target_run: run });
      assert.equal(status.reason, "revision_limit:writing");
    });

    await t.test("a revised visual manifest seals a fresh version and rejects reused verification", async () => {
      const fixture = await prepare({ includeMedia: false, includeDerived: false });
      const { run } = fixture;
      const initial = await completeAssets(run);
      const first = await fixtureResult(initial);
      assert.equal(await execute(initial), "succeeded");
      const [editor] = (await claim(run)).claims;
      assert.equal(await execute(editor), "revision_queued");
      assert.equal((await edition(run)).currentVersionId, null);

      await seedEditorialVisuals(operator, fixture, adminKey, { includeMedia: false });
      const [visual] = (await claim(run)).claims;
      assert.equal(visual.task.stage, "visual");
      assert.ok(visual.productionInput.revisionInstructions.some((instruction) => instruction.includes("accessible visual")));
      assert.equal(await execute(visual), "succeeded");
      const [second] = (await claim(run)).claims;
      assert.notEqual(second.productionInput.version.digest, first.productionResult.version.digest);
      assert.equal(await execute(second, (output) => ({ ...output, version: first.productionResult.version })), "retry");
      sql(`update ai_ops.agent_tasks set available_at=clock_timestamp() where id=${quote(second.task.taskId)};`);
      const [retry] = (await claim(run)).claims;
      assert.equal(await execute(retry), "succeeded");
      const [review] = (await claim(run)).claims;
      assert.equal(await execute(review), "human_review");
      const saved = await edition(run);
      assert.equal(saved.currentVersionId, saved.versions[1].id);
      assert.equal(saved.versions[0].article.attemptId, saved.versions[1].article.attemptId);
      assert.equal(saved.versions[1].visual.assets.length, 5);
    });
  } finally {
    sql(`update ai_ops.discovery_usage set amount_minor=${Number(spend)} where scope='development';`);
  }
});
