import type { AgentId } from "../registry";

interface PromptVersion {
  agentId: AgentId;
  version: number;
  digest: string;
}

export const promptManifest: readonly PromptVersion[];
export const fixturePrompts: readonly (PromptVersion & {
  text: string;
})[];
