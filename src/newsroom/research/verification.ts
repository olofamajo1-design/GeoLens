import { groupSources, register } from "./sources.ts";
import type {
  Action, AtomicClaim, ClaimKind, Evidence, Observation, Verdict, VerificationInput, VerificationResult, VerifiedClaim,
} from "./types";

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function normalized(value: string, kind: ClaimKind): string | null {
  const text = value.trim().normalize("NFC");
  if (kind === "date") return validDate(text) ? text : null;
  if (kind === "quotation") return text.replace(/^(?:"|“)(.*)(?:"|”)$/s, "$1");
  if (kind !== "number") return text.replace(/\s+/g, " ").toLowerCase();
  const match = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*([\p{L}%$°].*))?$/u.exec(text);
  if (!match) return null;
  const [, sign, integral, fraction, unit] = match;
  const whole = integral.replaceAll(",", "").replace(/^0+(?=\d)/, "");
  const decimal = fraction?.replace(/0+$/, "");
  const quantity = (sign === "-" && (whole !== "0" || decimal) ? "-" : "") + whole + (decimal ? "." + decimal : "");
  return quantity + " " + (unit?.toLowerCase().replace(/\s+/g, " ").trim() ?? "");
}

function actionFor(claim: AtomicClaim, verdict: Verdict, outdated: boolean): Action {
  if (claim.sensitive && (verdict !== "verified" || outdated)) return "escalate";
  if (claim.material && (verdict === "misleading" || verdict === "false")) return "escalate";
  if (outdated) return "update";
  if (verdict === "unverified") return "seek_evidence";
  return verdict === "verified" ? "retain" : "correct";
}

const corrections: Partial<Record<Action, string>> = {
  escalate: "Hold the claim for editorial verification of the evidence and the proposed correction.",
  update: "Replace the superseded figure or statement with a current, attributed observation.",
  correct: "Correct the claim to reflect the supported portion and its stated limitations.",
};

type ObservationRecord = Evidence<Observation>;

export function verify(input: VerificationInput): VerificationResult {
  const groups = groupSources(input.sources);
  const attributedSources = new Set(input.sources.filter(({ origin }) => origin).map(({ documentId }) => documentId));
  const observations = input.evidence.filter((item): item is ObservationRecord => item.annotation.kind === "observation");
  const extracted = new Map<string, { atom: AtomicClaim; original: string; records: Evidence[] }>();
  for (const record of input.evidence) {
    if (record.annotation.kind !== "claim") continue;
    for (const atom of record.annotation.atoms) {
      const existing = extracted.get(atom.claimId);
      if (existing) existing.records.push(record);
      else extracted.set(atom.claimId, { atom, original: record.annotation.originalClaim, records: [record] });
    }
  }

  const claims: VerifiedClaim[] = [];
  const used: Evidence[] = [];
  for (const { atom, original, records } of extracted.values()) {
    const expected = normalized(atom.value, atom.type);
    const supporting: ObservationRecord[] = [];
    const contradictory: ObservationRecord[] = [];
    const excluded: ObservationRecord[] = [];
    let hasSupersededSupport = false;
    for (const observed of observations.filter(({ annotation }) => annotation.claimId === atom.claimId)) {
      const { annotation } = observed;
      const measured = normalized(annotation.value, atom.type);
      const attributed = observed.excerpt.normalize("NFC").includes(annotation.value.normalize("NFC"));
      if (!expected || !measured || !attributed || !annotation.relevant || annotation.authority === "weak"
        || !attributedSources.has(observed.documentId)) {
        excluded.push(observed);
      } else if (annotation.validThrough && annotation.validThrough < input.asOf) {
        hasSupersededSupport ||= measured === expected;
        excluded.push(observed);
      } else if (measured === expected) {
        supporting.push(observed);
      } else {
        contradictory.push(observed);
      }
    }

    const assessment = (items: Evidence[]) => ({
      evidenceIds: items.map(({ evidenceId }) => evidenceId), independentSourceCount: groups.count(items),
    });
    const support = assessment(supporting);
    const contradiction = assessment(contradictory);
    const outdated = hasSupersededSupport && !supporting.length;
    const contexts = new Set(supporting.map(({ annotation }) => annotation.context));
    const conflicting = supporting.length > 0 && contradictory.length > 0;
    const adjudicatedContradiction = contradiction.independentSourceCount >= 2
      && contradictory.some(({ annotation }) => annotation.authority === "primary");
    let verdict: Verdict = "unverified";
    let mixedAssessment: string | null = null;
    if (contexts.has("misleading")) {
      verdict = "misleading";
      mixedAssessment = "The matching detail omits context that materially changes its meaning.";
    } else if (conflicting || contexts.has("material_omission")) {
      verdict = "partially_accurate";
      mixedAssessment = conflicting
        ? "The supporting and contradictory records differ. Report the supported component and document the conflict."
        : "Some details are supported, with a material qualification in the underlying records.";
    } else if (contexts.has("minor_omission")) {
      verdict = "mostly_accurate";
      mixedAssessment = "The underlying detail is supported with a limited qualification.";
    } else if (supporting.length) {
      verdict = "verified";
    } else if (adjudicatedContradiction) {
      verdict = "false";
    }
    const recommendedAction = actionFor(atom, verdict, outdated);
    const limitations: string[] = [];
    if (!supporting.length && !adjudicatedContradiction) limitations.push("Available current evidence is insufficient to resolve this claim.");
    if (conflicting) limitations.push("Independent adjudication is required to resolve conflicting records.");
    if (outdated) limitations.push("The supporting observation was superseded before the verification date.");
    if (excluded.length) limitations.push("Some observations failed relevance, authority, provenance, quotation or currency checks.");
    used.push(...records, ...supporting, ...contradictory, ...excluded);
    claims.push({
      claimId: atom.claimId, originalClaim: original, normalizedClaim: atom.normalizedClaim, type: atom.type,
      material: atom.material, sensitive: atom.sensitive, evidenceIds: [...new Set(records.map(({ evidenceId }) => evidenceId))],
      supporting: support, contradictory: contradiction, excluded: assessment(excluded), verdict,
      confidence: verdict === "unverified" ? "insufficient_evidence"
        : conflicting ? "low" : verdict === "false" || (support.independentSourceCount >= 2
          && supporting.some(({ annotation }) => annotation.authority === "primary")) ? "high" : "moderate",
      outdated, limitations, mixedAssessment, recommendedAction,
      correctionRequired: outdated || verdict === "false" || mixedAssessment !== null,
      correction: corrections[recommendedAction] ?? null,
    });
  }
  return {
    stage: "verification", contractVersion: 1, synthetic: true, eventId: input.eventId, attemptId: input.attemptId,
    verificationId: input.attemptId, asOf: input.asOf, sourceRegister: register(used), claims,
    methodology: [
      "Split annotated reported statements into atomic claims and compare values by claim type.",
      "Check that the cited excerpt contains the observed value, then assess authority, relevance, provenance and currency.",
      "Collapse syndicated reports before counting corroboration and record support and contradiction separately.",
    ],
  };
}
