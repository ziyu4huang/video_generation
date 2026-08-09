type: grilling
blocked by: 01

## Question

Embeddings land in BOTH backends behind the backend-ab contract: SQLite via sqlite-vec, SurrealDB native. Pick the embed model + dimension (lm-studio, local). The user wants an A/B between the two backends to choose the default.

The real fog — "no duplication": pi-agent-ext-obsidian ALREADY does embeddings via ChromaDB/vault-mind (semantic_search). If the new card-store backend-ab also does embed, there are TWO embed systems. Decide:
- **Consolidate** — fold obsidian's semantic_search onto the new backend-ab embed index (one embed system for both the card store and obsidian); deprecate the ChromaDB path. Cleaner, removes a store, but touches obsidian's working semantic_search.
- **Keep split** — backend-ab embed serves the card-store's dup/conflict/query acceleration; obsidian keeps ChromaDB for its own vault semantic_search. Two systems, zero disruption to obsidian, but "repeat" embed infra.
- **Hybrid** — one embed model/dimension shared, two INDEX stores (sqlite-vec/surreal for cards, ChromaDB for obsidian) fed by the same embedder.

Also: does embed run at ingest (every card -> vector) and/or at query? Define the embed touchpoints. Blocked by 01 (card model determines what gets embedded). Grilling, one fork at a time.

## Prior art (cross-effort, 2026-08-08 review — cite, do not re-litigate)

- `2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory`/06 CLOSED: vector store = **sqlite-vec + MLX-local embedder**; **SurrealDB retained for graph only**; ChromaDB / QMD / Lance / Meili / Orama all **OUT**. -> The "consolidate with ChromaDB" option below should weight that ChromaDB was already rejected for the memory store; re-introduce ONLY if the knowledge workload demands it, not as a fresh open question.
- `2026-08-07-how-is-current-memory-finding-duplicate-conflict`/06 CLOSED: on **FTS** search, SurrealDB is 10-50x slower than SQLite -> kept SQLite. This ticket's A/B is the **semantic/embed** mode (different query path), so that FTS number does not pre-decide — but it is the prior art.
Net: focus the A/B on embed/semantic mode; treat chromadb-consolidation as "re-introduce only if justified."

## Resolution (2026-08-08, grilled)

Embed backend + ChromaDB consolidation pinned. The pipeline standardizes on zk's existing embedder; vault-mind/ChromaDB is deprecated.

- **Embed model (settled by directive):** `text-embedding-nomic-embed-text-v1.5` (768-dim) via LM Studio (`LMSTUDIO_BASE_URL`, `POST /v1/embeddings`). This is ALREADY zk's `SEMANTIC_MODEL_DEFAULT` (`pi-agent-ext-knowledge-card/src/semantic.ts:23`) — standardizing the whole pipeline on the existing embedder, not picking new. (Overrides the `2026-07-29` prior art's "MLX-local embedder" — lm-studio/nomic wins, per zk reality + user directive.)
- **Fork A (consolidation) — CONSOLIDATE NOW:** the new nomic embed index serves BOTH the card-store AND obsidian's semantic_search; the external vault-mind/ChromaDB service (`:8000`, retired-multilingual embedder) is DEPRECATED. Kills the double-embedding of zk cards; one embed system, one model. Accepted costs: premature migration target (index not built yet), re-pointing `obsidian_semantic_search`, re-embedding the vault, deprecating the `:8000` service. Obsidian migration = build-track follow-on.
- **Fork B (touchpoints) — INGEST CARD-EMBED (stored) + QUERY EMBED:** cards embedded ONCE at ingest (vectors stored in the index); queries embed only the query string + compare to stored card vectors. Enables vector-based dedup/conflict (ingest) AND semantic retrieval (query) — the full embed-powered pipeline. Efficient (cards embedded once). Embedding (local nomic, small+fast) is cheap — NOT the same cost class as the LLM relation-extraction gated opt-in in ticket 03, so no opt-out needed for embed.
- **Fork C (vector store) — EMBED RIDES BACKEND-AB; SurrealDB PRIMARY, sqlite-vec FALLBACK:** both backends support embed (sqlite via sqlite-vec extension; SurrealDB via native MTREE/vector field). SurrealDB native is the PRIMARY embed store; sqlite-vec is the FALLBACK when SurrealDB is unavailable. Mirrors the existing `backend-factory.ts:57-80` surreal->sqlite fallback pattern; fixes the carry-over's broken "SurrealDB-only" (embed never vanishes — degrades to sqlite-vec). The embed index can diverge from the CRUD store backend (embed prefers SurrealDB even on the default sqlite store).

**Interface impact (task 12):** `KnowledgePipeline.ingestRecords` stores vectors (ingest card-embed); `retrieveRecords` embeds the query + vector-searches; a new embed-index dependency (surreal primary / sqlite-vec fallback).

**Carry-over corrections:** "embed = SurrealDB-only" -> "embed rides backend-ab; SurrealDB primary, sqlite-vec fallback." The `2026-07-29` "MLX-local embedder" -> lm-studio/nomic. ChromaDB remains OUT for the card store (prior art upheld); it's deprecated for obsidian too (consolidate-now).

