import { describe, expect, it, vi } from "vitest";
import { executeFixture, type Claim } from "../../src/newsroom/execution";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { analyze } from "../../src/newsroom/research/analysis";
import { buildResearchResult, validateResearchInput, validateResearchResult, verifyDisposition } from "../../src/newsroom/research/contracts";
import { discover } from "../../src/newsroom/research/discovery";
import { investigateHistory } from "../../src/newsroom/research/history";
import type { AnalysisInput, DiscoveryInput, HistoryInput, ResearchInput, VerificationInput } from "../../src/newsroom/research/types";
import { verify } from "../../src/newsroom/research/verification";
import { createOpenAIFixtureProvider } from "../../src/providers/openai-fixture.server";
import {
  analysisMaterial, evidence, fixtureId, historyMaterial, injectionText, observation, sampleAttempt, sampleDate, sampleEvent,
  sampleSources, source, verificationMaterial,
} from "../fixtures/research";

const packet = { contractVersion: 1, synthetic: true, eventId: sampleEvent, attemptId: sampleAttempt, sources: sampleSources } as const;
const discovery: DiscoveryInput = {
  ...packet, stage: "discovery", headline: "Synthetic coastal relief coordination", locations: [{ name: "Lagos", country: "NG" }],
  entities: ["Synthetic Civic Board"], ingestionLabel: "review",
  scores: { impact: 80, evidence: 50, urgency: 60, regional: 100, historical: 90 },
  priority: "high", verificationAttention: false,
};
const history: HistoryInput = { ...packet, stage: "history", depth: "deep", evidence: historyMaterial() };
const verification: VerificationInput = { ...packet, stage: "verification", asOf: sampleDate, evidence: verificationMaterial() };

function analysis(): AnalysisInput {
  return { ...packet, stage: "analysis", evidence: analysisMaterial(),
    history: investigateHistory({ ...history, attemptId: fixtureId(1010) }),
    verification: verify({ ...verification, attemptId: fixtureId(1011) }),
  };
}

function claim(input: ResearchInput): Claim {
  const agents = { discovery: "GL-AGENT-002", history: "GL-AGENT-003", verification: "GL-AGENT-004", analysis: "GL-AGENT-005" } as const;
  const agentId = agents[input.stage];
  const prompt = promptManifest.find((entry) => entry.agentId === agentId)!;
  return {
    researchInput: input,
    task: {
      stage: input.stage, agentId, contractVersion: 1, synthetic: true, runId: fixtureId(1012), eventId: input.eventId,
      taskId: fixtureId(1013), attemptId: input.attemptId, round: 0, attempt: 1, verificationAttention: false,
      dependencies: [], revisionRequest: null,
    },
    promptVersion: prompt.version, promptDigest: prompt.digest, model: "geolens-fixture", maxInputTokens: 12288,
    maxOutputTokens: 4096, leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
  };
}

describe("GL-AGENT-002 News Discovery", () => {
  it("counts connected origin, fingerprint and URL duplicates only once and retains attribution references", () => {
    const bridge = { ...source(5, "mirror-origin"), canonicalUrl: sampleSources[0].canonicalUrl };
    const mirror = source(6, "mirror-origin", 3);
    const outcome = discover({ ...discovery, sources: [...sampleSources, bridge, mirror] });
    expect(outcome.independentSourceCount).toBe(1);
    expect(outcome.duplicateGroups).toEqual([{ documentIds: [1, 2, 3, 5, 6].map(fixtureId) }]);
    expect(outcome.sourceRegister).toHaveLength(6);
    expect(outcome.classification).toBe("underreported");
    expect(outcome.evidenceGaps.join(" ")).toMatch(/independent coverage/);
    expect(outcome.scope).toBe("nigeria");
  });

  it("distinguishes breaking, developing, trending and uncategorized reports and applies weighted ranking", () => {
    for (const label of ["breaking", "developing", "trending"] as const) {
      expect(discover({ ...discovery, ingestionLabel: label }).classification).toBe(label);
    }
    expect(discover(discovery).ranking.score).toBe(72.5);
    expect(discover({ ...discovery, locations: [{ name: "Accra", country: "GH" }] }).scope).toBe("africa");
    expect(discover({ ...discovery, locations: [{ name: "Lima", country: "PE" }] }).scope).toBe("global");
    expect(discover({ ...discovery, scores: { ...discovery.scores, impact: 10 }, sources: [] }).classification)
      .toBe("unclassified");
  });

  it("routes priority without conferring a verification verdict", () => {
    expect(discover(discovery).recommendation).toBe("investigate");
    expect(discover({ ...discovery, priority: "archive", verificationAttention: true }).recommendation).toBe("urgent_verification");
    for (const priority of ["monitor", "archive"] as const) {
      expect(discover({ ...discovery, priority }).recommendation).toBe(priority);
    }
    expect(discover(discovery)).not.toHaveProperty("verdict");
  });
});

