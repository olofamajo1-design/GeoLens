import { SaxesParser } from "saxes";

export type Adapter = "gdelt" | "rss" | "world-bank";
export type Lead = { id?: string; url?: string; title: string; occurredAt?: string; origin?: string; language?: string };
const maxRecords = 10;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_provider_response");
  return value as Record<string, unknown>;
}
function string(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function rss(xml: string): Lead[] {
  const parser = new SaxesParser({ xmlns: false });
  const leads: Lead[] = [];
  const fields = new Map<string, string>();
  let itemDepth = 0;
  let depth = 0;
  let field: string | undefined;
  parser.on("doctype", () => { throw new Error("unsafe_xml"); });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth > 32) throw new Error("unsafe_xml");
    if (tag.name === "item" && !itemDepth) { itemDepth = depth; fields.clear(); }
    if (itemDepth && depth === itemDepth + 1) field = tag.name;
  });
  function append(value: string) {
    if (field && ["title", "link", "guid", "pubDate", "source"].includes(field)) {
      fields.set(field, ((fields.get(field) ?? "") + value).slice(0, 2048));
    }
  }
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => {
    if (itemDepth && depth === itemDepth + 1) field = undefined;
    if (depth === itemDepth) {
      const title = fields.get("title")?.trim();
      if (title && leads.length < maxRecords) leads.push({
        title, id: fields.get("guid")?.trim(), url: fields.get("link")?.trim(),
        occurredAt: fields.get("pubDate"), origin: fields.get("source"),
      });
      itemDepth = 0;
    }
    depth--;
  });
  parser.on("error", () => { throw new Error("invalid_xml"); });
  parser.write(xml).close();
  return leads;
}

export function parseLeads(adapter: Adapter, body: string): Lead[] {
  if (adapter === "rss") return rss(body);
  const parsed: unknown = JSON.parse(body);
  if (adapter === "gdelt") {
    const entries = object(parsed).articles;
    if (!Array.isArray(entries)) throw new Error("invalid_provider_response");
    return entries.slice(0, maxRecords).flatMap((entry) => {
      const row = object(entry);
      const title = string(row.title);
      const seen = string(row.seendate)?.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
      return title ? [{ title, url: string(row.url), language: string(row.language),
        occurredAt: seen ? `${seen[1]}-${seen[2]}-${seen[3]}T${seen[4]}:${seen[5]}:${seen[6]}Z` : undefined }] : [];
    });
  }
  if (Array.isArray(parsed) && parsed.length === 2 && parsed[1] === null) return [];
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) throw new Error("invalid_provider_response");
  return parsed[1].slice(0, maxRecords).flatMap((entry) => {
    const row = object(entry);
    const country = string(object(row.country).value);
    const indicator = object(row.indicator);
    const label = string(indicator.value);
    const year = string(row.date);
    const code = string(row.countryiso3code);
    const indicatorId = string(indicator.id);
    if (!country || !label || !year || !code || !indicatorId || typeof row.value !== "number") return [];
    return [{ id: [code, indicatorId, year].join(":"), title: `${country} — ${label}: ${row.value} (${year})`, origin: "world-bank" }];
  });
}
