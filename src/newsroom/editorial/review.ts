import { canonicalJson } from "../research/contracts.ts";
import { identity, rubricWeights } from "./types.ts";
import type {
  EditorialInput, EditorialResult, Factor, ReverificationInput, ReverificationResult, ReviewPackage, RevisionIssue,
} from "./types";
import { eligibleVisual } from "./visual.ts";
import { groundedArticles } from "./writing.ts";

const criticalIssues: Record<ReverificationResult["critical"][number], RevisionIssue> = {
  rights: { code: "rights", severity: "critical", agentId: "GL-AGENT-007",
    instruction: "Replace or clear each blocked asset and reconfirm the linked source and media rights." },
  privacy: { code: "privacy", severity: "critical", agentId: "GL-AGENT-006",
    instruction: "Remove private contact details from the draft, captions and open claim notes." },
  security: { code: "security", severity: "critical", agentId: "GL-AGENT-008",
    instruction: "Remove active markup and executable links from the edition before another integrity assessment." },
  unverified_claim: { code: "unverified_claim", severity: "critical", agentId: "GL-AGENT-004",
    instruction: "Verify the proposed claims against new eligible evidence before including them in an edition." },
  invalid_grounding: { code: "invalid_grounding", severity: "critical", agentId: "GL-AGENT-004",
    instruction: "Reconcile the article and visual references to the verification packet for this exact version." },
};

export function inspectPackage(input: ReviewPackage) {
  const unresolved = input.article.proposedClaims.filter(({ statement, evidenceIds }) => !input.material.some((block) =>
    block.frame === "verified_fact" && block.text === statement && canonicalJson(block.evidenceIds) === canonicalJson(evidenceIds)));
  const critical: ReverificationResult["critical"] = [];
  if (!groundedArticles(input.article.articles, input.material)
    || input.visual.assets.some((asset) => !eligibleVisual(asset))) critical.push("invalid_grounding");
  if (unresolved.length) critical.push("unverified_claim");
  if (!input.rightsActive || input.visual.blockedAssetIds.length) critical.push("rights");
  const content = JSON.stringify([input.article.articles, input.article.proposedClaims, input.visual.assets]);
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i.test(content)) critical.push("privacy");
  if (/<\s*(?:script|iframe|object|embed)\b|javascript\s*:/i.test(content)) critical.push("security");
  const checkedClaims = [...new Set(input.material.filter(({ frame }) => frame === "verified_fact")
    .flatMap(({ claimIds }) => claimIds))].sort();
  return { unresolved, critical, checkedClaims };
}

export function reverifyEdition(input: ReverificationInput): ReverificationResult {
  const checks = inspectPackage(input);
  return {
    ...identity(input), stage: "reverification", version: input.version,
    status: checks.critical.length ? "hold" : "verified", ...checks,
  };
}

export function weightedScore(ratings: Record<Factor, number>): number {
  return (Object.keys(rubricWeights) as Factor[])
    .reduce((sum, factor) => sum + rubricWeights[factor] * ratings[factor], 0) / 100;
}

export function reviewEdition(input: EditorialInput): EditorialResult {
  const { critical } = inspectPackage(input);
  const checks = new Set([...critical, ...input.verification.critical]);
  if (input.verification.status !== "verified" || canonicalJson(input.verification.version) !== canonicalJson(input.version)) {
    checks.add("invalid_grounding");
  }
  const issues = [...checks].map((code) => criticalIssues[code]);
  const deep = input.article.articles.find(({ format }) => format === "deep_dive");
  const brief = input.article.articles.find(({ format }) => format === "quick_brief");
  const historical = deep?.sections.some(({ blocks }) => blocks.some(({ frame }) =>
    frame === "documented_history" || frame === "disputed_interpretation"));
  const analysis = deep?.sections.some(({ blocks }) => blocks.some(({ frame }) => frame === "conditional_scenario"))
    && deep?.sections.some(({ kind, blocks }) => kind === "analysis" && blocks.some(({ evidenceIds }) => evidenceIds.length));
  const length = brief && deep && brief.wordCount >= 150 && brief.wordCount <= 300 && deep.wordCount >= 900 && deep.wordCount <= 1500;

  if (!historical) issues.push({ code: "missing_history", severity: "major", agentId: "GL-AGENT-006",
    instruction: "Restore the sourced historical section and keep its date uncertainty visible." });
  if (!analysis) issues.push({ code: "missing_analysis", severity: "major", agentId: "GL-AGENT-006",
    instruction: "Restore the sourced analysis and clearly label at least one conditional scenario." });
  if (!input.visual.assets.length) issues.push({ code: "missing_visuals", severity: "minor", agentId: "GL-AGENT-007",
    instruction: "Attach an eligible, accessible visual with an evidence citation and active rights." });
  if (input.independentOrigins === 0) issues.push({ code: "source_balance", severity: "critical", agentId: "GL-AGENT-004",
    instruction: "Establish an attributable independent source for the evidence before human handoff." });

  const ratings = {
    factual_accuracy_and_evidence: checks.has("invalid_grounding") || checks.has("unverified_claim") ? 0 : 100,
    research_completeness_and_context: historical ? 100 : 40,
    balance_and_independence: input.independentOrigins >= 2 ? 100 : input.independentOrigins === 1 ? 75 : 0,
    analytical_quality: analysis ? 100 : 50,
    writing_quality: length ? 100 : 90,
    source_transparency: input.article.sourceRegister.length >= 2 ? 100 : 60,
    visual_accuracy_and_quality: input.visual.assets.length ? 100 : 60,
    legal_ethical_and_safety: checks.has("rights") || checks.has("privacy") || checks.has("security") ? 0 : 100,
  };
  const score = weightedScore(ratings);
  if (score < 85 && issues.length === 0) issues.push({
    code: "below_threshold", severity: "major", agentId: "GL-AGENT-006",
    instruction: "Improve the lowest-rated writing or sourcing factor before reassessment.",
  });
  const decision = checks.has("invalid_grounding") || checks.has("privacy") || checks.has("security") ? "reject"
    : issues.some(({ severity }) => severity === "critical") ? "hold"
    : issues.some(({ severity }) => severity === "major") ? "major_revision"
    : issues.length ? "minor_revision" : "ready_for_human_review";
  return { ...identity(input), stage: "editorial", version: input.version, ratings, score, decision, issues };
}
