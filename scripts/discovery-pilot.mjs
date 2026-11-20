import { createPilotTransport, requireVerifiableEgress } from "../src/ingestion/pilot-transport.ts";
import { pilotSources, runPilotSource } from "../src/ingestion/pilot.ts";
import { pilotStore } from "../src/ingestion/store.ts";

const requested = process.argv.slice(2);
if (requested.includes("--help")) {
  console.log("Usage: npm run ingestion:pilot -- [gdelt|world-bank]");
  process.exit(0);
}
if (requested.length > 1 || requested.some((value) => !pilotSources.includes(value))) {
  console.error("Choose gdelt or world-bank, or omit the source to run both.");
  process.exit(1);
}
const candidates = requested.length ? requested : pilotSources;
try {
  requireVerifiableEgress();
  const { GEOLENS_PILOT_ANON_KEY, GEOLENS_PILOT_OPERATOR_JWT } = process.env;
  if (!GEOLENS_PILOT_ANON_KEY || !GEOLENS_PILOT_OPERATOR_JWT) throw new Error("local_pilot_credentials_required");
  const rpc = pilotStore("http://127.0.0.1:54321", GEOLENS_PILOT_ANON_KEY, GEOLENS_PILOT_OPERATOR_JWT);
  const transport = createPilotTransport();
  for (const adapter of candidates) {
    try {
      const result = await runPilotSource(adapter, rpc, transport);
      console.log(JSON.stringify(result));
      if (result.status !== "complete") process.exitCode = 1;
    } catch {
      console.error(JSON.stringify({ adapter, status: "failed", reason: "pilot_store_failed" }));
      process.exitCode = 1;
    }
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : "pilot_preflight_failed";
  for (const adapter of candidates) console.error(JSON.stringify({ adapter, status: "blocked", reason }));
  process.exitCode = 1;
}
