import { groupSources } from "./sources.ts";
import type { DiscoveryInput, DiscoveryResult, Scope } from "./types";

const africanCountries = new Set(
  "DZ AO BJ BW BF BI CV CM CF TD KM CG CD DJ EG GQ ER SZ ET GA GM GH GN GW CI KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW EH".split(" "),
);
const weights = { impact: 30, evidence: 25, urgency: 20, regional: 15, historical: 10 } as const;

export function discover(input: DiscoveryInput): DiscoveryResult {
  const { sources, locations, entities, headline, scores, priority } = input;
  const groups = groupSources(sources);
  const { independentSourceCount } = groups;
  const scope: Scope = locations.some(({ country }) => country === "NG") ? "nigeria"
    : locations.some(({ country }) => africanCountries.has(country)) ? "africa" : "global";
  const thinCoverage = independentSourceCount < 2;
  const classification = input.ingestionLabel === "breaking" ? "breaking"
    : input.ingestionLabel === "developing" ? "developing"
    : input.ingestionLabel === "trending" && !thinCoverage ? "trending"
    : scores.impact >= 75 && thinCoverage ? "underreported" : "unclassified";
  const recommendation = input.verificationAttention ? "urgent_verification"
    : priority === "monitor" || priority === "archive" ? priority : "investigate";
  const total = (Object.keys(weights) as (keyof typeof weights)[])
    .reduce((sum, criterion) => sum + scores[criterion] * weights[criterion], 0);
  const evidenceGaps: string[] = [];
  if (thinCoverage) evidenceGaps.push("Seek a primary record and independent coverage. Syndicated reports share an origin.");
  if (!locations.length) evidenceGaps.push("Confirm the geographic scope with primary records.");
  if (!entities.length) evidenceGaps.push("Confirm the actors and institutions involved.");
  return {
    stage: "discovery", contractVersion: 1, synthetic: true, eventId: input.eventId, attemptId: input.attemptId,
    headline, locations, entities, scope, independentSourceCount, duplicateGroups: groups.duplicates, classification,
    summary: `Synthetic discovery found ${sources.length} reports across ${independentSourceCount} independent source groups.`,
    sourceRegister: sources.map(({ documentId }) => documentId),
    ranking: {
      score: Math.round(total + 1e-10) / 100, components: scores, priority,
      rationale: "Public impact 30%, evidence strength 25%, urgency 20%, regional relevance 15%, historical significance 10%. This determines investigation priority.",
    },
    historicalLeads: [
      "Check earlier decisions, responses and institutional records involving the reported event.",
      ...(scope === "global" ? [] : ["Seek Nigerian and other African records for relevant local perspectives."]),
    ],
    evidenceGaps, recommendation,
  };
}
