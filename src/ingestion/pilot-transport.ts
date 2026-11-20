import { Resolver } from "node:dns/promises";
import { once } from "node:events";
import { Agent, request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity, connect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { endpoints, RetrievalFailure, type Retrieval } from "./retrieval.ts";

type DnsAnswer = { address: string; family: 4 | 6 };

const allowedDestinations = new Set([endpoints.gdelt, endpoints["world-bank"]]);
const ipv4SpecialUse = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) ipv4SpecialUse.addSubnet(network, prefix);

const ipv6Global = new BlockList();
ipv6Global.addSubnet("2000::", 3, "ipv6");
const ipv6SpecialUse = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) ipv6SpecialUse.addSubnet(network, prefix, "ipv6");

function publicAddress({ address, family }: DnsAnswer) {
  if (isIP(address) !== family || address.includes("%")) return false;
  if (family === 4) return !ipv4SpecialUse.check(address);
  return ipv6Global.check(address, "ipv6") && !ipv6SpecialUse.check(address, "ipv6");
}

export function pinPilotAddress(answers: readonly DnsAnswer[]) {
  if (!answers.length) throw new RetrievalFailure("dns_no_addresses");
  if (answers.some((answer) => !publicAddress(answer))) throw new RetrievalFailure("dns_destination_denied");
  return answers.find(({ family }) => family === 4) ?? answers[0];
}

export function assertPilotPeer(pinned: DnsAnswer, address: string | undefined, port: number | undefined, authorized: boolean) {
  if (!authorized || !address || port !== 443 || !publicAddress({ address, family: pinned.family })) {
    throw new RetrievalFailure("tls_peer_denied");
  }
  const family = pinned.family === 4 ? "ipv4" : "ipv6";
  const expected = new BlockList();
  expected.addAddress(pinned.address, family);
  if (!expected.check(address, family)) throw new RetrievalFailure("tls_peer_mismatch");
}

export function requireVerifiableEgress(environment: Record<string, string | undefined> = process.env) {
  // A hostname-only CONNECT tunnel hides the ultimate IP from this process.
  // Refusing it here preserves the configured network policy.
  const proxyKeys = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    "CODEX_PROXY_CERT", "CODEX_EXEC_SERVER_PROXY_PRIVATE_IPS_VIA_UPSTREAM",
  ];
  if (proxyKeys.some((key) => environment[key]) || environment.NODE_USE_ENV_PROXY === "1") {
    throw new RetrievalFailure("proxy_peer_unverifiable");
  }
}

async function resolvePilotHost(host: string, signal: AbortSignal): Promise<DnsAnswer[]> {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  const noRecords = (error: NodeJS.ErrnoException) => {
    if (error.code === "ENODATA") return [];
    throw error;
  };
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [ipv4, ipv6] = await Promise.all([
      resolver.resolve4(host).catch(noRecords),
      resolver.resolve6(host).catch(noRecords),
    ]);
    return [
      ...ipv4.map((address) => ({ address, family: 4 as const })),
      ...ipv6.map((address) => ({ address, family: 6 as const })),
    ];
  } catch {
    throw new RetrievalFailure(signal.aborted ? "retrieval_timeout" : "dns_resolution_failed");
  } finally {
    signal.removeEventListener("abort", cancel);
    resolver.cancel();
  }
}

async function sendOnValidatedSocket(url: URL, options: RequestInit, socket: TLSSocket, signal: AbortSignal) {
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  // HTTP can use only this already-verified socket. A second DNS lookup is impossible.
  agent.createConnection = () => socket;
  const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "identity" };
  const etag = new Headers(options.headers).get("if-none-match");
  if (etag && /^(W\/)?"[\x21\x23-\x7e]{0,240}"$/.test(etag)) headers["if-none-match"] = etag;

  return new Promise<Response>((resolve, reject) => {
    let outgoing: ReturnType<typeof request>;
    try {
      outgoing = request(url, { method: "GET", agent, headers, signal }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        const forwarded = new Headers();
        for (const name of ["content-type", "content-length", "etag", "retry-after"]) {
          const value = incoming.headers[name];
          if (typeof value === "string") forwarded.set(name, value);
        }
        incoming.once("close", () => agent.destroy());
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new RetrievalFailure("upstream_error"));
          return;
        }
        if (status !== 200) {
          incoming.destroy();
          resolve(new Response(null, { status, headers: forwarded }));
          return;
        }
        const encoding = incoming.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          incoming.destroy();
          reject(new RetrievalFailure("unexpected_content_encoding"));
          return;
        }
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          { status, headers: forwarded }));
      });
      outgoing.once("upgrade", (_response, upgraded) => {
        upgraded.destroy();
        agent.destroy();
        reject(new RetrievalFailure("upstream_error"));
      });
      outgoing.once("error", () => {
        agent.destroy();
        reject(new RetrievalFailure(signal.aborted ? "retrieval_timeout" : "upstream_connection_failed"));
      });
      outgoing.end();
    } catch (error) {
      agent.destroy();
      reject(error);
    }
  });
}

export function createPilotTransport(
  resolveHost = resolvePilotHost,
  openTls: (options: ConnectionOptions) => TLSSocket = connect,
): Retrieval {
  return async (url, options) => {
    if (!allowedDestinations.has(url.href) || (options.method && options.method !== "GET")) {
      throw new RetrievalFailure("destination_denied");
    }
    requireVerifiableEgress();
    const signal = options.signal ?? AbortSignal.timeout(10_000);
    const pinned = pinPilotAddress(await resolveHost(url.hostname, signal));
    signal.throwIfAborted();
    const socket = openTls({
      host: pinned.address, port: 443, servername: url.hostname,
      rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"],
      checkServerIdentity: (_name, certificate) => checkServerIdentity(url.hostname, certificate),
    });
    try {
      try {
        await once(socket, "secureConnect", { signal });
      } catch {
        throw new RetrievalFailure(signal.aborted ? "retrieval_timeout" : "tls_validation_failed");
      }
      assertPilotPeer(pinned, socket.remoteAddress, socket.remotePort, socket.authorized);
      signal.throwIfAborted();
      return await sendOnValidatedSocket(url, options, socket, signal);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}
