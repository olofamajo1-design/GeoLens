import { describe, expect, it } from "vitest";
import taskSchema from "../../src/schemas/agent-task.v1.json";
import resultSchema from "../../src/schemas/agent-result.v1.json";
import { runAgentTask, validateResult, validateTask } from "../../src/newsroom/contracts";
import { agents } from "../../src/newsroom/registry";
import { syntheticProvider } from "../../src/providers/synthetic.server";

const task = {
  schemaVersion: 1,
  storyId: "fixture-story",
  taskId: "fixture-task",
  agentId: "GL-AGENT-004",
  attempt: 1,
  topic: "Fictional briefing",
} as const;

describe("newsroom contracts", () => {
  it("registers the approved role IDs and names", () => {
    expect(agents).toEqual({
      "GL-AGENT-001": "Central Editorial Orchestrator",
      "GL-AGENT-002": "News Discovery Agent",
      "GL-AGENT-003": "Historical Research Agent",
      "GL-AGENT-004": "Verification Agent",
      "GL-AGENT-005": "Geopolitical Analysis Agent",
      "GL-AGENT-006": "Editorial Writing Agent",
      "GL-AGENT-007": "Visual Intelligence Agent",
      "GL-AGENT-008": "AI Editor-in-Chief",
    });
    expect(taskSchema.properties.agentId.enum).toEqual(Object.keys(agents));
    expect(resultSchema.properties.agentId.enum).toEqual(Object.keys(agents));
  });

  it.each([
    { agentId: "GL-AGENT-009" },
    { attempt: 0 },
    { attempt: 4 },
    { schemaVersion: 2 },
    { topic: "" },
    { humanApproved: true },
  ])("rejects invalid task fields %j", (fields) => {
    expect(validateTask({ ...task, ...fields })).toBe(false);
    return expect(runAgentTask(syntheticProvider, { ...task, ...fields })).rejects.toThrow("Invalid agent task");
  });

  it("returns correlated synthetic evidence for all registered agents", async () => {
    for (const agentId of Object.keys(agents)) {
      const result = await runAgentTask(syntheticProvider, { ...task, agentId });
      expect(result).toMatchObject({ agentId, taskId: task.taskId, synthetic: true });
      expect(result.evidence).toHaveLength(1);
    }
  });

  it("rejects malformed evidence and publication fields", async () => {
    const result = await syntheticProvider.run(task);
    expect(validateResult({ ...result, evidence: [{ sourceId: "fixture" }] })).toBe(false);
    expect(validateResult({ ...result, publish: true })).toBe(false);
    await expect(runAgentTask({ run: async () => ({ ...result, summary: "" }) }, task))
      .rejects.toThrow("Invalid agent result");
  });

  it("rejects a result from a different attempt", async () => {
    const result = await syntheticProvider.run(task);
    await expect(runAgentTask({ run: async () => ({ ...result, attempt: 2 }) }, task))
      .rejects.toThrow("Agent result does not match its task");
  });
});
