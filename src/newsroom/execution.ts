import { validateFixtureOutput, validateFixtureTask } from "./generated/validators.mjs";
import { fixturePrompts } from "./generated/prompts.mjs";
import type { AgentId } from "./registry";
import { isResearchStage, researchDisposition, validateResearchInput, validateResearchResult } from "./research/contracts.ts";
import type { ResearchInput, ResearchResult } from "./research/types";

const stageAgents = {
  discovery: "GL-AGENT-002", history: "GL-AGENT-003", verification: "GL-AGENT-004",
  analysis: "GL-AGENT-005", writing: "GL-AGENT-006", visual: "GL-AGENT-007",
  reverification: "GL-AGENT-004", editorial: "GL-AGENT-008",
} as const;

type Stage = keyof typeof stageAgents;

export interface FixtureOutput {
  synthetic: true;
  disposition: "complete" | "incomplete" | "critical" | "revision_requested";
  summary: string;
  revisionStage: "writing" | "visual" | null;
}

export interface FixtureTask {
  contractVersion: 1;
  synthetic: true;
  runId: string;
  eventId: string;
  taskId: string;
  attemptId: string;
  agentId: Exclude<AgentId, "GL-AGENT-001">;
  stage: Stage;
  round: number;
  attempt: number;
  verificationAttention: boolean;
  dependencies: { taskId: string; stage: Stage; result: FixtureOutput }[];
  revisionRequest: FixtureOutput | null;
}

export interface Claim {
  task: FixtureTask;
  researchInput?: ResearchInput;
  promptVersion: number;
  promptDigest: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  leaseExpiresAt: string;
}

export type Failure = "invalid_input" | "invalid_output" | "provider_error" | "usage_limit" | "timeout";
export type AttemptResult =
  | { failure: Failure }
  | { output: FixtureOutput; inputTokens: number; outputTokens: number; researchResult?: ResearchResult };

export type FixtureProvider = (args: {
  task: FixtureTask;
  researchInput?: ResearchInput;
  instructions: string;
  model: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}) => Promise<{ output: unknown; inputTokens: unknown; outputTokens: unknown }>;

function validOutcome(value: unknown, stage: Stage): value is FixtureOutput {
  return validateFixtureOutput(value)
    && (value.disposition === "revision_requested"
      ? stage === "editorial" && value.revisionStage !== null
      : value.revisionStage === null);
}

export async function executeFixture(claim: Claim, provider: FixtureProvider): Promise<AttemptResult> {
  const { task, researchInput } = claim;
  if (!validateFixtureTask(task) || stageAgents[task.stage] !== task.agentId
    || task.dependencies.some(({ stage, result }) => !validOutcome(result, stage) || result.disposition !== "complete")
    || (task.revisionRequest !== null
      && (!validOutcome(task.revisionRequest, "editorial") || task.revisionRequest.revisionStage !== task.stage))) {
    return { failure: "invalid_input" };
  }
  const prompt = fixturePrompts.find(({ agentId, version, digest }) =>
    agentId === task.agentId && version === claim.promptVersion && digest === claim.promptDigest);
  if (!prompt) return { failure: "invalid_input" };
  let research: ResearchInput | undefined;
  if (researchInput !== undefined) {
    if (prompt.version < 2 || !isResearchStage(task.stage) || !validateResearchInput(task.stage, researchInput)
      || researchInput.attemptId !== task.attemptId || researchInput.eventId !== task.eventId) return { failure: "invalid_input" };
    research = researchInput;
  }

  const remaining = Date.parse(claim.leaseExpiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { failure: "timeout" };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider({
        task, researchInput: research, instructions: prompt.text, model: claim.model,
        maxOutputTokens: claim.maxOutputTokens, signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("fixture_timeout"));
        }, Math.min(remaining, task.stage === "history" || task.stage === "visual" ? 300_000 : 180_000));
      }),
    ]);
    const { output, inputTokens, outputTokens } = result;
    if (research) {
      if (!validateResearchResult(research, output)) return { failure: "invalid_output" };
      if (!withinLimit(inputTokens, claim.maxInputTokens) || !withinLimit(outputTokens, claim.maxOutputTokens)) {
        return { failure: "usage_limit" };
      }
      return {
        researchResult: output, inputTokens, outputTokens,
        output: { synthetic: true, disposition: researchDisposition(output),
          summary: "Synthetic " + output.stage + " finding assessed.", revisionStage: null },
      };
    }
    if (!validOutcome(output, task.stage)) return { failure: "invalid_output" };
    if (!withinLimit(inputTokens, claim.maxInputTokens) || !withinLimit(outputTokens, claim.maxOutputTokens)) {
      return { failure: "usage_limit" };
    }
    return { output, inputTokens, outputTokens };
  } catch {
    return { failure: controller.signal.aborted ? "timeout" : "provider_error" };
  } finally {
    clearTimeout(timeout);
  }
}

function withinLimit(tokens: unknown, maximum: number): tokens is number {
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= maximum;
}
