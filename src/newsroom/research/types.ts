export type ResearchStage = "discovery" | "history" | "verification" | "analysis";
export type Confidence = "high" | "moderate" | "low" | "insufficient_evidence";
export type Scope = "nigeria" | "africa" | "global";
export type Depth = "contextual" | "extended" | "deep";
export type Priority = "critical" | "high" | "standard" | "monitor" | "archive";

export interface Source {
  documentId: string;
  sourceId: string;
  headline: string;
  attribution: string;
  canonicalUrl: string | null;
  origin: string | null;
  fingerprint: string;
}

export interface Scores {
  impact: number;
  evidence: number;
  urgency: number;
  regional: number;
  historical: number;
}

export type HistoricalCategory = "origin" | "actor" | "turning_point" | "root_cause" | "resolution"
  | "comparison" | "interpretation" | "consequence";

// Year ranges preserve uncertain and ancient dates. The exact date is optional.
export interface Period {
  earliestYear: number | null;
  latestYear: number | null;
  exactDate: string | null;
  certainty: "documented" | "approximate" | "disputed" | "unknown";
}

export interface HistoricalNote {
  kind: "history";
  category: HistoricalCategory;
  subject: string;
  statement: string;
  period: Period;
  status: "documented" | "disputed";
  perspective: Scope;
  depth: Depth;
}

export type ClaimKind = "number" | "date" | "quotation" | "attribution" | "fact";
export interface AtomicClaim {
  claimId: string;
  type: ClaimKind;
  normalizedClaim: string;
  value: string;
  material: boolean;
  sensitive: boolean;
}

export interface ClaimNote {
  kind: "claim";
  originalClaim: string;
  atoms: AtomicClaim[];
}

export interface Observation {
  kind: "observation";
  claimId: string;
  value: string;
  authority: "primary" | "credible" | "weak";
  relevant: boolean;
  validThrough: string | null;
  context: "full" | "minor_omission" | "material_omission" | "misleading";
}

export type AnalysisCategory = "actor" | "interest" | "capability" | "constraint" | "alliance" | "rivalry"
  | "power_dynamic" | "explanation" | "implication" | "risk" | "opportunity" | "indicator";
export type Framing = "established_fact" | "documented_objective" | "inferred_intention" | "assumption";
export type Domain = "political" | "economic" | "security" | "humanitarian";
export type Horizon = "short" | "medium" | "long";
export type ScenarioName = "baseline" | "alternative" | "escalation";

export interface AnalysisNote {
  kind: "analysis";
  category: AnalysisCategory;
  subject: string;
  statement: string;
  framing: Framing;
  claimId: string | null;
  scope: Scope;
  domain: Domain;
}

export interface ScenarioNote {
  kind: "scenario";
  scenario: ScenarioName;
  horizon: Horizon;
  condition: string;
  outcome: string;
  assumption: string;
  indicator: string;
}

export type Annotation = HistoricalNote | ClaimNote | Observation | AnalysisNote | ScenarioNote;
export interface Evidence<Note extends Annotation = Annotation> {
  evidenceId: string;
  documentId: string;
  locator: string;
  excerpt: string;
  annotation: Note;
}

interface Identity {
  contractVersion: 1;
  synthetic: true;
  eventId: string;
  attemptId: string;
}

interface Input<Stage extends ResearchStage> extends Identity {
  stage: Stage;
  sources: Source[];
}

export interface DiscoveryInput extends Input<"discovery"> {
  headline: string;
  locations: { name: string; country: string }[];
  entities: string[];
  ingestionLabel: "breaking" | "developing" | "trending" | "review";
  scores: Scores;
  priority: Priority;
  verificationAttention: boolean;
}

export interface HistoryInput extends Input<"history"> {
  depth: Depth;
  evidence: Evidence<HistoricalNote>[];
}

export interface VerificationInput extends Input<"verification"> {
  asOf: string;
  evidence: Evidence<ClaimNote | Observation>[];
}

export interface AnalysisInput extends Input<"analysis"> {
  evidence: Evidence<AnalysisNote | ScenarioNote>[];
  history: HistoryResult;
  verification: VerificationResult;
}

