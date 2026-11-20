import { createRequestHandler } from "react-router";

export { DiscoveryWorkflow } from "./workflows/discovery";

declare global {
  interface Env {
    DISCOVERY_DB_URL?: string;
    DISCOVERY_DB_PUBLIC_KEY?: string;
    DISCOVERY_OPERATOR_JWT?: string;
  }
}

const handleRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch: (request: Request) => handleRequest(request),
  async scheduled(controller, env) {
    if (env.DISCOVERY_MODE !== "fixture") return;
    const windowMs = 15 * 60 * 1000;
    const start = Math.floor(controller.scheduledTime / windowMs) * windowMs;
    await env.DISCOVERY.createBatch([{ id: "discovery-" + start, params: { cycle: new Date(start).toISOString() } }]);
  },
} satisfies ExportedHandler<Env>;
