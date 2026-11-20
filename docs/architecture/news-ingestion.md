# News discovery pilot

Milestone 4 keeps discovery private. It writes source metadata, candidate events, and ranking snapshots. The reader, factual verification, and human publication gate retain their existing permissions.

## Permission review and restricted egress

The three pilot candidates are registered disabled. No acquisition licence has been granted to a live endpoint. The implementation has a fixture-only persistence gate and a fixture-only Worker mode. Live activation requires a separately reviewed change and authorization.

| Candidate | Proposed runtime hostname and path | Permission status and permitted pilot shape |
|---|---|---|
| GDELT DOC API | `api.gdeltproject.org`, `/api/v2/doc/doc` | Pending confirmation of API access, limits, attribution, and retention. Propose discovery metadata only. The API response does not grant rights to linked publisher material. Never fetch those article URLs as part of this pilot. |
| World Bank Indicators API | `api.worldbank.org`, `/v2/country/NGA/indicator/SP.POP.TOTL` | Pending confirmation of the selected indicator's dataset terms, attribution, and retention. Check metadata for exceptions and third-party rights. Propose country, indicator, year, and numeric observation only. |
| Premium Times | Candidate hostname `www.premiumtimesng.com`. Exact authorized endpoint is still required. | No confirmed publisher permission. An RSS feed's existence or accessibility does not establish storage or reuse rights. Confirm authorized fields, attribution, polling limits, retention, and syndication before adding it to the runtime allowlist. |

The cloud proxy denied access to the provider terms and documentation during the review. No provider was contacted for live ingestion. Start the restricted pilot with the exact API host and path for each source whose terms are approved. Keep Premium Times closed until its endpoint permission is documented. Documentation hosts only serve review needs and are not runtime destinations.

Official references for the review:

- [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation)
- [World Bank dataset terms](https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets)
- [Premium Times](https://www.premiumtimesng.com/)

Before activation, record the exact endpoint and operator, terms reference, agreed fields, attribution text, rate limit, licence validity and revocation, and retention deadline. Confirm purge and down-stream citation handling for that licence before storing live data. This version records the retention deadline and excludes expired or revoked lineage from new scores. It does not perform automatic retention deletion.

## Local operation

Use the disposable local Supabase instance and run its migrations before integration tests.

```sh
npm ci
npm run ingestion:dry-run
npm run check
npm run test:browser
npm run test:database
npm run test:workflow
```

The manual dry-run prints normalized synthetic leads without writes. The Workflow test exercises the built Worker, a local Cron dispatch and the database with a separate synthetic authenticated ingestion identity. Use the pinned local Supabase CLI from the database security guide. The Workflow test accepts `GEOLENS_SUPABASE_CLI` and the browser suite accepts `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

The Wrangler default disables dispatch. Fixture dispatch uses `*/15 * * * *` UTC, a deterministic Workflow ID per window, and a dedicated ingestion account on the local API. Only fixture mode can use the loopback PostgREST store. Each due source is checked for an enabled endpoint and a current acquisition licence. SQL validates the licence again under a lock at commit time. An overlapping or retried cycle shares one lease, and terminal run results are immutable to the fixture caller. The pilot takes up to ten records per source per cycle with no pagination. Unknown or unlicensed fields are rejected from the normalized contract.

The separate guarded retrieval adapter supports conditional requests, bounded streaming responses, timeouts, and provider backoff. It refuses unregistered URLs and redirects. Before wiring it into a live runtime, validate the restricted gateway's DNS and connection-time public-IP enforcement. The fixture Worker has no external transport binding. RSS parsing rejects DTDs and retains selected metadata only. Provider content never becomes an instruction, executable markup, model request or follow-up URL.

## Provenance, ranking and costs

Documents keep a source-specific reference, SHA-256 version digest, credited origin where recognized, exact acquisition licence and attribution. GDELT observation time and feed publication time are distinct provenance fields. They do not establish an event's occurrence time. Canonical metadata and repeat requests can collapse exact duplicates without discarding legitimately revised documents. The initial event grouping uses date, classified location and topic. Unclassified leads fall back to an exact headline fingerprint. The limited classifier and resulting clusters require editorial review before use.

The evidence score groups recognized origins connected by duplicate fingerprints. Unknown origin contributes no independent corroboration. A credited origin is an input to triage, with no independent verification of authorship. Ranking stores the five component scores and rule version. Impact and historical significance use provisional headline cues, urgency uses provider timestamps, and regional relevance prioritizes Nigeria. The total uses the approved 30/25/20/15/10 weights. Without a recognized origin the event remains in review with no total score. Breaking, trending and developing are prioritization labels for discovery.

The private health query exposes cadence, consecutive failures, latest error and last success. The monthly budget query reports recorded USD minor units, claimed discovery cycles, applicable alerts, and whether the ceiling was reached. The dedicated ingestion role cannot change cost observations. An MFA-enabled super administrator can reconcile absolute month-to-date spend. Development alerts are $35 and $45 and the $50 ceiling stops new fixture cycles. Launch alerts are $210, $250 and $270 with a blocked status at $300. No current path authorizes provider charges. Hosted usage reconciliation, alert delivery, and the enforcement hook for future launch spending remain part of live activation.
