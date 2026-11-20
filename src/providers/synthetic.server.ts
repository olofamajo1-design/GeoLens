import type { NewsroomProvider } from "../newsroom/contracts";

export const syntheticProvider: NewsroomProvider = {
  async run(task) {
    return {
      schemaVersion: task.schemaVersion,
      storyId: task.storyId,
      taskId: task.taskId,
      agentId: task.agentId,
      attempt: task.attempt,
      synthetic: true,
      summary: "Fictional exercise for the foundation preview. No reporting was performed.",
      evidence: [
        { sourceId: "fixture-nigeria-001", description: "Synthetic source record. No publisher content." },
      ],
    };
  },
};
