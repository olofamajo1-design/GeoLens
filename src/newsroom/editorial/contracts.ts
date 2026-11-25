import {
  validateWritingInput, validateWritingOutput, validateVisualInput, validateVisualOutput,
  validateReverificationInput, validateReverificationOutput, validateEditorialInput, validateEditorialOutput,
} from "../generated/validators.mjs";
import { canonicalJson } from "../research/contracts.ts";
import { reverifyEdition, reviewEdition } from "./review.ts";
import { identity } from "./types.ts";
import type { EditorialIdentity, ProductionInput, ProductionResult, ProductionStage } from "./types";
import { assembleVisuals } from "./visual.ts";
import { validWriting, writeArticle } from "./writing.ts";
import type { FixtureOutput } from "../execution";

const validators = {
  writing: { input: validateWritingInput, output: validateWritingOutput },
  visual: { input: validateVisualInput, output: validateVisualOutput },
  reverification: { input: validateReverificationInput, output: validateReverificationOutput },
  editorial: { input: validateEditorialInput, output: validateEditorialOutput },
} as const;

export function isProductionStage(stage: string): stage is ProductionStage {
  return Object.hasOwn(validators, stage);
}

function sameStory(a: EditorialIdentity, b: EditorialIdentity): boolean {
  return a.runId === b.runId && a.storyId === b.storyId && a.eventId === b.eventId;
}

export function validateProductionInput(stage: ProductionStage, value: unknown): value is ProductionInput {
  if (!validators[stage].input(value)) return false;
  const input = value as ProductionInput;
  if (input.stage === "visual") {
    return new Set(input.candidates.map(({ id }) => id)).size === input.candidates.length
      && (input.qualityRubric !== 1 || input.candidates.every((asset) =>
        asset.title && asset.purpose && asset.snapshot && asset.licence.terms && asset.licence.validUntil !== undefined && !asset.quality));
  }
  if (new Set(input.material.map(({ id }) => id)).size !== input.material.length) return false;
  if (input.stage === "writing") return input.formats[0] === "quick_brief" && input.formats[1] === "deep_dive";
  if (!sameStory(input, input.article) || !sameStory(input, input.visual)
    || input.article.round > input.round || input.visual.round > input.round) return false;
  return input.stage !== "editorial" || (sameStory(input, input.verification)
    && input.verification.round === input.round && canonicalJson(input.verification.version) === canonicalJson(input.version));
}

export function buildProductionResult(input: ProductionInput): ProductionResult {
  switch (input.stage) {
    case "writing": return writeArticle(input);
    case "visual": return assembleVisuals(input);
    case "reverification": return reverifyEdition(input);
    case "editorial": return reviewEdition(input);
  }
}

export function validateProductionResult(input: ProductionInput, output: unknown): output is ProductionResult {
  if (!validators[input.stage].output(output)) return false;
  if (input.stage === "writing" && validateWritingOutput(output)) {
    return canonicalJson(identity(input)) === canonicalJson(identity(output)) && validWriting(input, output);
  }
  return canonicalJson(buildProductionResult(input)) === canonicalJson(output);
}

export function productionDisposition(result: ProductionResult): FixtureOutput {
  let disposition: FixtureOutput["disposition"] = "complete";
  let revisionStage: FixtureOutput["revisionStage"] = null;
  if (result.stage === "reverification" && result.status === "hold") disposition = "critical";
  if (result.stage === "editorial") {
    if (result.decision === "hold" || result.decision === "reject") disposition = "critical";
    if (result.decision === "minor_revision" || result.decision === "major_revision") {
      disposition = "revision_requested";
      revisionStage = result.issues[0]?.agentId === "GL-AGENT-007" ? "visual" : "writing";
    }
  }
  return { synthetic: true, disposition, summary: "Private fixture " + result.stage + " assessed.", revisionStage };
}
