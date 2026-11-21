# Stage 5C private fixture editions

Stage 5C starts with an existing Stage 5B run in `research_ready`. A scoped newsroom operator calls `queue_newsroom_edition` with the run ID and the generated prompt manifest. The queue accepts one edition run per research handoff. Set the local Worker to `NEWSROOM_MODE=editorial-fixture` to claim queued editions. The committed Worker configuration defaults to `disabled`.

```mermaid
flowchart LR
  Research[Accepted research] --> Write[006 Writing]
  Research --> Visual[007 Visual intelligence]
  Write --> Seal[Immutable edition]
  Visual --> Seal
  Seal --> Verify[004 Exact-version verification]
  Verify --> Editor[008 Editorial assessment]
  Editor --> Human[Private human review]
  Editor --> Revision[Assigned revision]
  Revision --> Seal
```

## Drafts and assets

GL-AGENT-006 builds the Quick Brief and Deep Dive for the same story and source register. An operator can select one additional format from Historical Explainer, Geopolitical Analysis, Investigative Report, Special Feature and FactCheck Report. Ordered article sections carry the story and research identifiers, three headline options, a standfirst, the measured word count, and labelled paragraphs with claim and evidence references. The writer uses accepted Stage 5B research material and original editorial context. The source and evidence registers resolve each reference to the original attribution and locator.

The 150–300 and 900–1,500 word ranges guide the writing factor in the review. A proposed factual addition is recorded outside the draft body and sent to GL-AGENT-004. Unresolved proposals hold the edition pending eligible evidence. Structured validation checks the source-bound paragraphs, headlines and standfirst before accepting the draft.

GL-AGENT-007 assembles maps, charts, timelines, infographics, relationship diagrams, licensed photo references, and disclosed mock AI illustration references. Each record carries a version, digest, evidence, source IDs, provenance, rights status, caption, alternative text and uncertainty. The Worker emits GeoJSON point records for MapLibre with Stadia tiles disabled, zero-based statistical chart specifications, and responsive layout metadata using the reader’s `--ink` and `--accent` design tokens. The payload provides text and data for accessible rendering. Fixture media objects live in the existing private storage bucket.

Visual records come from a curated synthetic catalogue with evidence references. Chart values and units are checked against verified numeric claims, and timeline ranges and certainty are checked against accepted history. Missing or revoked rights block the asset. Version checks and rights checks cover the exact media object, caption, alternative text and referenced source records.

## Review and authority

The database seals both accepted outputs and their references into an immutable edition with a SHA-256 digest. GL-AGENT-004 and GL-AGENT-008 use that exact edition. Reviews preserve the digest, decision, score, findings, and instructions. The AI Editor-in-Chief applies the approved eight weights and the 85-point threshold. Critical grounding, rights, source independence, security or privacy failures block handoff regardless of the score.

A revision names the responsible writing or visual agent and retires the prior edition as the current version. The existing workflow enforces two automated revisions per affected stage and orders fresh verification and review against the next digest. The historical versions and assessments remain available to authorized users.

The `newsroom_edition` RPC is scoped to operators and MFA-authenticated human editors. Its `readyForHumanReview` field rechecks current rights. Stage 5C ends at private `human_review` or escalation. The existing public editorial path retains exact-version human approval and human publisher authority. [Editorial security migration](../../supabase/migrations/20261120000300_editorial_security.sql)

## Database and local verification

- The edition model adds immutable products, versions, reviews, and fixture visual records with row-level access controls. [Model migration](../../supabase/migrations/20261120001000_newsroom_editions.sql)
- The workflow migration adds the scoped queue and read RPCs, reuses the existing leases and revision limits, and checks source and media rights when results settle. [Workflow migration](../../supabase/migrations/20261120001100_newsroom_edition_workflow.sql)

The local regression uses curated fixture geometry, structured visual records, private placeholder media, and in-process mock responses. It reserves simulated usage under the existing development budget. Each editorial attempt is capped at 28,672 input tokens and 8,192 output tokens. Recorded provider spend is zero. Editorial browsing, actual image generation and hosted tile rendering require separate implementation and review.

Start the disposable Supabase stack using the local development instructions, then run the checks below. The editorial integration and Workerd tests build an accepted research handoff with the existing fixture utilities. [Local development](../operations/development.md)

```sh
supabase db reset --local
npm run check
npm run test:database
npm run test:workflow
npm run test:browser
npm run ingestion:dry-run
```
