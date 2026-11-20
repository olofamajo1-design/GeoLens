import type { AgentResult, AgentTask } from "../contracts";
import type { FixtureTask, FixtureOutput } from "../execution";

export function validateTask(input: unknown): input is AgentTask;
export function validateResult(input: unknown): input is AgentResult;

export function validateDiscovery(input: unknown): boolean;
export function validateFixtureTask(input: unknown): input is FixtureTask;
export function validateFixtureOutput(input: unknown): input is FixtureOutput;
