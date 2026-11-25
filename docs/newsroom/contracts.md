# Newsroom contracts and editorial policy

The registry in `src/newsroom/registry.ts` defines the eight approved IDs and names. Add versioned production prompts under `prompts/newsroom/` when the approved prompts and handoffs arrive.

The foundation Draft 2020-12 task and result schemas share the schema version, story ID, task ID, agent ID, and attempt. Results include a synthetic flag, a summary, and evidence references. The adapter boundary validates both directions and checks the result against the task identity and attempt.

[Stage 5B](../architecture/newsroom-stage-5b.md) defines the role-specific research contracts for discovery, history, verification and analysis, with private durable source and evidence links.

[Stage 5C](../architecture/newsroom-stage-5c.md) adds writing, visual intelligence, exact-version reverification and AI editorial assessment contracts for private fixture editions.

## Editorial authority

The founder is the initial Human Editor-in-Chief and super administrator. Public content requires factual verification, AI editorial review, and authenticated human approval of the exact article and media versions. Material revisions invalidate prior approval. Preserve evidence, citations, corrections, and audit history. AI agents cannot authorize publication.

Private Ask GeoLens and FactCheck responses are exempt from individual human approval and must never be automatically published. The preview has no publication endpoint or approval system.

## Requirements for orchestration and sources

The launch target is five fully researched stories daily with rolling publication. The fixture Orchestrator caps active tasks at three per story, technical attempts at three, and automated revisions at two per supported editorial stage. Retry eligibility follows 5- and 30-second delays. Standard work has a 180-second timeout, and historical research and visual work have a 300-second timeout.

Prioritize Nigerian and African coverage as part of global reporting. Verify permissions before integrating each source from GDELT, publisher feeds, primary institutional records, or historical archives.
