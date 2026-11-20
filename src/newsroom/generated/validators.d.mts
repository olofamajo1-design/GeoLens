import type { AgentResult, AgentTask } from "../contracts";

export function validateTask(input: unknown): input is AgentTask;
export function validateResult(input: unknown): input is AgentResult;

export function validateDiscovery(input: unknown): boolean;
