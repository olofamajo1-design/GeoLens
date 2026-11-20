# Milestone 2 database security

GeoLens uses one Supabase PostgreSQL database, Auth and Storage. The versioned migrations create the ten approved namespaces and expose a limited PostgREST API under `geo_api`. The `forecasting` and `billing` namespaces are reserved. Role grants and audit events reference Supabase Auth identities. Profiles and related private data are owned by those identities.

## Editorial lifecycle

The trusted internal SQL ingestion interface seals a story version in one transaction. The format-1 SHA-256 digest covers the JSONB article, claim snapshots, ordered citations and ordered media manifest. Each media entry binds the asset version, content digest, Storage version and licence. Trusted ingestion must calculate the content digest from the uploaded bytes and register the matching immutable Storage version. Moving, copying, replacing, or removing a bound object through application roles is unauthorized.

Verification and AI editorial review are separately scoped and bind to a stored agent attempt for the same sealed version. The attempt's synthetic provenance must match the story. The human decision binds to the two current successful review IDs. An invalidation or superseding outcome makes prior decisions ineligible for a new release. Approval and release use distinct role grants and require an Auth AAL2 session. Editing public content, citations or media requires a new version with new reviews and a new human approval.

Release uses a story lock, current rights checks, an idempotency key and a unique active-publication constraint. A replacement requires a correction notice and retains the previous publication and audit trail. Withdrawal and rights revocation take effect on fresh requests. This implementation hides the entire public projection when any bound right expires or is revoked, or if a bound Storage object no longer matches. Historical records are retained for human review and correction. Use private, non-cacheable delivery for licensed objects, and remember that bytes already downloaded cannot be recalled.

## Access surface

- Guest requests can read the safe publication projection and download the exact media objects currently eligible for public release using the anonymous application JWT at the authenticated Storage GET endpoint. Direct table access, object listing and signed bearer links are unavailable for editorial media.
- Signed-in users can manage allowed profile fields and access their own Ask sessions, FactCheck requests and registered attachments. The private buckets are gated by database bindings and Storage operation. The founder and agent roles gain no access to another user's private records.
- Separate test Auth identities own the two automation roles. Their API grants permit the applicable review only. Role updates and human approvals, publications and withdrawals require distinct human grants and current MFA.
- Editorial and governance tables use RLS with no direct application writes. The security-definer API uses fixed search paths, explicit execute grants and transaction-local audit logging. Trusted migrations and fixture setup still run as a database administrator.

## Local-only validation

Use Docker, Node from `.node-version`, and the official Supabase CLI **2.75.0**. From the repository root:

```sh
npm ci
supabase start -x imgproxy
npm run test:database
npm run check
supabase stop
```

If a workspace blocks the default Supabase image registry and allows Docker Hub, start with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io supabase start -x imgproxy`. The integration runner optionally accepts `GEOLENS_SUPABASE_CLI` as the path to the same pinned CLI. It checks for the configured loopback endpoint and uses the `geolens-security` database container for synthetic fixture setup. The local fixture passwords, OTPs and TOTP values are generated or retrieved at runtime. Keep the local Auth, database, mail and API ports private.

The integration run provisions disposable identities, tests email OTP and TOTP, and exercises PostgREST and Storage with actual guest, member, agent and founder sessions. The concurrency tests confirm that distinct release keys cannot publish two competing approved versions, and that rights revocation either prevents release or blocks subsequent guest access, depending on the transaction order. Use a fresh disposable instance for a full rerun so the test's last-super-admin assertion starts with exactly one bootstrap founder. For this synthetic stack only, `supabase stop --no-backup` discards local test data before the next start. The Milestone 1 preview remains fixture-backed. There is no public upload or sign-in UI, hosted Google integration, production bootstrap, retention automation, account recovery or staff access. The agent persistence tables are ready for a later trusted application adapter. Local tests seed attempts directly and use no agent provider.
