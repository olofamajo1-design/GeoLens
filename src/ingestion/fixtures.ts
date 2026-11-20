import type { Adapter } from "./adapters";

// Synthetic fixtures contain metadata only. The Worker cannot select a live transport in this milestone.
export const fixturePayloads: Record<Adapter, string> = {
  gdelt: JSON.stringify({ articles: [
    { title: "Synthetic Lagos flood response announced (Reuters)", url: "https://news.example/lagos?utm_source=fixture", language: "English", seendate: "20261119T120000Z" },
    { title: "Synthetic Lagos flood response announced (Reuters)", url: "https://mirror.example/lagos", language: "English", seendate: "20261119T120000Z" },
  ] }),
  rss: `<rss version="2.0"><channel><title>Synthetic Nigerian feed</title><item>
    <guid>fixture-ng-001</guid><title>Synthetic Lagos flood response expands (Associated Press)</title>
    <link>https://publisher.example/response</link><pubDate>Thu, 19 Nov 2026 12:00:00 GMT</pubDate>
    </item></channel></rss>`,
  "world-bank": JSON.stringify([{ page: 1 }, [{ country: { value: "Nigeria" },
    indicator: { id: "SP.POP.TOTL", value: "Synthetic population" }, countryiso3code: "NGA", date: "2025", value: 100 }]]),
};
