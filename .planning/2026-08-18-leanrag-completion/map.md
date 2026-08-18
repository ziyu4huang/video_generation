---
effort: 2026-08-18-leanrag-completion
status: active
created: 2026-08-18
pipeline: wayfind→superpowers
---

# Map — leanrag-completion

## Destination
Close the four half-wired seams the LeanRAG selective port (①–⑥, per
`bun-apps/pi-agent-ext-hermes-memory/docs/LEANRAG-PROVENANCE.md`) left behind as
deferred-integration notes in the 2026-08-08-knowledge-pipeline build log:
entity-summary-augmented embed text wired into production backfill, a hang-mode
circuit breaker in the hierarchy cluster loop, merge-on-write persistence for
the entity-summary cache, and `kgLlmModel` carried through `loadConfig`.
Wiring-only — no new concepts ported, no behavior change outside these seams.

## Decisions
- **D1 — Scope = wiring-only completion of the LeanRAG port (the 4 items
  below).** Perf polish, UI surface, LOC simplify round 2, and fog items (CLIP
  image vectors, multi-panel split, Tier-3 drift) are all OUT. Rationale: user
  decision at the 2026-08-18 grilling — all circled concepts ①–⑥ are
  dispositioned and their efforts closed green (2026-08-16-hermes-leanrag-simplify,
  2026-08-16-leanrag-hierarchy-port, 2026-08-17-knowledge-pipeline-polish);
  what remains is integration debt, not feature work.
- **D2 — `augmentEmbedText`: WIRE (not delete) at hermes backfill.** It is
  implemented and tested with zero production callers, and its stated blocker
  ("③/20 integration") already shipped (ticket 20 EXECUTE note). Deleting a
  shipped ⑥ primitive to dodge wiring would regress the selective port.
- **D3 — Re-embed invalidation: bump the `modelVersion` lineage tag** (hermes
  `src/constants.ts:90`, `DEFAULT_EMBED_MODEL_VERSION`). The existing
  delta-keyed machinery (`src/handlers/vector-backfill.ts:200`; SurrealDB
  record id `${mdId}__${modelVersion}` at `src/store/surreal/vector-store.ts:92`)
  already handles a full backfill when the tag changes — no bespoke migration.
- **D4 — Hang-mode circuit breaker: after K consecutive empty summarizeFn
  results, break the layer loop** (cluster loop at zk `src/hierarchy.ts:215`).
  K default 3; the knob lives next to `HIERARCHY_DEFAULTS` in
  `pi-agent-ext-knowledge-card/src/zk-task-config.ts:119`. Today empty
  summaries loop forever up to maxDepth, burning a full hierarchy build when
  the LLM wedges.
- **D5 — `kgLlmModel` precedence: IngestOptions > config file (loadConfig) >
  env `PI_KG_LLM_MODEL`.** Update `bun-apps/tests/config-parity.test.ts`
  (~line 57) which currently notes the deferral on the parse-allowlist entry.
- **D6 — Entity-summary cache merge-on-write** inside `saveEntitySummaries`
  (`pi-agent-ext-knowledge-card/src/entity-summary.ts:121`) via load +
  spread-merge using the existing `loadEntitySummaries`. The current wholesale
  overwrite (PRUNE-ON-REBUILD posture, noted when no consumer existed) discards
  previously condensed summaries on partial re-runs.

## Not yet specified
- (none — spec locked)

## Tickets
- (to be chartered from spec.md — one wiring seam per ticket)

## Build log
- 2026-08-18 — effort created from grilling; recon folded in (see recon/); spec locked.
- 2026-08-18 — tickets 03→01→02/04 cut (01 blocks on 03; 02/04 independent). Execution next (SDD).
- 2026-08-18 — 03 merged (entity-summary cache merge-on-write).