describe("GL-AGENT-003 Historical Research", () => {
  it("expands the evidence scope at each depth and preserves ancient, disputed and unknown dates", () => {
    const contextual = investigateHistory({ ...history, depth: "contextual" });
    const extended = investigateHistory({ ...history, depth: "extended" });
    const deep = investigateHistory(history);
    expect(contextual.period.earliestYear).toBe(1968);
    expect(extended.period.earliestYear).toBe(1845);
    expect(deep.period.earliestYear).toBe(-225);
    expect(deep.timeline[0].period).toEqual({ earliestYear: -225, latestYear: -180, exactDate: null, certainty: "approximate" });
    expect(deep.comparativeAnalysis[0].period.certainty).toBe("unknown");
    expect(deep.competingInterpretations[0].status).toBe("disputed");
    expect(deep.actors[0].perspective).toBe("africa");
    expect(deep.timeline).toEqual(expect.arrayContaining([expect.objectContaining({ perspective: "nigeria" })]));
    expect(deep.previousResolutions[0].evidenceIds).toHaveLength(1);
    expect(deep.consequences[0].evidenceIds).toHaveLength(1);
    expect(validateResearchResult(history, deep)).toBe(true);
  });

  it("rejects fake precision, fabricated identifiers and misattributed real citations", () => {
    const modified = structuredClone(history);
    modified.evidence[0].annotation.period.exactDate = "1968-02-31";
    expect(validateResearchInput("history", modified)).toBe(false);
    const result = investigateHistory(history);
    result.timeline[0].evidenceIds = [fixtureId(999)];
    expect(validateResearchResult(history, result)).toBe(false);
    result.timeline[0].evidenceIds = [history.evidence[0].evidenceId];
    expect(validateResearchResult(history, result)).toBe(false);
  });
});

describe("GL-AGENT-004 Verification", () => {
  it("extracts and independently verifies atomic numbers, dates, quotations and attribution", () => {
    const result = verify(verification);
    expect(result.claims.map(({ type, verdict }) => [type, verdict])).toEqual(
      ["number", "date", "quotation", "attribution"].map((type) => [type, "verified"]),
    );
    expect(result.claims[0].supporting.independentSourceCount).toBe(2);
    expect(result.claims[0].confidence).toBe("high");
    expect(result.claims[0].originalClaim).toContain("1,200 households");
    expect(verifyDisposition(result)).toBe("complete");
  });

  it("retains contradictions and explicitly assesses mixed evidence without a public label", () => {
    const claimId = fixtureId(21);
    const input: VerificationInput = {
      ...verification, evidence: [...verification.evidence,
        evidence(79, sampleSources[1].documentId, observation(claimId, "1,050 households"), "Synthetic record contains 1,050 households.")],
    };
    const result = verify(input);
    const claim = result.claims[0];
    expect(claim.verdict).toBe("partially_accurate");
    expect(claim.confidence).toBe("low");
    expect(claim.mixedAssessment).toMatch(/differ/);
    expect(claim.contradictory.evidenceIds).toEqual([fixtureId(79)]);
    expect(claim).not.toHaveProperty("publicLabel");
    expect(verifyDisposition(result)).toBe("incomplete");
  });

  it("deduplicates syndicated claims and keeps both traceable excerpts", () => {
    const lead = verification.evidence[0];
    if (lead.annotation.kind !== "claim") throw new Error("fixture claim lead expected");
    const duplicate = evidence(79, sampleSources[1].documentId, { ...lead.annotation, originalClaim: "A syndicated synthetic report." },
      "Synthetic syndicated edition.");
    const result = verify({ ...verification, evidence: [...verification.evidence, duplicate] });
    expect(result.claims).toHaveLength(4);
    expect(result.claims[0].evidenceIds).toEqual([lead.evidenceId, duplicate.evidenceId]);
    expect(result.claims[0].supporting.independentSourceCount).toBe(2);
  });

  it("distinguishes minor qualifications, misleading context and an explicit independent refutation", () => {
    const materialClaim = fixtureId(21);
    const claimLead = verification.evidence.filter(({ annotation }) => annotation.kind === "claim");
    function run(observations: VerificationInput["evidence"]) {
      return verify({ ...verification, evidence: [...claimLead, ...observations] }).claims[0];
    }
    const primary = sampleSources[0].documentId;
    const second = sampleSources[2].documentId;
    expect(run([evidence(79, primary, observation(materialClaim, "1200 households", { context: "minor_omission" }),
      "Synthetic register records 1200 households.")]).verdict).toBe("mostly_accurate");
    const misleading = run([evidence(79, primary, observation(materialClaim, "1200 households", { context: "misleading" }),
      "Synthetic restricted register records 1200 households.")]);
    expect(misleading.verdict).toBe("misleading");
    expect(misleading.recommendedAction).toBe("escalate");
    expect(misleading.correctionRequired).toBe(true);

    const a = evidence(79, primary, observation(materialClaim, "700 households"), "Synthetic register records 700 households.");
    const b = evidence(80, second, observation(materialClaim, "700 households", { authority: "credible" }), "Synthetic ledger records 700 households.");
    expect(run([a]).verdict).toBe("unverified");
    expect(run([a, b]).verdict).toBe("false");
  });

  it("escalates unsupported allegations and flags outdated information separately from its verdict", () => {
    const input = structuredClone(verification);
    const first = input.evidence[0].annotation;
    if (first.kind !== "claim") throw new Error("fixture claim lead expected");
    first.atoms[0].sensitive = true;
    input.evidence = input.evidence.filter(({ annotation }) => annotation.kind === "claim");
    input.evidence.push(evidence(79, sampleSources[0].documentId, observation(fixtureId(22), "2026-09-14", {
      validThrough: "2026-10-01",
    }), "The former synthetic schedule lists 2026-09-14."));
    const result = verify(input);
    expect(result.claims[0]).toMatchObject({
      verdict: "unverified", confidence: "insufficient_evidence", recommendedAction: "escalate", outdated: false,
    });
    expect(result.claims[1]).toMatchObject({ verdict: "unverified", outdated: true, recommendedAction: "update" });
    expect(result.claims[1].excluded.evidenceIds).toEqual([fixtureId(79)]);
    expect(verifyDisposition(result)).toBe("critical");
  });

  it("rejects evidence without relevant licensing provenance or an exact quoted passage", () => {
    const input = structuredClone(verification);
    input.evidence.find(({ evidenceId }) => evidenceId === fixtureId(74))!.excerpt = "A different synthetic quote.";
    const outdated = verify(input).claims.find(({ type }) => type === "quotation")!;
    expect(outdated.verdict).toBe("unverified");
    expect(outdated.excluded.evidenceIds).toEqual([fixtureId(74)]);
    expect(verify({ ...verification, evidence: verification.evidence.map((item) => item.evidenceId === fixtureId(74)
      ? { ...item, documentId: sampleSources[3].documentId } : item) }).claims[2].verdict).toBe("unverified");
  });
});

