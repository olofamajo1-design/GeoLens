import { groupSources, register } from "./sources.ts";
import type { HistoricalCategory, HistoricalFinding, HistoryInput, HistoryResult } from "./types";

const depthOrder = { contextual: 0, extended: 1, deep: 2 };

export function investigateHistory(input: HistoryInput): HistoryResult {
  const records = input.evidence.filter(({ annotation }) => depthOrder[annotation.depth] <= depthOrder[input.depth]);
  const findings = records.map(({ annotation, evidenceId }) => ({
    category: annotation.category,
    finding: {
      subject: annotation.subject, statement: annotation.statement, period: annotation.period,
      status: annotation.status, perspective: annotation.perspective, evidenceIds: [evidenceId],
    } satisfies HistoricalFinding,
  }));
  const select = (...categories: HistoricalCategory[]) => findings
    .filter(({ category }) => categories.includes(category)).map(({ finding }) => finding);
  const allPeriods = records.map(({ annotation }) => annotation.period);
  const earliest = allPeriods.flatMap(({ earliestYear }) => earliestYear === null ? [] : [earliestYear]);
  const latest = allPeriods.flatMap(({ latestYear }) => latestYear === null ? [] : [latestYear]);
  const timeline = select("origin", "turning_point", "resolution", "consequence").sort((a, b) =>
    (a.period.earliestYear ?? Infinity) - (b.period.earliestYear ?? Infinity));
  const competingInterpretations = findings.filter(({ category, finding }) => category === "interpretation" || finding.status === "disputed")
    .map(({ finding }) => finding);
  const evidenceGaps: string[] = [];
  if (!select("origin").length) evidenceGaps.push("Find a documented origin before setting a historical starting point.");
  if (!select("resolution").length) evidenceGaps.push("Seek archival records on earlier attempts at resolution.");
  if (allPeriods.some(({ certainty }) => certainty !== "documented")) {
    evidenceGaps.push("Corroborate approximate or disputed dates using independent records.");
  }
  const independent = groupSources(input.sources).count(records);
  return {
    stage: "history", contractVersion: 1, synthetic: true, eventId: input.eventId, attemptId: input.attemptId,
    researchId: input.attemptId, depth: input.depth, sourceRegister: register(records),
    overview: `Synthetic ${input.depth} research identified ${records.length} traceable historical findings.`,
    period: {
      earliestYear: earliest.length ? Math.min(...earliest) : null,
      latestYear: latest.length ? Math.max(...latest) : null,
      rationale: "The earliest documented or qualified relevant record in this research depth anchors the coverage. Unknown dates remain open.",
    },
    origins: select("origin"), actors: select("actor"), timeline, rootCauses: select("root_cause"),
    previousResolutions: select("resolution"), comparativeAnalysis: select("comparison"),
    competingInterpretations, consequences: select("consequence"), evidenceGaps,
    confidence: !independent ? "insufficient_evidence"
      : competingInterpretations.length || independent < 2 ? "moderate" : "high",
  };
}
