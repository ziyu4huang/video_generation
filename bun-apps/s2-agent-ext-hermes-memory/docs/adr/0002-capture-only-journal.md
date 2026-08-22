**ID:** `ADR-hermes-memory-0002` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID.

# 0002 — Hermes folds to a capture-only journal; the vector path is deleted, not re-armed

**Status:** accepted
**Date:** 2026-08-22
**Plan:** `.planning/2026-08-22-context-lifecycle/` (ticket 03; D1)
**Supersedes:** the vector-half of `ADR-hermes-memory-0001` (the HNSW warm path / `searchSemantic` / vector backfill that 0001's port rode on)

## Context

ADR-0001 ported LeanRAG retrieval concepts "into the existing `searchSemantic` /
`knowledge_search` path … compounding on the just-shipped HNSW index (ticket 14)".
The measured reality (audit 2026-08-19, `.planning/knowledge/hermes-recall-audit.md`):
the `vectors` SurrealDB database was **never created** — the semantic wiring gated
lazily on `config.surreal.endpoint` + `semantic:true`, so every armed query served
the zero-row lexical fallback. Recall hit@1/3/5 = **0/20**, MRR 0.000. Negatives
passed vacuously. Meanwhile kcard's `retrieveRecords` (knowledge-card ext) measured
hit@4 = **1.00** on its lexical+semantic blend over the same vault — the retrieval
problem is solved elsewhere, by a path that actually runs.

## Decision

Hermes is a **capture-only journal**: session journal, auto-capture, correction
detection, session_shutdown flush, `convergeHermesMemory` handoff to kcard
(ADR-0001's convergence spine stands), and deterministic exact-match session search.
The semantic surface is deleted, not repaired:

- `store/surreal/vector-store.ts` + `vector-store-helpers.ts` (VectorStore, KNN),
  `store/semantic-search.ts` (searchSemantic + the ticket-20 frequency vote),
  `store/card-vectors-cache.ts`, `handlers/vector-backfill.ts`,
  `composition/knowledge-semantic.ts` (the never-armed wiring),
  `VECTOR_BOOTSTRAP_SQL` (card_vectors HNSW bootstrap), and the
  `embedModel`/`embedModelVersion`/`vectorTopK`/`vectorEf`/`survivingK`/`boostWeight`
  config knobs.
- `knowledge_search` stays lexical/tags-only over the zk seam; recall questions
  route through kcard `retrieveRecords` / `knowledge_query`.

**SurrealDB stays — as the CRUD journal store of record** (per-user namespace,
PR #753 Phase 3 backend). It never enters the retrieval path: a vector surface in
SurrealDB would re-arm exactly the role retired here and duplicate kcard's measured
blend.

## Consequences

- Re-arming the hermes vector path is REJECTED (D1): a second retrieval path that
  returns nothing is schema cost, not redundancy; one that works is a duplicate.
- The LeanRAG ①② hierarchy port survives untouched — its embedder is injected at
  composition (`composition/tools.ts`), independent of the deleted stores; ③'s
  vote half (frequency-voted recall) dies with `searchSemantic`, its dedup-half
  vocabulary lives on in kcard.
- Schema receipt (hermes perf gate): `knowledge_search` 263 → 186 tok; 6-tool
  surface shrinks by the retired opt-in params.
- Ticket 04 (`.planning/2026-08-22-context-lifecycle/`) commits the audit runner
  so the 0/20 stays reproducible as the fold's after-proof baseline.
