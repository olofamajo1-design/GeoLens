export const articleFormats = [
  "quick_brief", "deep_dive", "historical_explainer", "geopolitical_analysis",
  "investigative_report", "special_feature", "factcheck_report",
] as const;
export type ArticleFormat = typeof articleFormats[number];
export type EditorialCategory = "nigeria" | "africa" | "world" | "history" | "geopolitics" | "factcheck";

export const sections = ["overview", "facts", "history", "analysis", "scenarios", "limitations"] as const;
export type Section = typeof sections[number];
export type Frame = "verified_fact" | "unverified_allegation" | "documented_history" | "disputed_interpretation"
  | "documented_objective" | "inferred_intention" | "analytical_assumption" | "conditional_scenario" | "editorial_context";

export interface Material {
  id: string;
  section: Section;
  frame: Frame;
  text: string;
  evidenceIds: string[];
  claimIds: string[];
}

export interface EditorialIdentity {
  contractVersion: 1;
  synthetic: true;
  runId: string;
  eventId: string;
  storyId: string;
  attemptId: string;
  round: number;
}

export interface Version {
  id: string;
  number: number;
  digest: string;
}

export interface Article {
  format: ArticleFormat;
  headlines: [string, string, string];
  standfirst: string;
  sections: { kind: Section; blocks: Material[] }[];
  wordCount: number;
  metadata?: ArticleMetadata;
}

export interface ArticleMetadata {
  seoTitle: string;
  seoDescription: string;
  categories: EditorialCategory[];
  tags: string[];
  socialSummary: string;
  wordCountGuideline: { minWords: number; maxWords: number; allowsLonger: boolean };
}

export interface ProposedClaim {
  statement: string;
  evidenceIds: string[];
}

export interface WritingInput extends EditorialIdentity {
  stage: "writing";
  researchId: string;
  formats: ArticleFormat[];
  headlines: Article["headlines"];
  standfirst: string;
  material: Material[];
  sourceRegister: string[];
  revisionInstructions: string[];
  revisionIssues?: RevisionIssue[];
  classification?: { category: "nigeria" | "africa" | "world"; tags: string[] };
}

export interface WritingResult extends EditorialIdentity {
  stage: "writing";
  researchId: string;
  sourceRegister: string[];
  articles: Article[];
  proposedClaims: ProposedClaim[];
}

export type VisualData =
  | { kind: "map"; renderer: "maplibre"; basemap: "stadia_disabled"; geojson: {
      type: "FeatureCollection"; features: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] };
        properties: { name: string; accuracy: "exact" | "approximate"; boundary: "recognized" | "disputed" | "none" } }[];
    } }
  | { kind: "chart"; scale: "linear"; baseline: 0; unit: string; values: { label: string; value: number; claimId: string }[] }
  | { kind: "timeline"; entries: { label: string; startYear: number | null; endYear: number | null; certainty: string }[] }
  | { kind: "infographic"; points: string[] }
  | { kind: "relationship"; nodes: string[]; links: { from: string; to: string; relationship: string }[] }
  | { kind: "photo"; assetVersionId: string; disclosure: "Synthetic licensed media fixture" }
  | { kind: "illustration"; assetVersionId: string; disclosure: "AI-generated synthetic illustration" };

export interface VisualAsset {
  id: string;
  version: number;
  digest: string;
  data: VisualData;
  caption: string;
  alt: string;
  uncertainty: string;
  evidenceIds: string[];
  documentIds: string[];
  provenance: "research_fixture" | "licensed_fixture" | "mock_ai";
  licence: { status: "active" | "missing" | "expired" | "revoked"; reference: string; terms?: string; validUntil?: string | null };
  title?: string;
  purpose?: string;
  snapshot?: { capturedAt: string; observedOn: string | null; dataDigest: string };
  quality?: VisualQuality;
}

export const visualRubricWeights = {
  factual_and_data_accuracy: 30,
  geographical_accuracy: 20,
  clarity: 15,
  editorial_relevance: 10,
  accessibility: 10,
  attribution_and_licensing: 10,
  brand_consistency: 5,
} as const;
export type VisualFactor = keyof typeof visualRubricWeights;
export interface VisualQuality {
  ratings: Record<Exclude<VisualFactor, "geographical_accuracy">, number> & { geographical_accuracy: number | null };
  score: number;
  critical: ("accuracy" | "licensing" | "security")[];
}

export interface VisualInput extends EditorialIdentity {
  stage: "visual";
  candidates: VisualAsset[];
  revisionInstructions: string[];
  revisionIssues?: RevisionIssue[];
  qualityRubric?: 1;
}

export interface VisualResult extends EditorialIdentity {
  stage: "visual";
  assets: VisualAsset[];
  blockedAssetIds: string[];
  layout: { responsive: true; foreground: "--ink"; accent: "--accent"; fallback: "text_and_data" };
}

export interface ReviewPackage {
  version: Version;
  article: WritingResult;
  visual: VisualResult;
  material: Material[];
  rightsActive: boolean;
  independentOrigins: number;
}

export interface ReverificationInput extends EditorialIdentity, ReviewPackage {
  stage: "reverification";
}

export interface ReverificationResult extends EditorialIdentity {
  stage: "reverification";
  version: Version;
  status: "verified" | "hold";
  checkedClaims: string[];
  unresolved: ProposedClaim[];
  critical: ("unverified_claim" | "invalid_grounding" | "rights" | "privacy" | "security")[];
}

export const rubricWeights = {
  factual_accuracy_and_evidence: 25,
  research_completeness_and_context: 15,
  balance_and_independence: 15,
  analytical_quality: 15,
  writing_quality: 10,
  source_transparency: 10,
  visual_accuracy_and_quality: 5,
  legal_ethical_and_safety: 5,
} as const;
export type Factor = keyof typeof rubricWeights;
export type Decision = "ready_for_human_review" | "minor_revision" | "major_revision" | "hold" | "reject";

export interface RevisionIssue {
  code: "rights" | "privacy" | "security" | "unverified_claim" | "invalid_grounding" | "missing_history" | "missing_analysis"
    | "missing_visuals" | "source_balance" | "below_threshold";
  severity: "critical" | "major" | "minor";
  agentId: "GL-AGENT-004" | "GL-AGENT-006" | "GL-AGENT-007" | "GL-AGENT-008";
  instruction: string;
  detail?: {
    affected: { kind: "claim" | "section" | "visual"; ref: string }[];
    problem: string;
    evidenceIds: string[];
    evidenceGap: string | null;
    blocksPublication: true;
  };
}

export interface EditorialInput extends EditorialIdentity, ReviewPackage {
  stage: "editorial";
  verification: ReverificationResult;
  reviewSpec?: 2;
}

export interface EditorialResult extends EditorialIdentity {
  stage: "editorial";
  version: Version;
  ratings: Record<Factor, number>;
  score: number;
  decision: Decision;
  issues: RevisionIssue[];
}

export type ProductionInput = WritingInput | VisualInput | ReverificationInput | EditorialInput;
export type ProductionResult = WritingResult | VisualResult | ReverificationResult | EditorialResult;
export type ProductionStage = ProductionInput["stage"];

export function identity(input: EditorialIdentity): EditorialIdentity {
  const { contractVersion, synthetic, runId, eventId, storyId, attemptId, round } = input;
  return { contractVersion, synthetic, runId, eventId, storyId, attemptId, round };
}
