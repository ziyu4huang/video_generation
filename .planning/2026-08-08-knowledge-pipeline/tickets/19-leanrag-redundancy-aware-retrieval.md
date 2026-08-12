---
type: build
blocked by: 14
---

## Context

Selective port of LeanRAG's redundancy-aware retrieval (concept ③) into the
knowledge-search path. Decision record: `bun-apps/pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md`. Full analysis: `.planning/2026-08-08-knowledge-pipeline/brainstorm/leanrag-knowledge-pipeline-adoption.md`.

LeanRAG's frequency-voted chunk recall + dedup, adapted to our card model: when
multiple retrieval signals (HNSW semantic + FTS lexical + deterministic entity
tags) surface the same card, boost it; collapse exact-duplicate cards. A
retrieval-quality refinement that compounds on the just-shipped HNSW index
(ticket 14) with zero LLM-cost surface, and stays deterministic.

## What to build (pinned by grilling, rounds 2–3)

- **Retrieval unit = card-level.** A knowledge-card is the chunk. The
  frequency-vote counts how many independent signals reference each card id.
- **Seam = inside `searchSemantic`.** Extend the existing top-K return
  (`src/store/semantic-search.ts`) to dedup + frequency-vote before returning.
  Single seam; every caller (the `knowledge_search` tool) benefits.
- **Dedup = exact contentHash only.** Cards sharing an identical contentHash
  (tracked per ticket 14's backfill) collapse to one. No cosine / near-dup pass
  — that is ticket 17.
- **Frequency-vote across signals.** Combine the HNSW semantic top-K, the FTS
  lexical hits, and the deterministic entity-tag matches; count references per
  card; re-rank so cards surfaced by multiple signals rank higher. Default
  formula: union of candidates, ordered by descending signal-count, then by
  per-signal score; exact formula + surviving K are impl details.
- **Both warm + cold paths.** Apply vote+dedup on the HNSW warm path AND on the
  graceful-degrade cold fallback (knowledge→zk cosine, memory→lexical FTS,
  ticket 14 T5a), so context stays lean whether or not SurrealDB is up.
- **Config knobs** — register per lesson #06 (like ticket 14's `vectorTopK` /
  `vectorEf`): a multi-signal boost weight and a surviving-K cap. Exact names
  TBD at impl; not hard-coded.

## Acceptance

- `searchSemantic` returns cards ordered by multi-signal frequency
  (exact-contentHash-deduped) on BOTH the HNSW warm path and the cold fallback.
- A card referenced by ≥2 independent signals ranks above a card referenced by
  1, holding per-signal score roughly equal.
- Exact contentHash duplicates never appear twice in a single result set.
- Graceful-degrade still never throws (ticket 14 T5a invariant preserved); the
  vote+dedup runs on the fallback's top-K.
- New config knobs are registered, not hard-coded.
- Tests (red-green slice in `tests/store/semantic-search.test.ts`): (a)
  multi-signal boost, (b) exact-hash dedup, (c) fallback-path vote+dedup.

## Out of scope

- Concept ⑥ (entity-description summarization) + ③'s relation-dedup → ticket 03
  (need typed relations / enriched entity descriptions).
- Near-dup / cosine-threshold collapse → ticket 17.
- LeanRAG ① semantic-aggregation hierarchy + ② LCA retrieval → fog/future
  (deferred per ADR-0001).
