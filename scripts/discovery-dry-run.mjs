import { parseLeads } from "../src/ingestion/adapters.ts";
import { fixturePayloads } from "../src/ingestion/fixtures.ts";
import { normalize } from "../src/ingestion/normalize.ts";

for (const [adapter, payload] of Object.entries(fixturePayloads)) {
  const documents = (await Promise.all(parseLeads(adapter, payload).map((lead) => normalize(lead, adapter)))).filter(Boolean);
  console.log(JSON.stringify({ synthetic: true, dryRun: true, adapter, documents }, null, 2));
}
