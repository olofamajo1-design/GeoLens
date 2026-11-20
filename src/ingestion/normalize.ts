import type { Adapter, Lead } from "./adapters";

const classifier = [
  { name: "Lagos", country: "NG", match: /\blagos\b/i },
  { name: "Abuja", country: "NG", match: /\babuja\b/i },
  { name: "Nigeria", country: "NG", match: /\bnigeria(?:n)?\b/i },
  { name: "Accra", country: "GH", match: /\baccra\b/i },
  { name: "Ghana", country: "GH", match: /\bghana(?:ian)?\b/i },
  { name: "Kenya", country: "KE", match: /\bkenya(?:n)?\b/i },
];
const entities = [
  { name: "World Bank", match: /\bworld bank\b/i },
  { name: "African Union", match: /\bafrican union\b/i },
  { name: "United Nations", match: /\bunited nations\b/i },
];
const topics = [
  { id: "flood", match: /\bflood(?:s|ing)?\b/i },
  { id: "election", match: /\belection(?:s)?\b/i },
  { id: "power", match: /\b(solar|power grid)\b/i },
];

export function canonicalUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid") url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (part) => part.toString(16).padStart(2, "0")).join("");
}

export async function normalize(lead: Lead, adapter: Adapter) {
  const title = lead.title.replace(/<[^>]*>/g, " ").replace(/[<>\p{Cc}\p{Cf}]/gu, "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!title) return null;
  const url = canonicalUrl(lead.url);
  const originalUrl = url && lead.url?.length && lead.url.length <= 2048 ? lead.url : null;
  const id = lead.id?.trim().slice(0, 400) || url;
  if (!id) return null;
  const timestamp = lead.occurredAt ? Date.parse(lead.occurredAt) : NaN;
  const occurredAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  const location = classifier.find((item) => item.match.test(title));
  const topic = topics.find((item) => item.match.test(title));
  const originLine = [lead.origin ?? "", title].join(" ");
  const origin = adapter === "world-bank" ? "world-bank"
    : /(?:^|\()Reuters(?:\)|\s[-—:]|$)/i.test(originLine) ? "reuters"
    : /(?:^|\()(?:Associated Press|AP)(?:\)|\s[-—:]|$)/i.test(originLine) ? "associated-press"
    : null;
  const fingerprint = await hash(title.toLowerCase().replace(/\b(reuters|associated press|ap)\b/gi, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  const entityNames = entities.filter((item) => item.match.test(title)).map(({ name }) => name);
  return {
    externalReference: id, originalUrl, canonicalUrl: url, title, occurredAt, timeBasis: occurredAt ? (adapter === "gdelt" ? "observed" : "published") : null, language: lead.language?.slice(0, 40) || null,
    digest: await hash(JSON.stringify({ title, url, occurredAt, origin, language: lead.language?.slice(0, 40) || null })),
    fingerprint, origin, location: location ? { name: location.name, country: location.country } : null,
    entities: entityNames,
    // Only narrowly classified same-day leads group automatically. Incomplete leads stay separate.
    cluster: location && topic && occurredAt ? `${location.country}:${location.name}:${topic.id}:${occurredAt.slice(0, 10)}` : null,
  };
}

export type Document = NonNullable<Awaited<ReturnType<typeof normalize>>>;

export function ranking(values: { impact: number; evidence: number; urgency: number; regional: number; historical: number }) {
  if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new Error("invalid_ranking_input");
  }
  return (values.impact * 30 + values.evidence * 25 + values.urgency * 20 + values.regional * 15 + values.historical * 10) / 100;
}
