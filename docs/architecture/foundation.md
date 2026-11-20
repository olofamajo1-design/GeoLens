# Foundation architecture

The app is one React Router v8 package running server-side on a Cloudflare Worker through the Cloudflare Vite plugin. The Worker delegates HTTP requests to React Router. The root route runs a synthetic provider task and returns the validated result for display. The health route provides a credential-free runtime check.

- `app/` contains routes, rendering, and styles.
- `workers/` contains the Worker entry point. Future Cron and Workflow entry points belong here, with workflow definitions in `workers/workflows/`.
- `src/newsroom/` owns the role registry, typed task/result envelopes, and adapter validation boundary.
- `src/schemas/` contains versioned Draft 2020-12 schemas. Ajv generates validators at build time so the Worker can validate messages without compiling schemas at runtime.
- `src/providers/` contains server-side provider adapters. The initial adapter uses only fixtures.
- `tests/` contains contract tests and a built Worker HTTP smoke test.

Supabase PostgreSQL, Auth, and private Storage integration follow the database specification handoff. Put SQL in `supabase/migrations/` when that task begins. Provider SDKs and credentials are added when their integration is implemented. OpenAI, Paystack sandbox, Resend, MapLibre with Stadia Maps, and external source ingestion remain future work. Live providers and hosted infrastructure require their own compatibility tests.
