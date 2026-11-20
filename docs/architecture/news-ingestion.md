# News discovery pilot

Milestone 4 keeps discovery private. It writes source metadata, candidate events, and ranking snapshots. The reader, factual verification, and human publication gate retain their existing permissions.

## Permission review and restricted egress

The live pilot is limited to GDELT and the approved World Bank indicator. Both endpoints remain disabled by default. An active acquisition licence and a time-limited grant for a dedicated ingestion operator are required. Premium Times remains disabled and cannot be selected by the pilot runner.

| Source | Restricted runtime destination | Authorized data shape |
|---|---|---|
| GDELT DOC | `api.gdeltproject.org`, HTTPS port 443, `/api/v2/doc/doc` | Headline, linked article URL, language, and GDELT observation timestamp only. Credit The GDELT Project (DOC 2.0 API) and preserve the linked publisher URL as inert metadata. GDELT does not grant this pilot access to publisher articles. |
| World Bank Indicators | `api.worldbank.org`, HTTPS port 443, `/v2/country/NGA/indicator/SP.POP.TOTL` | Nigeria, indicator `SP.POP.TOTL`, observation year, and integer population count. Attribute World Bank, World Development Indicators: Population, total (SP.POP.TOTL), Nigeria. |

Review the [GDELT licensing reference](https://gdeltproject.org/about.html), [World Bank dataset terms](https://www.worldbank.org/ext/en/legal/terms-conditions/datasets), and [approved indicator](https://data.worldbank.org/indicator/SP.POP.TOTL?locations=NG). Verify any source-specific exceptions, terms of attribution and retention, and rate limits before creating the local acquisition licence. The cloud proxy blocked these references, so the terms remain unread in this session. The pilot stages metadata only and applies the earlier of the thirty-day per-record limit and the licence-specific retention deadline.

### Set the exact domain grants

1. In the Codex task, open **Environment settings → Internet access** and keep **Restricted** selected.
2. In **Allowed domains**, add `api.gdeltproject.org` and `api.worldbank.org`, one per entry. Preserve existing presets. Use exact domain names with no scheme, path, port, IP address, or wildcard.
3. Save and apply the settings to the running task, or reconnect to the updated environment if the settings require it. Verify that the two names appear in the enforced rules. Leave provider documentation, linked publishers and Premium Times outside the runtime allowlist.
4. Check the connection path. A hostname-only HTTPS proxy can allow a CONNECT request and still hide the actual provider IP. The pilot CLI requires a supported restricted route where it can pin the resolved public address, inspect the connected peer and validate the provider TLS certificate. If the environment only offers hostname-only CONNECT, use an authorized runner with a restrictive direct egress policy and observable peers, or obtain a platform-supported route that can enforce and report those destination guarantees. Preserve the configured proxy and certificate settings.

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

The Wrangler default disables dispatch. Fixture dispatch uses `*/15 * * * *` UTC, a deterministic Workflow ID per window, and a dedicated ingestion account on the local API. The Worker opens the loopback PostgREST store only in fixture mode. The separate Node pilot also uses the local store with its own time-limited grant. Each due source is checked for an enabled endpoint and a current acquisition licence. SQL validates the licence again under a lock at commit time. An overlapping or retried cycle shares one lease, and terminal run results are immutable to the fixture caller. The pilot takes up to ten records per source per cycle with no pagination. Unknown or unlicensed fields are rejected from the normalized contract.

The local pilot runner validates A and AAAA answers as public destinations, pins one approved address, connects with TLS SNI for the exact host, and checks the TLS peer and port before sending HTTP. It rejects special-use addresses, mixed public/private answers, redirects, and oversized or unexpected response bodies. It sends one credential-free request per source per cycle. Conditional retrieval and provider backoff are available in the shared adapter, and the pilot consumes its reservation even when transport fails. The fixture Worker has no external transport binding. The provider response is parsed as data and filtered to the licensed metadata fields.

## Activate and run the local pilot

Complete the terms and network checks before activating a source. Use a disposable local Supabase project. Give the dedicated local Auth account the existing `ingestion_operator` role through the normal administrator process. For each verified source, run the following against that project's local Postgres with reviewed expiry dates. The authorization script locks the registered endpoint and applies an audited licence.

```sh
docker exec -i supabase_db_geolens-security psql -X -U postgres \
  -v source_adapter=world-bank -v operator_id=AUTH_USER_UUID \
  -v licensed_until=REVIEWED_VALID_UNTIL_UTC -v retention_until=REVIEWED_RETENTION_DEADLINE_UTC \
  < scripts/discovery-pilot-authorize.sql
```

Set `GEOLENS_PILOT_ANON_KEY` to the local project's public key and `GEOLENS_PILOT_OPERATOR_JWT` to that account's current access token in the runner's private environment. Keep the credentials out of the shell command, repository, and logs. Run `npm run ingestion:pilot -- world-bank` for one source or `npm run ingestion:pilot` for both. The command reports counts and bounded status codes. A repeated invocation in the same window performs no second GET. Use a later permitted window to verify deduplication against unchanged provider records. The local role cannot release news.

Pilot documents expire at the earlier of 720 hours from insertion or the source licence's retention deadline. The local database schedules cleanup every minute and the pilot also checks expiry before inserting. Revocation makes affected data eligible for cleanup. Cleanup removes the document and provenance, refreshes or removes any affected candidate events, and clears dependent rank snapshots. Database triggers keep pilot documents and events out of permanent editorial and research references. Technical run counters and timestamps remain available without the removed source metadata. A stopped database resumes cleanup when it runs again.

## Provenance, ranking and costs

Documents keep a source-specific reference, SHA-256 version digest, credited origin where recognized, exact acquisition licence and attribution. GDELT observation time and feed publication time are distinct provenance fields. They do not establish an event's occurrence time. Canonical metadata and repeat requests can collapse exact duplicates without discarding legitimately revised documents. The initial event grouping uses date, classified location and topic. Unclassified leads fall back to an exact headline fingerprint. The limited classifier and resulting clusters require editorial review before use.

The evidence score groups recognized origins connected by duplicate fingerprints. Unknown origin contributes no independent corroboration. A credited origin is an input to triage, with no independent verification of authorship. Ranking stores the five component scores and rule version. Impact and historical significance use provisional headline cues, urgency uses provider timestamps, and regional relevance prioritizes Nigeria. The total uses the approved 30/25/20/15/10 weights. Without a recognized origin the event remains in review with no total score. Breaking, trending and developing are prioritization labels for discovery.

The private health query exposes cadence, consecutive failures, latest error and last success. The monthly budget query reports recorded USD minor units, claimed discovery cycles, applicable alerts, and whether the ceiling was reached. The dedicated ingestion role cannot change cost observations. An MFA-enabled super administrator can reconcile absolute month-to-date spend. Development alerts are $35 and $45 and the $50 ceiling stops new fixture cycles. Launch alerts are $210, $250 and $270 with a blocked status at $300. No current path authorizes provider charges. Hosted usage reconciliation, alert delivery, and the enforcement hook for future launch spending remain part of live activation.

## Live pilot recheck — 20 November 2026

The connected runtime reported current and enforced restricted networking at revision 35, with neither provider hostname in its custom allowlist. The configuration draft for this chat also listed no custom rules. Read-only probes to both API endpoints returned HTTP 403 from the CONNECT proxy, before an origin HTTP response. The GDELT licensing page, World Bank dataset terms, and approved indicator page were also blocked, so source permissions could not be verified in this runtime.

| Source | Live records retrieved | Live rows inserted | Live deduplication and attribution |
|---|---:|---:|---|
| GDELT | 0 | 0 | Not exercised |
| World Bank `SP.POP.TOTL`, Nigeria | 0 | 0 | Not exercised |

The pilot command exited 1 with `proxy_peer_unverifiable` for each provider before issuing a GET. Supabase showed no new pilot runs or documents. The five pre-existing run rows came from synthetic tests. All live endpoints were disabled, including Premium Times. No paid API calls or publications occurred.

Apply the two exact grants to the environment attached to this task and verify the enforced rules. Origin reachability alone does not verify the connected provider IP through hostname-only CONNECT. Live ingestion requires a supported restricted route that satisfies the peer checks and access to verify the applicable source terms.
