import {
  validateDiscoveryInput, validateDiscoveryOutput, validateHistoryInput, validateHistoryOutput,
  validateVerificationInput, validateVerificationOutput, validateAnalysisInput, validateAnalysisOutput,
} from "../generated/validators.mjs";
import { analyze } from "./analysis.ts";
import { discover } from "./discovery.ts";
import { investigateHistory } from "./history.ts";
import { validDate, verify } from "./verification.ts";
import type { Period, ResearchInput, ResearchResult, ResearchStage, VerificationResult } from "./types";

const roleValidators = {
  discovery: { input: validateDiscoveryInput, output: validateDiscoveryOutput },
  history: { input: validateHistoryInput, output: validateHistoryOutput },
  verification: { input: validateVerificationInput, output: validateVerificationOutput },
  analysis: { input: validateAnalysisInput, output: validateAnalysisOutput },
} as const;

export function isResearchStage(stage: string): stage is ResearchStage {
  return Object.hasOwn(roleValidators, stage);
}

function validPeriod(period: Period) {
  const { earliestYear, latestYear, exactDate, certainty } = period;
  if (earliestYear !== null && latestYear !== null && earliestYear > latestYear) return false;
  if (exactDate !== null) return validDate(exactDate) && certainty === "documented"
    && earliestYear === Number(exactDate.slice(0, 4)) && latestYear === earliestYear;
  return true;
}

export function verifyDisposition(result: VerificationResult): "complete" | "critical" | "incomplete" {
  if (result.claims.some(({ recommendedAction }) => recommendedAction === "escalate")) return "critical";
  const material = result.claims.filter((claim) => claim.material);
  if (!material.length || material.some(({ verdict, outdated }) => verdict !== "verified" || outdated)) return "incomplete";
  return "complete";
}

export function validateResearchInput(stage: ResearchStage, value: unknown): value is ResearchInput {
  if (!roleValidators[stage].input(value)) return false;
  const input = value as ResearchInput;
  const sources = new Set(input.sources.map(({ documentId }) => documentId));
  if (sources.size !== input.sources.length) return false;
  if (input.stage === "discovery") return true;
  if (input.evidence.some(({ documentId }) => !sources.has(documentId))
    || new Set(input.evidence.map(({ evidenceId }) => evidenceId)).size !== input.evidence.length) return false;

  switch (input.stage) {
    case "history":
      return input.evidence.every(({ annotation }) => validPeriod(annotation.period));
    case "verification": {
      if (!validDate(input.asOf)) return false;
      const claims = new Map<string, string>();
      for (const { annotation } of input.evidence) {
        if (annotation.kind === "observation") {
          if (annotation.validThrough && !validDate(annotation.validThrough)) return false;
          continue;
        }
        for (const atom of annotation.atoms) {
          const prior = claims.get(atom.claimId);
          const identity = canonicalJson(atom);
          if (prior !== undefined && prior !== identity) return false;
          claims.set(atom.claimId, identity);
        }
      }
      return claims.size <= 48;
    }
    case "analysis": {
      const prerequisites = [input.history, input.verification];
      return prerequisites.every((result) => result.eventId === input.eventId
        && result.sourceRegister.every((documentId) => sources.has(documentId)))
        && verifyDisposition(input.verification) === "complete";
    }
  }
}

export function buildResearchResult(input: ResearchInput): ResearchResult {
  switch (input.stage) {
    case "discovery": return discover(input);
    case "history": return investigateHistory(input);
    case "verification": return verify(input);
    case "analysis": return analyze(input);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

// Fixture results must reproduce the trusted packet's adjudication and citations.
// This also rejects invented findings that reuse a real but unrelated evidence ID.
export function validateResearchResult(input: ResearchInput, output: unknown): output is ResearchResult {
  return roleValidators[input.stage].output(output) && canonicalJson(buildResearchResult(input)) === canonicalJson(output);
}

export function researchDisposition(result: ResearchResult): "complete" | "critical" | "incomplete" {
  if (result.stage === "verification") return verifyDisposition(result);
  if (result.stage === "analysis" && (!result.actors.length || !result.historicalContext.length
    || Object.values(result.scenarios).some(({ condition }) => condition === null))) return "incomplete";
  return "complete";
}
