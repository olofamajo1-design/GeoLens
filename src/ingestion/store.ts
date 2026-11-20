type FixtureMethod = "due_discovery" | "begin_discovery" | "finish_discovery";
type PilotMethod = "reserve_discovery_pilot" | "finish_discovery_pilot";

function localStore<Method extends string>(address: string, publicKey: string, operatorJwt: string, transport: typeof fetch) {
  const origin = new URL(address);
  if (origin.href !== "http://127.0.0.1:54321/") throw new Error("fixture_store_only");
  return async function rpc<T>(name: Method, args: object): Promise<T> {
    const result = await transport(new URL("/rest/v1/rpc/" + name, origin), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: {
        apikey: publicKey, authorization: "Bearer " + operatorJwt,
        "content-type": "application/json", "content-profile": "geo_api",
      },
      body: JSON.stringify(args),
    });
    if (!result.ok) throw new Error("ingestion_store_" + result.status);
    return await result.json() as T;
  };
}


export function fixtureStore(address: string, publicKey: string, operatorJwt: string, transport = fetch) {
  return localStore<FixtureMethod>(address, publicKey, operatorJwt, transport);
}

export function pilotStore(address: string, publicKey: string, operatorJwt: string, transport = fetch) {
  return localStore<PilotMethod>(address, publicKey, operatorJwt, transport);
}
