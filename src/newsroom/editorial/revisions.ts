import type { EditorialInput, ProposedClaim, RevisionIssue } from "./types";
import { containsActiveMarkup, containsPrivateContact } from "./visual.ts";

type IssueCode = RevisionIssue["code"];
type Detail = NonNullable<RevisionIssue["detail"]>;
const descriptions: Record<IssueCode, [string, string | null]> = {
  rights: ["The edition contains a blocked asset or its rights check failed.", "Confirm an active rights grant for the affected source or media version."],
  privacy: ["The edition contains a private contact detail.", null],
  security: ["The edition contains active markup or an executable link.", null],
  unverified_claim: ["A proposed factual addition is unresolved.", "Eligible evidence has yet to verify the proposed claim."],
  invalid_grounding: ["The edition and verification records do not agree.", "A verification record bound to this exact edition is required."],
  missing_history: ["The Deep Dive lacks a sourced historical section.", "The edition omits the relevant historical evidence."],
  missing_analysis: ["The Deep Dive lacks sourced analysis or a conditional scenario.", "The edition omits the relevant analysis or scenario evidence."],
  missing_visuals: ["The edition contains zero eligible visuals.", "An accessible, source-backed visual is required."],
  source_balance: ["The edition lacks an attributable independent source.", "Source independence is unestablished for the available evidence."],
  below_threshold: ["The weighted editorial score is below 85.", null],
};

const sectionsByCode: Record<IssueCode, string> = {
  rights: "edition_rights", privacy: "edition_content", security: "edition_content",
  unverified_claim: "proposed_claims", invalid_grounding: "edition_verification", missing_history: "deep_dive:history",
  missing_analysis: "deep_dive:analysis_and_scenarios", missing_visuals: "visual_package",
  source_balance: "source_register", below_threshold: "editorial_quality",
};

export function revisionDetail(input: EditorialInput, code: IssueCode, unresolved: ProposedClaim[]): Detail {
  const [problem, evidenceGap] = descriptions[code];
  let affected: Detail["affected"] = [{ kind: "section", ref: sectionsByCode[code] }];
  let evidence: string[] = [];

  if (code === "rights" && input.visual.blockedAssetIds.length) {
    affected = input.visual.blockedAssetIds.map((ref) => ({ kind: "visual", ref }));
  }
  if (code === "unverified_claim" && unresolved.length) {
    affected = input.article.proposedClaims.flatMap((proposal, index) =>
      unresolved.includes(proposal) ? [{ kind: "claim", ref: "proposal:" + (index + 1) }] : []);
    evidence = unresolved.flatMap(({ evidenceIds }) => evidenceIds);
  }
  if (code === "missing_history" || code === "missing_analysis") {
    const relevant = code === "missing_history" ? ["history"] : ["analysis", "scenarios"];
    evidence = input.material.filter(({ section }) => relevant.includes(section)).flatMap(({ evidenceIds }) => evidenceIds);
  }
  if (code === "privacy" || code === "security") {
    const match = code === "privacy" ? containsPrivateContact : containsActiveMarkup;
    const targets: Detail["affected"] = [];
    for (const asset of input.visual.assets) {
      if (!match(JSON.stringify(asset))) continue;
      targets.push({ kind: "visual", ref: asset.id });
      evidence.push(...asset.evidenceIds);
    }
    for (const { format, sections, ...summary } of input.article.articles) {
      if (match(JSON.stringify(summary))) targets.push({ kind: "section", ref: format + ":summary" });
      for (const section of sections) {
        if (!match(JSON.stringify(section))) continue;
        targets.push({ kind: "section", ref: format + ":" + section.kind });
        evidence.push(...section.blocks.flatMap(({ evidenceIds }) => evidenceIds));
      }
    }
    for (const [index, proposal] of input.article.proposedClaims.entries()) {
      if (!match(JSON.stringify(proposal))) continue;
      targets.push({ kind: "claim", ref: "proposal:" + (index + 1) });
      evidence.push(...proposal.evidenceIds);
    }
    if (targets.length) affected = targets.slice(0, 16);
  }

  return { affected, problem, evidenceIds: [...new Set(evidence)].sort().slice(0, 48), evidenceGap, blocksPublication: true };
}
