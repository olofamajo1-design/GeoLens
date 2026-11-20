import { validateDiscovery } from "../newsroom/generated/validators.mjs";
import { parsePilotLeads, type PilotAdapter } from "./adapters.ts";
import { normalize } from "./normalize.ts";
import { retrieve, RetrievalFailure, type Retrieval } from "./retrieval.ts";
import type { pilotStore } from "./store.ts";

type Reservation = { status: "reserved"; id: string; locator: string } |
  { status: "inactive" | "not_due" | "quota_blocked" };
type Completion = { status: "complete" | "failed"; received: number; inserted: number; error?: string };

export async function runPilotSource(
  adapter: PilotAdapter,
  rpc: ReturnType<typeof pilotStore>,
  transport: Retrieval,
) {
  const reservation = await rpc<Reservation>("reserve_discovery_pilot", { source_adapter: adapter });
  if (reservation.status !== "reserved") return { adapter, ...reservation };
  const target_run = reservation.id;
  let documents;
  try {
    const result = await retrieve(adapter, reservation.locator, transport);
    const leads = result.body === null ? [] : parsePilotLeads(adapter, result.body);
    documents = (await Promise.all(leads.map((lead) => normalize(lead, adapter, { pilot: true }))))
      .filter((document) => document !== null);
    if (!validateDiscovery(documents)) throw new Error("invalid_payload");
  } catch (error) {
    const failure = error instanceof RetrievalFailure ? error.code : "invalid_payload";
    const retry_seconds = error instanceof RetrievalFailure ? error.retryAfterSeconds : 0;
    const result = await rpc<Completion>("finish_discovery_pilot", { target_run, documents: [], failure, retry_seconds });
    return { adapter, ...result };
  }
  const result = await rpc<Completion>("finish_discovery_pilot", { target_run, documents });
  return result.status === "complete"
    ? { adapter, duplicates: result.received - result.inserted, ...result }
    : { adapter, ...result };
}

export const pilotSources = ["gdelt", "world-bank"] as const satisfies readonly PilotAdapter[];
