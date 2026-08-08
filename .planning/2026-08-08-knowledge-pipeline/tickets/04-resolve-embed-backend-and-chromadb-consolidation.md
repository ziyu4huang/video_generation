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

closed: implemented-as-decision (embed backend contract pinned).
