---
type: build
status: closed
claimed: pi/main-session (2026-08-13, ticket 19 build)
blocked by: 14 (closed — HNSW index shipped T1/T2/T3/T5a/T6)
unblocks: 20 (LeanRAG multi-signal frequency-vote — now blocked by 03 only)
shipped: #1282 (squash b7f1e78c, 2026-08-13) — LeanRAG selective port, dedup-first slice: contentHash dedup seam in searchSemantic (3 paths) + survivingK cap
---

## Context

Selective port of LeanRAG's redundancy-aware retrieval (concept ③) into the
knowledge-search path. Decision record: `bun-apps/pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md`. Full analysis: `.planning/2026-08-08-knowledge-pipeline/brainstorm/leanrag-knowledge-pipeline-adoption.md`.

## Re-scope (2026-08-13, SDD pre-flight)

Reconnaissance showed only **1 of the 3** assumed signals (HNSW) is wired into
`searchSemantic` as a recall path today; FTS is cold-fallback-only/memory-only;
entity-tag recall does not exist (deferred to ticket 03). So the multi-signal
**frequency-vote** is unachievable as originally scoped — see ticket 20.

This ticket now ships the **dedup-first** slice: exact-contentHash dedup + a
re-rank seam + the surviving-K cap, all inside `searchSemantic` on both warm +
cold paths. The frequency-vote + boost-weight knob move to **ticket 20** (gated
on ticket 03 + a knowledge-lexical seam).

## What to build

- **Surface contentHash on the warm path.** Augment `vector-store.ts` `knn`
  SELECT to `SELECT mdId, kind, contentHash`; extend `VectorKnnHit` +
  `SemanticSearchHit` with an optional `contentHash`.
- **Exact-contentHash dedup + re-rank seam inside `searchSemantic`.** A shared
  helper applied to the warm path's ranked list AND both cold-path returns
  (`knowledgeFallback`, `memoryFallback`): collapse hits sharing an identical
  contentHash to one. Single seam; every caller benefits.
- **Both warm + cold paths.** Dedup runs on the HNSW warm path AND the
  graceful-degrade cold fallback (ticket 14 T5a). The never-throws invariant is
  preserved.
- **survivingK config knob** — register per lesson #06 (the 4-point pattern:
  constants.ts default → types.ts field → config.ts DEFAULT_CONFIG → config.ts
  loadConfig allowlist); thread through `SearchSemanticOptions`; caps the
  returned list. (The multi-signal `boostWeight` knob defers to ticket 20 — it
  has no effect with a single signal.)

## Acceptance

- `searchSemantic` returns exact-contentHash-deduped cards on BOTH the HNSW warm
  path and the cold fallback.
- Exact contentHash duplicates never appear twice in a single result set.
- Graceful-degrade still never throws (ticket 14 T5a invariant preserved); dedup
  runs on the fallback's top-K.
- `survivingK` is a registered config knob (4-point pattern), not hard-coded,
  and caps the returned list.
- Tests (red-green slice in `tests/store/semantic-search.test.ts`): (a)
  exact-hash dedup on the warm path, (b) exact-hash dedup on the cold path,
  (c) survivingK caps the result, (d) never-throws invariant holds under dedup.

## Out of scope (deferred)

- **Multi-signal frequency-vote + `boostWeight` knob → ticket 20** (needs ≥2
  recall signals: a knowledge-lexical seam + ticket 03's entity recall).
- Concept ⑥ (entity-description summarization) + ③'s relation-dedup → ticket 03.
- Near-dup / cosine-threshold collapse → ticket 17.
- LeanRAG ① semantic-aggregation hierarchy + ② LCA retrieval → fog/future
  (deferred per ADR-0001).

## Plan

Execution plan: `plans/19-leanrag-redundancy-aware-retrieval.md` (SDD).
