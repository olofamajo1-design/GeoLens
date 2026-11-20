import { describe, expect, it, vi } from "vitest";
import { executeFixture, type Claim } from "../../src/newsroom/execution";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { agents } from "../../src/newsroom/registry";
import { createOpenAIFixtureProvider } from "../../src/providers/openai-fixture.server";
import { localFixtureRpc } from "../../src/supabase/local-fixture";

function claim(): Claim {
  const id = "9a73bbbf-2fbf-40f6-b7e9-349a30362e1d";
  const prompt = promptManifest.find(({ agentId }) => agentId === "GL-AGENT-003")!;
  return {
    task: {
      contractVersion: 1, synthetic: true, agentId: "GL-AGENT-003", stage: "history", round: 0, attempt: 1,
      runId: id, eventId: id, taskId: id, attemptId: id, verificationAttention: true,
      dependencies: [], revisionRequest: null,
    },
    promptVersion: prompt.version, promptDigest: prompt.digest, model: "configured-fixture-model",
    maxInputTokens: 4096, maxOutputTokens: 512, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

const output = { synthetic: true, disposition: "complete", summary: "Synthetic fixture.", revisionStage: null } as const;

describe("fixture agent execution engine", () => {
  it("pins all eight versioned prompts with content digests", () => {
    expect(promptManifest.map(({ agentId }) => agentId)).toEqual(Object.keys(agents));
    expect(new Set(promptManifest.map(({ digest }) => digest)).size).toBe(8);
    for (const prompt of promptManifest) expect(prompt.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates and dispatches a configurable in-process OpenAI structured output request", async () => {
    const transport = vi.fn(async () => ({
      status: "completed", usage: { input_tokens: 12, output_tokens: 4 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    }));
    const task = claim();
    expect(await executeFixture(task, createOpenAIFixtureProvider(transport))).toEqual({
      output, inputTokens: 12, outputTokens: 4,
    });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      model: task.model, max_output_tokens: 512, store: false,
      text: { format: expect.objectContaining({ type: "json_schema", strict: true }) },
      input: [
        { role: "developer", content: expect.stringContaining("Historical Research Agent") },
        { role: "user", content: JSON.stringify(task.task) },
      ],
    }), expect.any(AbortSignal));
  });

  it("rejects unknown fields, role mismatches, and prompt digest changes before invocation", async () => {
    const original = claim();
    const provider = vi.fn(async () => ({ output, inputTokens: 12, outputTokens: 4 }));
    const altered = [
      { ...original, task: { ...original.task, publish: true } },
      { ...original, task: { ...original.task, agentId: "GL-AGENT-008" as const } },
      { ...original, promptDigest: "0".repeat(64) },
      { ...original, task: { ...original.task, dependencies: [{ taskId: original.task.taskId,
        stage: "verification" as const, result: { ...output, disposition: "critical" as const } }] } },
    ];
    for (const task of altered) expect(await executeFixture(task, provider)).toEqual({ failure: "invalid_input" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects invalid responses, privileged instructions and usage outside the reservation", async () => {
    const result = { output, inputTokens: 12, outputTokens: 4 };
    for (const candidate of [
      { ...output, publish: true },
      { ...output, synthetic: false },
      { ...output, disposition: "revision_requested", revisionStage: "writing" },
    ]) {
      expect(await executeFixture(claim(), async () => ({ ...result, output: candidate }))).toEqual({ failure: "invalid_output" });
    }
    expect(await executeFixture(claim(), async () => ({ ...result, outputTokens: 513 }))).toEqual({ failure: "usage_limit" });
    expect(await executeFixture(claim(), createOpenAIFixtureProvider(async () => ({ status: "incomplete" }))))
      .toEqual({ failure: "provider_error" });
  });

  it("stops a provider when the lease expires and never dispatches an expired claim", async () => {
    vi.useFakeTimers();
    try {
      const lease = { ...claim(), leaseExpiresAt: new Date(Date.now() + 200).toISOString() };
      let observed: AbortSignal | undefined;
      const provider = vi.fn(({ signal }: { signal: AbortSignal }) => {
        observed = signal;
        return new Promise<never>(() => {});
      });
      const running = executeFixture(lease, provider);
      await vi.advanceTimersByTimeAsync(200);
      expect(await running).toEqual({ failure: "timeout" });
      expect(observed?.aborted).toBe(true);
      expect(await executeFixture(lease, provider)).toEqual({ failure: "timeout" });
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits fixture database credentials to the exact local Supabase origin", () => {
    const transport = vi.fn();
    for (const url of ["https://api.openai.com", "http://127.0.0.1:54321@other.invalid", "http://127.0.0.1:54321/path"]) {
      expect(() => localFixtureRpc(url, "synthetic", "synthetic", "test_", transport)).toThrow("fixture_store_only");
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
