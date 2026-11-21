import type { AgentResult, AgentTask } from "../contracts";
import type { FixtureTask, FixtureOutput } from "../execution";
import type {
  DiscoveryInput, DiscoveryResult, HistoryInput, HistoryResult, VerificationInput, VerificationResult, AnalysisInput, AnalysisResult,
} from "../research/types";
import type {
  WritingInput, WritingResult, VisualInput, VisualResult, ReverificationInput, ReverificationResult, EditorialInput, EditorialResult,
} from "../editorial/types";

export function validateTask(input: unknown): input is AgentTask;
export function validateResult(input: unknown): input is AgentResult;

export function validateDiscovery(input: unknown): boolean;
export function validateFixtureTask(input: unknown): input is FixtureTask;
export function validateFixtureOutput(input: unknown): input is FixtureOutput;
export function validateDiscoveryInput(input: unknown): input is DiscoveryInput;
export function validateDiscoveryOutput(input: unknown): input is DiscoveryResult;
export function validateHistoryInput(input: unknown): input is HistoryInput;
export function validateHistoryOutput(input: unknown): input is HistoryResult;
export function validateVerificationInput(input: unknown): input is VerificationInput;
export function validateVerificationOutput(input: unknown): input is VerificationResult;
export function validateAnalysisInput(input: unknown): input is AnalysisInput;
export function validateAnalysisOutput(input: unknown): input is AnalysisResult;
export function validateWritingInput(input: unknown): input is WritingInput;
export function validateWritingOutput(input: unknown): input is WritingResult;
export function validateVisualInput(input: unknown): input is VisualInput;
export function validateVisualOutput(input: unknown): input is VisualResult;
export function validateReverificationInput(input: unknown): input is ReverificationInput;
export function validateReverificationOutput(input: unknown): input is ReverificationResult;
export function validateEditorialInput(input: unknown): input is EditorialInput;
export function validateEditorialOutput(input: unknown): input is EditorialResult;
