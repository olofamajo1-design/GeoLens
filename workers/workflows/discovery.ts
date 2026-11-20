import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { parseLeads, type Adapter } from "../../src/ingestion/adapters";
import { fixturePayloads } from "../../src/ingestion/fixtures";
import { normalize } from "../../src/ingestion/normalize";
import { validateDiscovery } from "../../src/newsroom/generated/validators.mjs";
import { fixtureStore } from "../../src/ingestion/store";
import { dispatchNewsroomScan } from "./newsroom";

type ScheduledDiscovery = { cycle: string };
type DiscoveryRun = { id: string; adapter: Adapter; fixture: boolean };
const stepOptions: WorkflowStepConfig = { retries: { limit: 2, delay: "5 seconds", backoff: "constant" as const }, timeout: "30 seconds" };

export function discoveryStore(env: Env) {
  if (env.DISCOVERY_MODE !== "fixture" || !env.DISCOVERY_DB_URL ||
    !env.DISCOVERY_DB_PUBLIC_KEY || !env.DISCOVERY_OPERATOR_JWT) throw new Error("fixture_discovery_disabled");
  return fixtureStore(env.DISCOVERY_DB_URL, env.DISCOVERY_DB_PUBLIC_KEY, env.DISCOVERY_OPERATOR_JWT);
}

export class DiscoveryWorkflow extends WorkflowEntrypoint<Env, ScheduledDiscovery> {
  async run(event: WorkflowEvent<ScheduledDiscovery>, step: WorkflowStep) {
    const rpc = discoveryStore(this.env);
    const due = await step.do("list due sources", stepOptions, () => rpc<string[]>("due_discovery", {}));
    let completedFixture = false;
    for (const endpoint of due) {
      const run = await step.do("begin " + endpoint, stepOptions, () => rpc<DiscoveryRun | null>("begin_discovery", {
        source_endpoint: endpoint, cycle_time: event.payload.cycle,
      }));
      if (!run?.fixture) continue;
      const normalized = await step.do("normalize " + endpoint, async () => {
        try {
          const leads = parseLeads(run.adapter, fixturePayloads[run.adapter]);
          const documents = (await Promise.all(leads.map((lead) => normalize(lead, run.adapter))))
            .filter((document) => document !== null);
          if (!validateDiscovery(documents)) throw new Error("invalid_payload");
          return { documents, failure: null };
        } catch {
          return { documents: [], failure: "invalid_payload" };
        }
      });
      const state = await step.do("finish " + endpoint, stepOptions, () => rpc<string>("finish_discovery", {
        target_run: run.id, ...normalized,
      }));
      if (state === "complete") completedFixture = true;
    }
    if (completedFixture && this.env.NEWSROOM_MODE === "fixture") {
      await step.do("reassess newsroom after discovery", stepOptions, async () => {
        await dispatchNewsroomScan(this.env, "discovery-" + Date.parse(event.payload.cycle));
        return null;
      });
    }
  }
}
