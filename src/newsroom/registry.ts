export const agents = {
  "GL-AGENT-001": "Central Editorial Orchestrator",
  "GL-AGENT-002": "News Discovery Agent",
  "GL-AGENT-003": "Historical Research Agent",
  "GL-AGENT-004": "Verification Agent",
  "GL-AGENT-005": "Geopolitical Analysis Agent",
  "GL-AGENT-006": "Editorial Writing Agent",
  "GL-AGENT-007": "Visual Intelligence Agent",
  "GL-AGENT-008": "AI Editor-in-Chief",
} as const;

export type AgentId = keyof typeof agents;
