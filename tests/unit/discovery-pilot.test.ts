import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { ConnectionOptions, PeerCertificate, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePilotLeads } from "../../src/ingestion/adapters";
import { normalize } from "../../src/ingestion/normalize";
import { assertPilotPeer, createPilotTransport, pinPilotAddress, requireVerifiableEgress } from "../../src/ingestion/pilot-transport";
import { endpoints, retrieve } from "../../src/ingestion/retrieval";

const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", async (original) => ({
  ...await original<typeof import("node:https")>(),
  request: http.request,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  http.request.mockReset();
});

describe("live pilot destination checks", () => {
  const ipv4 = { family: 4 as const, address: "93.184.216.34" };

  it.each([
    ["127.0.0.1", 4], ["10.0.0.1", 4], ["169.254.169.254", 4], ["100.64.0.1", 4], ["198.18.0.1", 4],
    ["192.0.2.1", 4], ["224.0.0.1", 4], ["0.0.0.0", 4], ["::1", 6], ["::ffff:7f00:1", 6],
    ["fc00::1", 6], ["fe80::1", 6], ["2001:db8::1", 6], ["2002:c0a8:1::1", 6], ["3fff::1", 6],
  ] as const)("rejects a mixed DNS response containing %s", (address, family) => {
    expect(() => pinPilotAddress([ipv4, { address, family }])).toThrow("dns_destination_denied");
  });

  it("pins one IP only after validating all answers", () => {
    const ipv6 = { family: 6 as const, address: "2606:4700::6812:1" };
    expect(pinPilotAddress([ipv6, ipv4])).toBe(ipv4);
    expect(pinPilotAddress([ipv6])).toBe(ipv6);
    expect(() => pinPilotAddress([])).toThrow("dns_no_addresses");
    expect(() => pinPilotAddress([{ address: ipv4.address, family: 6 }])).toThrow("dns_destination_denied");
    expect(() => assertPilotPeer(ipv6, "2606:4700:0:0:0:0:6812:1", 443, true)).not.toThrow();
  });

  it("refuses a proxy route whose provider peer is hidden", () => {
    expect(() => requireVerifiableEgress({ HTTPS_PROXY: "http://egress.example:8080" })).toThrow("proxy_peer_unverifiable");
    expect(() => requireVerifiableEgress({ CODEX_PROXY_CERT: "/example/ca.pem" })).toThrow("proxy_peer_unverifiable");
    expect(() => requireVerifiableEgress({})).not.toThrow();
  });

  // Clear proxy environment only for fake DNS, TLS and HTTP in these tests.
  function fakeDirectRoute() {
    for (const key of [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
      "CODEX_PROXY_CERT", "CODEX_EXEC_SERVER_PROXY_PRIVATE_IPS_VIA_UPSTREAM", "NODE_USE_ENV_PROXY",
    ]) vi.stubEnv(key, "");
  }

  function fakeTls(address = ipv4.address, authorized = true, port = 443) {
    const emitter = new EventEmitter();
    const destroy = vi.fn();
    const socket = Object.assign(emitter, { remoteAddress: address, remotePort: port, authorized, destroy }) as unknown as TLSSocket;
    const open = vi.fn((_options: ConnectionOptions) => {
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    });
    return { open, socket, destroy };
  }

  it("rejects different paths, additional hosts and POST without opening a socket", async () => {
    const resolve = vi.fn(async () => [ipv4]);
    const { open } = fakeTls();
    const transport = createPilotTransport(resolve, open);
    for (const uri of ["https://api.gdeltproject.org/different", "https://www.premiumtimesng.com/feed", endpoints.gdelt + "&extra=1"]) {
      await expect(transport(new URL(uri), {})).rejects.toThrow("destination_denied");
    }
    await expect(transport(new URL(endpoints.gdelt), { method: "POST" })).rejects.toThrow("destination_denied");
    expect(resolve).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["93.184.216.35", 443, true, "tls_peer_mismatch"],
    ["127.0.0.1", 443, true, "tls_peer_denied"],
    ["93.184.216.34", 8443, true, "tls_peer_denied"],
    ["93.184.216.34", 443, false, "tls_peer_denied"],
  ] as const)("refuses the connection before HTTP for peer %s:%s, authorized=%s",
    async (address, port, authorized, error) => {
      fakeDirectRoute();
      const { open, destroy } = fakeTls(address, authorized, port);
      const transport = createPilotTransport(async () => [ipv4], open);
      await expect(transport(new URL(endpoints.gdelt), {})).rejects.toThrow(error);
      expect(http.request).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    });

  it("uses the verified socket for one credential-free GET and validates the provider hostname", async () => {
    fakeDirectRoute();
    const { open, socket } = fakeTls();
    const dns = vi.fn(async () => [ipv4]);
    const transport = createPilotTransport(dns, open);
    http.request.mockImplementation((url: URL, options, onResponse: (incoming: IncomingMessage) => void) => {
      expect(url.href).toBe(endpoints["world-bank"]);
      expect(options.agent.createConnection()).toBe(socket);
      expect(options.headers).toEqual({ accept: "application/json", "accept-encoding": "identity" });
      expect(options.method).toBe("GET");
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = (() => {
        const incoming = Object.assign(Readable.from([Buffer.from("[]")]), {
          statusCode: 200, headers: { "content-type": "application/json" },
        }) as unknown as IncomingMessage;
        onResponse(incoming);
        return outgoing;
      }) as ClientRequest["end"];
      return outgoing;
    });
    const reply = await transport(new URL(endpoints["world-bank"]), { headers: { Authorization: "unforwarded" } });
    expect(await reply.text()).toBe("[]");
    expect(dns).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    const socketOptions = open.mock.calls[0][0];
    expect(socketOptions).toMatchObject({ host: ipv4.address, port: 443, servername: "api.worldbank.org", rejectUnauthorized: true });
    expect(socketOptions.checkServerIdentity?.("ignored", { subjectaltname: "DNS:api.worldbank.org" } as PeerCertificate)).toBeUndefined();
    expect(socketOptions.checkServerIdentity?.("ignored", { subjectaltname: "DNS:unrelated.example" } as PeerCertificate)).toBeInstanceOf(Error);
    expect(http.request).toHaveBeenCalledOnce();
  });

  it("returns redirects as terminal errors without fetching the redirect target", async () => {
    fakeDirectRoute();
    const { open } = fakeTls();
    http.request.mockImplementation((_url, _options, done) => {
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = (() => {
        done(Object.assign(Readable.from([]), {
          statusCode: 302, headers: { location: "https://unrelated.example/" },
        }));
        return outgoing;
      }) as ClientRequest["end"];
      return outgoing;
    });
    await expect(retrieve("gdelt", endpoints.gdelt, createPilotTransport(async () => [ipv4], open)))
      .rejects.toThrow("redirect_denied");
    expect(http.request).toHaveBeenCalledOnce();
  });
});

