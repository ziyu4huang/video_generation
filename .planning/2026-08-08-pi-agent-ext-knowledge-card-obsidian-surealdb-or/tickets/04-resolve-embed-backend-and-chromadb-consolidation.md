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
