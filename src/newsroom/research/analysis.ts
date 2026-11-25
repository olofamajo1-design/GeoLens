import { groupSources, register } from "./sources.ts";
import type {
  AnalysisCategory, AnalysisInput, AnalysisNote, AnalysisResult, AnalyticalFinding, Evidence, Horizon, Scenario, ScenarioName,
  ScenarioNote,
} from "./types";

const horizons: Record<Horizon, [number, number]> = { short: [0, 3], medium: [3, 12], long: [12, 36] };

function conditionalScenario(record: Evidence<ScenarioNote> | undefined, fallback: Horizon): Scenario {
  const note = record?.annotation;
  const horizon = note?.horizon ?? fallback;
  return {
    framing: "conditional_forecast", horizon, months: horizons[horizon],
    condition: note?.condition ?? null, outcome: note?.outcome ?? null,
    assumptions: note ? [note.assumption] : [], earlyWarnings: note ? [note.indicator] : [],
    evidenceIds: record ? [record.evidenceId] : [],
  };
}

export function analyze(input: AnalysisInput): AnalysisResult {
  const established = input.verification.claims.filter(({ verdict, outdated }) => verdict === "verified" && !outdated);
  const establishedById = new Map(established.map((claim) => [claim.claimId, claim]));
  const records = input.evidence.filter((record): record is Evidence<AnalysisNote> => {
    if (record.annotation.kind !== "analysis") return false;
    const { annotation } = record;
    if (annotation.framing !== "established_fact") return true;
    return annotation.claimId !== null
      && establishedById.get(annotation.claimId)?.normalizedClaim === annotation.statement;
  });
  const findings = records.map(({ annotation, evidenceId }) => ({
    category: annotation.category,
    finding: {
      subject: annotation.subject, statement: annotation.statement, framing: annotation.framing, scope: annotation.scope,
      domain: annotation.domain, evidenceIds: [evidenceId, ...(annotation.framing === "established_fact" && annotation.claimId
        ? establishedById.get(annotation.claimId)!.supporting.evidenceIds : [])],
    } satisfies AnalyticalFinding,
  }));
  const select = (category: AnalysisCategory) => findings.filter((item) => item.category === category).map(({ finding }) => finding);
  const scenarioRecords = input.evidence.filter((record): record is Evidence<ScenarioNote> => record.annotation.kind === "scenario");
  const findScenario = (kind: ScenarioName) => scenarioRecords.find(({ annotation }) => annotation.scenario === kind);
  const scenarioSources = { baseline: findScenario("baseline"), alternative: findScenario("alternative"), escalation: findScenario("escalation") };
  const scenarios = {
    baseline: conditionalScenario(scenarioSources.baseline, "short"),
    alternative: conditionalScenario(scenarioSources.alternative, "medium"),
    escalation: conditionalScenario(scenarioSources.escalation, "long"),
  };
  const evidenceGaps: string[] = [];
  if (!select("actor").length) evidenceGaps.push("Identify the actors using traceable sources.");
  if (!input.history.timeline.length) evidenceGaps.push("Establish a traceable historical chronology.");
  if (Object.values(scenarios).some(({ condition }) => !condition)) evidenceGaps.push("Gather evidence for the missing conditional scenarios.");
  if (input.evidence.filter(({ annotation }) => annotation.kind === "analysis").length > records.length) {
    evidenceGaps.push("Some proposed facts lack a current verified claim with the same statement.");
  }

  const usedRecords = [...records, ...Object.values(scenarioSources).filter((record) => record !== undefined)];
  const sourceRegister = [...new Set([...register(usedRecords), ...input.history.sourceRegister, ...input.verification.sourceRegister])];
  const confidence = !records.length ? "insufficient_evidence"
    : evidenceGaps.length || groupSources(input.sources).count(usedRecords) < 2 ? "low" : "moderate";
  return {
    stage: "analysis", contractVersion: 1, synthetic: true, eventId: input.eventId, attemptId: input.attemptId,
    analysisId: input.attemptId, historyId: input.history.researchId, verificationId: input.verification.verificationId,
    sourceRegister, executiveSummary: `Synthetic analysis separates ${established.length} current verified claims from interpretation and conditional scenarios.`,
    establishedFacts: established.map(({ claimId, normalizedClaim, supporting }) => ({
      claimId, statement: normalizedClaim, evidenceIds: supporting.evidenceIds,
    })),
    historicalContext: input.history.timeline,
    actors: select("actor"), interests: select("interest"), capabilities: select("capability"), constraints: select("constraint"),
    alliances: select("alliance"), rivalries: select("rivalry"), powerDynamics: select("power_dynamic"),
    competingExplanations: select("explanation"), implications: select("implication"),
    regionalImplications: select("implication").filter(({ scope }) => scope !== "global"),
    risks: select("risk"), opportunities: select("opportunity"), earlyWarnings: select("indicator"),
    assumptions: [...new Set([...findings.filter(({ finding }) => finding.framing === "assumption").map(({ finding }) => finding.statement),
      ...Object.values(scenarios).flatMap(({ assumptions }) => assumptions)])],
    scenarios, evidenceGaps, confidence,
  };
}
