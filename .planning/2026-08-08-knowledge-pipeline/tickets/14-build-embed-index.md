---
type: build
status: open
claimed:
blocked by: 04 (closed — embed backend / build policy / model all decided in Round 2), 16 (closed 2026-08-12 — HNSW validated at scale: warm p95 flat ~11→18ms @1k→100k; build full HNSW, retain cosine warm/cold fallback)
unblocks: obsidian vault-mind/ChromaDB deprecation (future ticket); A/B vector-bench extension (refinement)
---
# 14 — Build embed/vector index (SurrealDB HNSW + lazy backfill)

> **UNBLOCKED** — ticket 04 (embed backend) is `closed`; Round-2 grill pinned backend + build policy + model. Spine [12 + 06a + 06b] shipped, so the card-store this rides is live. Ready to start.
> **Scale gate PASSED (2026-08-12, ticket 16):** HNSW holds at scale (warm p95 flat ~11→18ms @1k→100k; HNSW 21× faster than cosine under c16@100k; build ~1.5k vec/s). BUILD the full HNSW per Decision 04; RETAIN the cosine JSON-cache fallback (T5) for the small-N regime + cold-start window. Confirm the expected corpus scale/concurrency before committing the build cost (if <~10k + low concurrency, cosine-alone is currently faster).

## Goal
Build the knowledge-pipeline embed/vector index end-to-end on the hermes spine, per the Round-2 grill resolutions (recorded as 3 refinements in ticket 04 + the hermes-memory PRD.md). Delivers an embed-powered semantic query + (optional) vector-dedup layer.

## Resolved design (Round 2 grill — do NOT re-litigate; see ticket 04 Round-2 refinements)
1. **Vector backend — SurrealDB HNSW PRIMARY.** Verified v3.2.3: `DEFINE INDEX <name> ON <table> FIELDS vec HNSW DIMENSION 768 DIST COSINE TYPE F32;`; KNN `SELECT id FROM <table> WHERE vec <|k,EF|> [<768 floats>];` (v3 removed the old `<|k|>`); ~13ms p95 @1k 768-dim vectors; DISKANN also available. SQLite = NON-vector CRUD/FTS fallback only. sqlite-vec DROPPED (not loadable in Bun — `OMIT_LOAD_EXTENSION`; better-sqlite3 crashes Bun).
2. **Build policy — LAZY + background backfill (NOT eager at ingest).** Ingest stays embed-free (matches 06b + zk `semantic.ts`). On-demand query embed + brute-force-cosine-over-persisted-cache merge for cold cards + async backfill. Reuse the `session-backfill.ts` defer pattern (`setTimeout(0)`, inProgress-guarded, idempotent, shutdown-drained). Delta-keyed by per-card content-hash + embed-model version (fixes zk's whole-cache rebuild). SurrealDB-down → degrade to zk JSON-cache cosine (two-tier storage, mirrors backend-factory).
3. **Model — `text-embedding-nomic-embed-text-v1.5` (768-dim)** via LM Studio (`LMSTUDIO_BASE_URL` `/v1/embeddings`, batched 32/req). Confirmed (zk `SEMANTIC_MODEL_DEFAULT`). Runtime-swappable under lazy+backfill. Upgrade path: bge-m3 (recall@1 0.909 vs 0.864) if real-workload recall < target.

## Tracer-bullet tasks (blocking edges in order)
- **T1** — SurrealDB HNSW vector store on the card-store (backend-ab): schema + `DEFINE INDEX ... HNSW DIMENSION 768` + upsert-card-vector + KNN query. Gated test by `isSurrealUp`. [blocks T2, T3]
- **T2** — Lazy query path: embed query → HNSW search warm cards → merge brute-force cosine over persisted cache for cold cards → return; fire async backfill. [blocks T3-integration]
- **T3** — Background backfill (`session-backfill.ts` pattern): deferred incremental embedder warming HNSW after each ingest-walk + on first cold query; delta-keyed (content-hash + model-version).
- **T4** — Dedup integration: existing pluggable `DedupStrategy` stays FTS/hash at ingest (no vector dependency); optional vector-dedup depth-pass once HNSW warm.
- **T5** — SurrealDB-down fallback: two-tier — HNSW fast path, zk JSON-cache brute-force cosine fallback. Vectors never vanish.
- **T6** — Model config: nomic via LM Studio; model-version key for swappability; bge-m3 as config-only upgrade.

## Verification
- [ ] SurrealDB vector round-trip (upsert + KNN recall) gated by `isSurrealUp`.
- [ ] Lazy query returns semantic results on a cold corpus (no prior backfill).
- [ ] Backfill warms HNSW incrementally; unchanged cards not re-embedded (delta-key).
- [ ] SurrealDB-down: query degrades to JSON-cache cosine (no throw, results returned).
- [ ] Dedup at ingest unchanged (FTS/hash) when vectors absent.
- [ ] `bun run typecheck` + `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )` green.

## Out of scope
- bge-m3 migration (upgrade path only; trigger = real-workload recall < target).
- obsidian vault-mind/ChromaDB deprecation (separate build ticket).
- A/B vector-bench extension (refinement).
- Image-card embed strategy (ticket 07).
