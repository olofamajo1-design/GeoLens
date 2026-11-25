import { localFixtureRpc } from "../supabase/local-fixture.ts";

type FixtureMethod = "due_discovery" | "begin_discovery" | "finish_discovery";
type PilotMethod = "reserve_discovery_pilot" | "finish_discovery_pilot";

export function fixtureStore(address: string, publicKey: string, operatorJwt: string, transport = fetch) {
  return localFixtureRpc<FixtureMethod>(address, publicKey, operatorJwt, "ingestion_store_", transport);
}

export function pilotStore(address: string, publicKey: string, operatorJwt: string, transport = fetch) {
  return localFixtureRpc<PilotMethod>(address, publicKey, operatorJwt, "ingestion_store_", transport);
}