**Build-track follow-ons (impl, sequenced at /wayfind seed):** (a) embed index build (surreal primary + sqlite-vec fallback) — part of the card-store embed; (b) obsidian vault-mind migration/deprecation (re-point obsidian_semantic_search, re-embed vault, deprecate :8000); (c) extend the A/B bench (`backend-ab.ts`) to vector search — refinement, possibly flip the primary.

**Milestone:** closing 04 UNBLOCKS task 12 (last blocker removed; 03 already closed). Build-blocking decision phase DONE.

### Round 2 refinement (2026-08-09)

Fork C's "sqlite-vec FALLBACK" is SUPERSEDED — sqlite-vec is NOT loadable in Bun: `bun:sqlite` is compiled with `SQLITE_OMIT_LOAD_EXTENSION` ("This build of sqlite3 does not support dynamic extension loading"), and `better-sqlite3` (the only `loadExtension`-capable driver) crashes Bun with a NAPI fatal panic. Vectors now ride SurrealDB HNSW ONLY: verified SurrealDB v3.2.3 (`DEFINE INDEX <name> ON <table> FIELDS vec HNSW DIMENSION 768 DIST COSINE TYPE F32;`, KNN via 2-arg `<|k,EF|>` — v3 removed the old `<|k|>`), HNSW p95 ~13 ms wall / ~2 ms server-side at 1,000 768-dim vectors. SQLite fallback is now NON-vector CRUD + FTS5 only — semantic/vector search is simply unavailable when SurrealDB is down, NOT a JS cosine. Embed model UNCHANGED this round (`text-embedding-nomic-embed-text-v1.5`, 768-dim, via LM Studio). OPEN (not addressed this round): embed-bench shows nomic fastest but bge-m3 higher recall@1 (0.909 vs 0.864) — model pick may be revisited in a later fork.

### Round 2 refinement — embed index build policy (2026-08-09): lazy + background backfill

Decision — Embed index build policy: lazy + background backfill (Round 2 grill; refines Ticket 04 Fork B; dated 2026-08-09).

The embed/vector index (SurrealDB HNSW, per the vector-backend decision recorded elsewhere in these files) is built LAZILY — not eagerly at ingest:

- Lazy-first: ingest stays embed-free (matches the current 06b spine walk-and-ingest.ts [CRUD-mirror + heal only] AND zk's semantic.ts, which already computes embeds lazily on first semantic query, persisted to <vault>/.knowledge-semantic/<model>.json, brute-force in-memory cosine).
- On-demand query embed: a query embeds the query string and searches; if HNSW is cold/partial for some cards, it brute-force cosine-searches the persisted local cache for the un-backfilled cards and merges; an async backfill is fired. Queries never block; semantic results return immediately.
- Background backfill: a deferred INCREMENTAL backfill (reusing the existing session-backfill.ts pattern — setTimeout(0), inProgress-guarded, idempotent re-check, error-isolated, shutdown-drained) warms SurrealDB HNSW for new/changed cards. Triggers: after each ingest-walk, and on first cold query. Incremental only (deltas).
- Delta-keyed invalidation (fixes zk's whole-cache-rebuild weakness): keyed by per-card content-hash + embed-model version — only new/changed cards re-embed.
- Dedup at ingest: uses the existing pluggable DedupStrategy (FTS/hash) — no vector dependency at ingest. Vector-dedup becomes an optional depth-pass once HNSW warms.
- Two-tier vector storage (mirrors backend-factory surreal-primary / sqlite-fallback): SurrealDB HNSW = fast path; zk's persisted JSON cache = complete-set brute-force cosine fallback when SurrealDB is down. Same nomic embedder feeds both (one embed system, two storage tiers) — patches the "vectors vanish when SurrealDB down" gap from the vector-backend decision.

SUPERSEDES/REFINES Ticket 04 Fork B ("INGEST CARD-EMBED (stored) + QUERY EMBED"): the eager-at-ingest half is REPLACED by lazy+backfill; the query-embed half STANDS.

### Round 2 refinement — embed model (2026-08-09): nomic confirmed + bge-m3 upgrade path

Decision — Embed model: nomic (CONFIRMED) + bge-m3 upgrade path (Round 2 grill; confirms Ticket 04 model pin; dated 2026-08-09).

- Model: text-embedding-nomic-embed-text-v1.5 (768-dim) via LM Studio — CONFIRMED (zk's SEMANTIC_MODEL_DEFAULT; zero migration).
- NEW context (from the lazy+backfill decision): the embed model is now a RUNTIME-SWAPPABLE config — delta-keyed by model version (bump version -> backfill re-embeds). So the model is NOT an architectural lock-in.
- Documented upgrade path: bge-m3 (1024-dim). embed-bench shows bge-m3 recall@1 0.909 / MRR 0.947 vs nomic 0.864 / 0.899 (~4.5pp recall edge), at ~2.5x embed time (absorbed by the background backfill). UPGRADE TRIGGER: if real-workload recall (dedup/search) falls below target, switch to bge-m3 (config + model-version bump + backfill re-embed).
- Bench facts (python/embed-bench/results/report.md, LM Studio): nomic recall@1 0.864 / 121/s / 768-dim; bge-m3 0.909 / 47/s / 1024-dim; qwen3-embedding-0.6b 0.909 / 32/s / 1024-dim (dominated by bge-m3).

closed: implemented-as-decision (embed backend contract pinned).