export type ResearchInput = DiscoveryInput | HistoryInput | VerificationInput | AnalysisInput;

interface Result<Stage extends ResearchStage> extends Identity {
  stage: Stage;
  sourceRegister: string[];
}

export interface DiscoveryResult extends Result<"discovery"> {
  headline: string;
  summary: string;
  locations: DiscoveryInput["locations"];
  entities: string[];
  scope: Scope;
  independentSourceCount: number;
  duplicateGroups: { documentIds: string[] }[];
  classification: "breaking" | "developing" | "trending" | "underreported" | "unclassified";
  ranking: { score: number; components: Scores; priority: Priority; rationale: string };
  historicalLeads: string[];
  evidenceGaps: string[];
  recommendation: "investigate" | "urgent_verification" | "monitor" | "archive";
}

export interface HistoricalFinding {
  subject: string;
  statement: string;
  period: Period;
  status: HistoricalNote["status"];
  perspective: Scope;
  evidenceIds: string[];
}

export interface HistoryResult extends Result<"history"> {
  researchId: string;
  depth: Depth;
  overview: string;
  period: { earliestYear: number | null; latestYear: number | null; rationale: string };
  origins: HistoricalFinding[];
  timeline: HistoricalFinding[];
  actors: HistoricalFinding[];
  rootCauses: HistoricalFinding[];
  previousResolutions: HistoricalFinding[];
  comparativeAnalysis: HistoricalFinding[];
  competingInterpretations: HistoricalFinding[];
  consequences: HistoricalFinding[];
  evidenceGaps: string[];
  confidence: Confidence;
}

export type Verdict = "verified" | "mostly_accurate" | "partially_accurate" | "misleading" | "false" | "unverified";
export type Action = "retain" | "correct" | "update" | "seek_evidence" | "escalate";

export interface EvidenceAssessment {
  evidenceIds: string[];
  independentSourceCount: number;
}

export interface VerifiedClaim {
  claimId: string;
  originalClaim: string;
  normalizedClaim: string;
  type: ClaimKind;
  material: boolean;
  sensitive: boolean;
  evidenceIds: string[];
  supporting: EvidenceAssessment;
  contradictory: EvidenceAssessment;
  excluded: EvidenceAssessment;
  verdict: Verdict;
  confidence: Confidence;
  outdated: boolean;
  limitations: string[];
  correctionRequired: boolean;
  correction: string | null;
  mixedAssessment: string | null;
  recommendedAction: Action;
}

export interface VerificationResult extends Result<"verification"> {
  verificationId: string;
  asOf: string;
  methodology: string[];
  claims: VerifiedClaim[];
}

export interface AnalyticalFinding {
  subject: string;
  statement: string;
  framing: Framing;
  scope: Scope;
  domain: Domain;
  evidenceIds: string[];
}

export interface Scenario {
  framing: "conditional_forecast";
  horizon: Horizon;
  months: [number, number];
  condition: string | null;
  outcome: string | null;
  assumptions: string[];
  earlyWarnings: string[];
  evidenceIds: string[];
}

export interface AnalysisResult extends Result<"analysis"> {
  analysisId: string;
  historyId: string;
  verificationId: string;
  executiveSummary: string;
  establishedFacts: { claimId: string; statement: string; evidenceIds: string[] }[];
  historicalContext: HistoricalFinding[];
  actors: AnalyticalFinding[];
  interests: AnalyticalFinding[];
  capabilities: AnalyticalFinding[];
  constraints: AnalyticalFinding[];
  alliances: AnalyticalFinding[];
  rivalries: AnalyticalFinding[];
  powerDynamics: AnalyticalFinding[];
  competingExplanations: AnalyticalFinding[];
  implications: AnalyticalFinding[];
  regionalImplications: AnalyticalFinding[];
  risks: AnalyticalFinding[];
  opportunities: AnalyticalFinding[];
  earlyWarnings: AnalyticalFinding[];
  assumptions: string[];
  scenarios: Record<ScenarioName, Scenario>;
  evidenceGaps: string[];
  confidence: Confidence;
}

export type ResearchResult = DiscoveryResult | HistoryResult | VerificationResult | AnalysisResult;
