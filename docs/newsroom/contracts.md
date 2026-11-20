# Newsroom contracts and editorial policy

The registry in `src/newsroom/registry.ts` defines the eight approved IDs and names. Add versioned production prompts under `prompts/newsroom/` when the approved prompts and handoffs arrive.

The Draft 2020-12 task and result schemas share the schema version, story ID, task ID, agent ID, and attempt. Results include a synthetic flag, a summary, and evidence references. The adapter boundary validates both directions and rejects a result whose task identity or attempt does not match. These are foundation envelopes. Role-specific payloads and durable evidence records follow the detailed specifications.

## Editorial authority

The founder is the initial Human Editor-in-Chief and super administrator. Public content requires factual verification, AI editorial review, and authenticated human approval of the exact article and media versions. Material revisions invalidate prior approval. Preserve evidence, citations, corrections, and audit history. AI agents cannot authorize publication.

Private Ask GeoLens and FactCheck responses are exempt from individual human approval and must never be automatically published. The preview has no publication endpoint or approval system.

## Requirements for orchestration and sources

The launch target is five fully researched stories daily with rolling publication. Orchestration must cap active tasks at three per story, technical attempts at three, and automated revisions at two per editorial stage. Retry after 5 and 30 seconds, respecting provider limits. Use a 180-second standard timeout and a 300-second research and visual timeout. The foundation validates the attempt number in message envelopes. Scheduling, concurrency, timeouts, retries, and editorial revision limits still need runtime enforcement.

Prioritize Nigerian and African coverage as part of global reporting. Verify permissions before integrating each source from GDELT, publisher feeds, primary institutional records, or historical archives.