describe("GL-AGENT-005 Geopolitical Analysis", () => {
  it("uses verified facts and evidence-backed regional insights with exactly three conditional scenarios", () => {
    const input = analysis();
    const result = analyze(input);
    expect(result.establishedFacts).toHaveLength(4);
    expect(result.establishedFacts[0].evidenceIds).toEqual([fixtureId(71), fixtureId(72)]);
    expect(result.historicalContext).toHaveLength(4);
    expect(result.regionalImplications[0]).toMatchObject({ scope: "nigeria", domain: "humanitarian" });
    expect(new Set(result.implications.map(({ domain }) => domain))).toEqual(new Set(["political", "economic", "security", "humanitarian"]));
    expect(result.competingExplanations).toHaveLength(2);
    expect(result.rivalries[0].framing).toBe("inferred_intention");
    expect(Object.values(result.scenarios).map(({ months }) => months)).toEqual([[0, 3], [3, 12], [12, 36]]);
    for (const scenario of Object.values(result.scenarios)) {
      expect(scenario).toMatchObject({ framing: "conditional_forecast", condition: expect.any(String), outcome: expect.any(String) });
      expect(scenario.evidenceIds.length).toBeGreaterThan(0);
    }
    expect(validateResearchResult(input, result)).toBe(true);
    expect(validateResearchResult(input, {
      ...result, scenarios: { ...result.scenarios, escalation: { ...result.scenarios.escalation, probability: 0.85 } },
    })).toBe(false);
  });

  it("leaves unsupported scenarios open and rejects critical or cross-event prerequisites", () => {
    const input = analysis();
    const mixed = structuredClone(input);
    mixed.verification.claims[0].recommendedAction = "escalate";
    expect(validateResearchInput("analysis", mixed)).toBe(false);
    expect(validateResearchInput("analysis", { ...input, history: { ...input.history, eventId: fixtureId(999) } })).toBe(false);
    const partial = analyze({ ...input, evidence: input.evidence.filter(({ annotation }) => annotation.kind !== "scenario") });
    expect(partial.scenarios.baseline.condition).toBeNull();
    expect(partial.evidenceGaps).toContain("Gather evidence for the missing conditional scenarios.");
  });
});

describe("shared research execution", () => {
  it.each([discovery, history, verification, analysis()])("executes the Stage 5A engine with the $stage role schema and v2 prompt", async (input) => {
    const request = claim(input);
    const report = await executeFixture(request, createOpenAIFixtureProvider());
    expect(request.promptVersion).toBeGreaterThanOrEqual(2);
    expect(report).toMatchObject({ researchResult: buildResearchResult(input), output: { disposition: "complete" } });
  });

  it("treats source instructions as fixture data and refuses ungrounded or malformed model responses", async () => {
    const research = verify(verification);
    const withoutInjection = verify({ ...verification, evidence: verification.evidence.map((record) => ({
      ...record, excerpt: record.excerpt.replace(injectionText, ""),
    })) });
    expect(research).toEqual(withoutInjection);
    const provider = vi.fn(async () => ({
      output: { ...research, publish: true, sourceRegister: [fixtureId(999)] }, inputTokens: 120, outputTokens: 50,
    }));
    expect(await executeFixture(claim(verification), provider)).toEqual({ failure: "invalid_output" });
    const retargeted = { ...claim(verification), researchInput: { ...verification, attemptId: fixtureId(999) } };
    expect(await executeFixture(retargeted, provider)).toEqual({ failure: "invalid_input" });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