describe("pilot metadata limits", () => {
  it("accepts only Nigeria population observations, with ten records maximum", () => {
    const row = { countryiso3code: "NGA", indicator: { id: "SP.POP.TOTL" }, date: "2024", value: 1234 };
    const payload = (item: object) => JSON.stringify([{ sourceid: "2" }, [item]]);
    const [lead] = parsePilotLeads("world-bank", payload(row));
    expect(lead.observation).toEqual({ country: "NGA", indicator: "SP.POP.TOTL", year: 2024, value: 1234 });
    expect(parsePilotLeads("world-bank", payload({ ...row, value: null }))).toEqual([]);
    expect(parsePilotLeads("world-bank", JSON.stringify([{}, Array(12).fill(row)]))).toHaveLength(10);
    for (const changed of [{ countryiso3code: "GHA" }, { indicator: { id: "SP.POP.GROW" } }, { value: 1.25 }]) {
      expect(() => parsePilotLeads("world-bank", payload({ ...row, ...changed }))).toThrow();
    }
  });

  it("keeps GDELT observation time out of the revision digest and retains no extra response fields", async () => {
    const row = { title: "Synthetic Lagos flood response", url: "https://news.example/story?utm_source=fixture",
      seendate: "20261119T120000Z", socialimage: "https://news.example/image", body: "Discard this" };
    const [first] = parsePilotLeads("gdelt", JSON.stringify({ articles: [row] }));
    const [later] = parsePilotLeads("gdelt", JSON.stringify({ articles: [{ ...row, seendate: "20261120T120000Z" }] }));
    const a = await normalize(first, "gdelt", { pilot: true });
    const b = await normalize(later, "gdelt", { pilot: true });
    expect(a?.digest).toBe(b?.digest);
    expect(a?.occurredAt).not.toBe(b?.occurredAt);
    expect(a).toMatchObject({ originalUrl: null, canonicalUrl: "https://news.example/story", timeBasis: "observed" });
    expect(a).not.toHaveProperty("body");
    expect(a).not.toHaveProperty("socialimage");
  });
});
