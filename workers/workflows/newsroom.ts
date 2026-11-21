import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { executeFixture, type Claim } from "../../src/newsroom/execution";
import { promptManifest } from "../../src/newsroom/generated/prompts.mjs";
import { createOpenAIFixtureProvider } from "../../src/providers/openai-fixture.server";
import { localFixtureRpc } from "../../src/supabase/local-fixture";

type Schedule = { mode: "scan"; cycle: string } | { mode: "story"; runId: string };
type Method = "scan_newsroom_fixtures" | "claim_newsroom_fixtures" | "start_newsroom_fixture" | "finish_newsroom_fixture"
  | "ready_newsroom_editions" | "claim_newsroom_editions" | "finish_newsroom_edition";
type Batch = { state: string; claims: Claim[]; wakeAt?: string; budgetBlocked?: boolean };

const databaseStep: WorkflowStepConfig = {
  retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
  timeout: "30 seconds",
};
const executionStep: WorkflowStepConfig = {
  ...databaseStep,
  // Covers a 300-second lease plus the local start and settlement RPCs.
  timeout: "325 seconds",
};
const provider = createOpenAIFixtureProvider();

export function hasFixtureNewsroom(env: Env) {
  return env.NEWSROOM_MODE === "fixture" || env.NEWSROOM_MODE === "research-fixture" || env.NEWSROOM_MODE === "editorial-fixture";
}

export async function dispatchNewsroomScan(env: Env, cycle: string) {
  if (hasFixtureNewsroom(env)) {
    const prefix = env.NEWSROOM_MODE === "editorial-fixture" ? "newsroom-editorial-scan-" : "newsroom-scan-";
    await env.NEWSROOM.createBatch([{ id: prefix + cycle, params: { mode: "scan", cycle } }]);
  }
}

function database(env: Env) {
  if (!hasFixtureNewsroom(env) || !env.NEWSROOM_DB_URL
    || !env.NEWSROOM_DB_PUBLIC_KEY || !env.NEWSROOM_OPERATOR_JWT) throw new Error("fixture_newsroom_disabled");
  return localFixtureRpc<Method>(env.NEWSROOM_DB_URL, env.NEWSROOM_DB_PUBLIC_KEY, env.NEWSROOM_OPERATOR_JWT, "newsroom_store_");
}

export class NewsroomWorkflow extends WorkflowEntrypoint<Env, Schedule> {
  async run(event: WorkflowEvent<Schedule>, step: WorkflowStep) {
    const rpc = database(this.env);
    const payload = event.payload;
    const editorial = this.env.NEWSROOM_MODE === "editorial-fixture";
    if (payload.mode === "scan") {
      const runs = await step.do("rank discovery and queue fixtures", databaseStep,
        () => editorial ? rpc<string[]>("ready_newsroom_editions", {}) : rpc<string[]>("scan_newsroom_fixtures", {
          prompt_manifest: promptManifest, research_mode: this.env.NEWSROOM_MODE === "research-fixture",
        }));
      if (runs.length) {
        await step.do("dispatch fixture stories", databaseStep, async () => {
          await this.env.NEWSROOM.createBatch(runs.map((runId) => ({
            id: (editorial ? "newsroom-editorial-" : "newsroom-") + runId + "-" + payload.cycle,
            params: { mode: "story" as const, runId },
          })));
          return runs.length;
        });
      }
      return;
    }

    const target_run = payload.runId;
    // A later scan can recover a stopped Workflow. The database owns the attempt and retry limits.
    for (let sequence = 0; sequence < 128; sequence++) {
      const batch = await step.do("claim fixtures " + sequence, databaseStep,
        () => rpc<Batch>(editorial ? "claim_newsroom_editions" : "claim_newsroom_fixtures", { target_run }));
      if (batch.state !== "active") return;
      if (batch.claims.length) {
        await Promise.all(batch.claims.map((claim) => {
          const target_attempt = claim.task.attemptId;
          return step.do("execute fixture " + target_attempt, executionStep, async () => {
            const lease = { target_run, target_attempt };
            if (!await rpc<boolean>("start_newsroom_fixture", lease)) return "stale";
            const result = await executeFixture(claim, provider);
            const method = editorial ? "finish_newsroom_edition" : "finish_newsroom_fixture";
            if ("failure" in result) return rpc<string>(method, { ...lease, failure: result.failure });
            const usage = { ...lease, in_tokens: result.inputTokens, out_tokens: result.outputTokens };
            return editorial
              ? rpc<string>(method, { ...usage, production_result: result.productionResult })
              : rpc<string>(method, { ...usage, result: result.output, research_result: result.researchResult });
          });
        }));
      } else if (batch.budgetBlocked || !batch.wakeAt) {
        return;
      } else {
        await step.sleepUntil("wait for fixture eligibility " + sequence, new Date(batch.wakeAt));
      }
    }
  }
}
