import type { Adapter } from "./adapters";

export const endpoints = {
  gdelt: "https://api.gdeltproject.org/api/v2/doc/doc?query=%28Nigeria%20OR%20Africa%29&mode=artlist&format=json&maxrecords=10",
  "world-bank": "https://api.worldbank.org/v2/country/NGA/indicator/SP.POP.TOTL?format=json&per_page=10&mrv=10",
  rss: null,
} satisfies Record<Adapter, string | null>;

export const maxBodyBytes = 512 * 1024;

export type Retrieval = (url: URL, options: RequestInit) => Promise<Response>;

export class RetrievalFailure extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number;

  constructor(code: string, retryAfterSeconds = 0) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// The transport is an injected restricted gateway. There is no direct Worker fetch fallback.
// The gateway must prevent connections to non-public IPs and enforce its own destination policy.
export async function retrieve(adapter: Adapter, address: string, transport: Retrieval, etag?: string) {
  const target = endpoints[adapter];
  if (!target || address !== target) throw new RetrievalFailure("destination_denied");
  const url = new URL(address);
  const headers = new Headers({ accept: "application/json" });
  if (etag) headers.set("if-none-match", etag);
  const signal = AbortSignal.timeout(10_000);
  const response = await transport(url, { headers, redirect: "manual", signal });
  if (response.status === 304) return { body: null, etag };
  if (response.status === 429 || response.status === 503) {
    const value = response.headers.get("retry-after") ?? "";
    const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    throw new RetrievalFailure(response.status === 429 ? "rate_limited" : "upstream_unavailable",
      Number.isFinite(seconds) ? Math.min(2_147_483_647, Math.max(0, seconds)) : 0);
  }
  if (response.status >= 300 && response.status < 400) throw new RetrievalFailure("redirect_denied");
  if (!response.ok) throw new RetrievalFailure("upstream_error");
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new RetrievalFailure("unexpected_content_type");
  }
  if (Number(response.headers.get("content-length")) > maxBodyBytes) throw new RetrievalFailure("body_too_large");
  const stream = response.body?.getReader();
  if (!stream) throw new RetrievalFailure("empty_body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await stream.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw new RetrievalFailure("body_too_large");
      body += decoder.decode(value, { stream: true });
    }
    return { body: body + decoder.decode(), etag: response.headers.get("etag") ?? undefined };
  } finally {
    await stream.cancel().catch(() => {});
  }
}
