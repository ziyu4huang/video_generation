# Spec — leanrag-completion (2026-08-18)

Status: **LOCKED** (grilling 2026-08-18). Scope: wiring-only completion of the
LeanRAG selective port. Vocabulary and posture follow
`bun-apps/pi-agent-ext-hermes-memory/docs/LEANRAG-PROVENANCE.md` and
`ADR-hermes-memory-0001` (selective port, superseded-in-part 2026-08-16 by the
hierarchy port); dependency direction follows `ADR-monorepo-0001`.

## Problem

The LeanRAG selective port (①–⑥) is dispositioned and its efforts closed
green, but four seams remain half-wired from deferred integration notes in the
2026-08-08-knowledge-pipeline build log:

1. **`augmentEmbedText` has zero production callers.** zk
   `pi-agent-ext-knowledge-card/src/entity-summary.ts:165` is implemented and
   tested, but its own doc comment says "wiring into the embed pipeline is
   deferred to the ③/20 integration" — and that integration already shipped
   (ticket 20 EXECUTE: "LeanRAG selective port ③⑤⑥ COMPLETE"). The ⑥
   entity-description summaries never reach the embed text, so their retrieval
   value is unrealized.
2. **The hierarchy cluster loop has no hang-mode circuit breaker.** zk
   `src/hierarchy.ts:215` consumes `summarizeFn(joined, tokenBudget)` results
   without checking for empty returns — a wedged or silently-failing LLM
   produces empty summaries that loop forever up to `maxDepth`
   (`HIERARCHY_DEFAULTS.maxDepth = 3`), burning a full hierarchy build
   (per-layer LLM calls) for nothing. The 03-Phase2 EXECUTE note recorded this
   as deliberately deferred.
3. **`saveEntitySummaries` overwrites the persisted entity-summary cache
   wholesale** (`pi-agent-ext-knowledge-card/src/entity-summary.ts:121`) instead
   of merge-on-write. The PRUNE-ON-REBUILD comment noted no consumer at write
   time; now that ⑥ is live, a partial re-run discards previously condensed
   summaries, defeating the derived side-cache's purpose.
