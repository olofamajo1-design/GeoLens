import { createRequestHandler } from "react-router";
import { dispatchNewsroomScan } from "./workflows/newsroom";

export { DiscoveryWorkflow } from "./workflows/discovery";
export { NewsroomWorkflow } from "./workflows/newsroom";

declare global {
  interface Env {
    DISCOVERY_DB_URL?: string;
    DISCOVERY_DB_PUBLIC_KEY?: string;
    DISCOVERY_OPERATOR_JWT?: string;
    NEWSROOM_DB_URL?: string;
    NEWSROOM_DB_PUBLIC_KEY?: string;
    NEWSROOM_OPERATOR_JWT?: string;
  }
}

const handleRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch: (request: Request) => handleRequest(request),
  async scheduled(controller, env) {
    const windowMs = 15 * 60 * 1000;
    const start = Math.floor(controller.scheduledTime / windowMs) * windowMs;
    await Promise.all([
      env.DISCOVERY_MODE === "fixture"
        ? env.DISCOVERY.createBatch([{ id: "discovery-" + start, params: { cycle: new Date(start).toISOString() } }])
        : undefined,
      dispatchNewsroomScan(env, "cron-" + start),
    ]);
  },
} satisfies ExportedHandler<Env>;
