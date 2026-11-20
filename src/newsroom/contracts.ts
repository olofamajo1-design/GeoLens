import { validateResult, validateTask } from "./generated/validators.mjs";
import type { AgentId } from "./registry";

interface AgentMessage {
  schemaVersion: 1;
  storyId: string;
  taskId: string;
  agentId: AgentId;
  attempt: number;
}

export interface AgentTask extends AgentMessage {
  topic: string;
}

export interface AgentResult extends AgentMessage {
  synthetic: boolean;
  summary: string;
  evidence: { sourceId: string; description: string }[];
}

export { validateResult, validateTask };

export interface NewsroomProvider {
  run(task: AgentTask): Promise<AgentResult>;
}

export async function runAgentTask(provider: NewsroomProvider, input: unknown) {
  if (!validateTask(input)) {
    throw new Error("Invalid agent task");
  }

  const result = await provider.run(input);
  if (!validateResult(result)) {
    throw new Error("Invalid agent result");
  }

  if (
    result.taskId !== input.taskId ||
    result.storyId !== input.storyId ||
    result.agentId !== input.agentId ||
    result.attempt !== input.attempt
  ) {
    throw new Error("Agent result does not match its task");
  }

  return result;
}