4. **`kgLlmModel` is parseable only from IngestOptions/env**, deliberately
   excluded from `loadConfig` — `bun-apps/tests/config-parity.test.ts` (~line
   57) carries the deferral note on the parse-allowlist entry. Every peer knob
   rides `DEFAULT_CONFIG` + the parse allowlist (#06 config-gap lesson); this
   one requires env surgery per repo.

## Solution

Four wiring tickets across hermes-memory / knowledge-card / core-interface,
per the fact base:

- **Wire `augmentEmbedText` into hermes `cardEmbedText`**
  (`src/handlers/vector-backfill.ts:98`) with per-card entity summaries from
  the zk entity-summary primitives, plus a `modelVersion` lineage bump (D3) so
  the existing delta-keyed backfill re-embeds the corpus once, through the same
  machinery as any model swap.
- **Add a K-consecutive-empty circuit breaker** in the zk hierarchy cluster
  loop (`src/hierarchy.ts:215`) with the knob beside `HIERARCHY_DEFAULTS`
  (`src/zk-task-config.ts:119`), K default 3 (D4).
- **Merge-on-write in `saveEntitySummaries`** via `loadEntitySummaries` +
  spread-merge (D6).
- **Carry `kgLlmModel` through `loadConfig`** with opts > config > env
  precedence and update the parity test (D5).

## User Stories

- **Retrieval quality** — as a `knowledge_search` user, entity-summary-augmented
  vectors surface cards whose *meaning* matches my query via ⑥ entity
  descriptions even when literal keywords differ, compounding with the shipped
  ③ frequency-vote ranking (final formula untouched).
- **Robustness** — as an operator running a hierarchy build against a wedged
  LLM, the build breaks after K consecutive empty summarizeFn results instead
  of burning a full hierarchy build up to maxDepth.
- **Durability** — the entity-summary cache survives across runs
  incrementally: regenerating a subset of summaries no longer discards the
  previously condensed ones.
- **Operability** — `kgLlmModel` is settable via the config file like its
  peers, with an explicit, documented precedence (IngestOptions > config file >
  env `PI_KG_LLM_MODEL`).

## Implementation Decisions

D2–D6 as locked in map.md (anchors restated):

- **D2**: wire `augmentEmbedText` (zk `src/entity-summary.ts:165`) into hermes
  `cardEmbedText` (`src/handlers/vector-backfill.ts:98`); wire, don't delete.
- **D3**: re-embed invalidation = bump `DEFAULT_EMBED_MODEL_VERSION`
  (hermes `src/constants.ts:90`); delta machinery at
  `src/handlers/vector-backfill.ts:200` + SurrealDB id `${mdId}__${modelVersion}`
  (`src/store/surreal/vector-store.ts:92`) handles the full backfill. No
  bespoke migration.
- **D4**: breaker after K consecutive empty summarizeFn results breaks the
  layer loop; K default 3, knob beside `HIERARCHY_DEFAULTS`
  (`pi-agent-ext-knowledge-card/src/zk-task-config.ts:119`).
- **D5**: `kgLlmModel` precedence IngestOptions > loadConfig > env
  `PI_KG_LLM_MODEL`; update `bun-apps/tests/config-parity.test.ts` (~line 57).
- **D6**: merge-on-write inside `saveEntitySummaries`
  (`pi-agent-ext-knowledge-card/src/entity-summary.ts:121`) using existing
  `loadEntitySummaries` + spread-merge.

Constraint reminders:

- **Pinned surfaces:** hermes 6-tool surface + schema-cost hard pin ≤2100 tok —
  never silently re-pin; these tickets add no tools.
- **zk stays dependency-injected:** zk imports no store/LLM client
  (embedFn/summarizeFn pattern from the hierarchy port).
- **ADR-monorepo-0001 (strict downward edges):** hermes must not add a static
  import of zk to reach the entity-summary primitives — use the existing
  `__piKnowledgePipeline` runtime seam or a core-interface shared primitive
  (its Option-D precedent) as the wiring route. Verify at ticket level.
- **Zero behavior change outside these seams:** no-tree retrieval stays
  byte-identical; frequency-vote final ranking untouched; deterministic
  clustering unchanged.

## Testing Decisions

- Per-package `bun test` gates: `pi-agent-ext-knowledge-card`,
  `pi-agent-ext-hermes-memory`, `pi-agent-core-interface`, plus
  `bun-apps/tests/config-parity`.
- `bun run test:adr` (from `bun-apps/`) stays green.
- **Augment wiring**: A/B sanity test — augmented vs raw embed text on fixture
  cards; assert the embed input changes only when a summary exists and the
  no-summary path is byte-identical.
- **Breaker**: unit test with a null/empty-returning `summarizeFn` stub —
  assert the loop breaks at K consecutive empties and layers above are
  skipped.
- **Merge-on-write**: round-trip persistence test — save subset A, save
  subset B, reload: union present, A keys not clobbered.
- **kgLlmModel**: precedence matrix test (opts > config > env) + updated
  parity test.

## Out of Scope

- SQLite share-backend (3 ephemeral opens per warm query — accepted).
- >2k-card entity-scan revisit (scale trigger, not yet hit).
- webui/GUI knowledge panel.
- Second simplify round (D2 LOC from hermes-leanrag-simplify).
- CLIP image vectors; multi-panel split; Tier-3 drift (all fog/waived).

## Further Notes

- Fact-base anchors: all `file:line` refs above were verified against the tree
  on 2026-08-18 (note `vector-backfill.ts` lives under `src/handlers/`).
- Recon reports: `recon/2026-08-18-leanrag-knowledge-extract-recon.md`,
  `recon/2026-08-18-knowledge-rag-hermes-recon.md`.
- Provenance of the deferred items: umbrella map
  `.planning/2026-08-08-knowledge-pipeline/map.md` build-log notes (03-Phase2
  and 20 EXECUTE entries record all four seams as noted-deferred).
- Concept index: `bun-apps/pi-agent-ext-hermes-memory/docs/LEANRAG-PROVENANCE.md`;
  ADRs: `ADR-hermes-memory-0001` (selective port),
  `ADR-monorepo-0001` (downward edges).
