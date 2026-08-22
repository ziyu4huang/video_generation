# PRD — s2-agent-ext-hermes-memory

## Problem

Pi agents forget everything between sessions. Workflow self-improve loops, failures, corrections, and user preferences need durable storage that survives across sessions and is queryable at runtime.

## Solution

Persistent memory + session search + secret scanning for Pi. Stores categorized memories (failures, corrections, insights, conventions, tool-quirks, preferences) in flat markdown files under `~/.pi/agent/pi-hermes-memory/`. Indexes past sessions for semantic search. Background learning reviews every N turns and saves what matters. Auto-consolidates entries when full.

## Tools / Commands

| Tool/Command | Description |
|--------------|-------------|
| `memory` | Save/query/audit persistent entries across targets (memory, user, project, failure) |
| `memory_search` | Search extended memory store with category/project filters |
| `session_search` | Search indexed past conversation messages |
| `skill_manage` | Create/inspect/update reusable procedural skills |
| `/memory-index-sessions` | One-time index of past sessions |
| `/memory-sync-markdown` | Backfill older markdown memories |

## Key Dependencies

- Self-contained (works across Pi sessions)
- Consumed by `s2-agent-ext-knowledge-card` (zk_ingest --source hermes)

## Install

```bash
pi install npm:pi-hermes-memory
```

## Decision: Vector/search backend — SurrealDB primary, SQLite fallback (2026-08-09)

Decision — Vector/search backend: SurrealDB PRIMARY, SQLite fallback (Round 2 grill; refines Ticket 04 Fork C; dated 2026-08-09).

- SurrealDB is the PRIMARY backend for the knowledge pipeline, carrying BOTH the CRUD store AND the vector (embed) index — HNSW, 768-dim, cosine distance.
  Verified SurrealDB v3.2.3 (resident @127.0.0.1:8000):
    DDL:  DEFINE INDEX <name> ON <table> FIELDS vec HNSW DIMENSION 768 DIST COSINE TYPE F32;
    KNN:  SELECT id FROM <table> WHERE vec <|10,100|> [<768 floats>];   -- v3 REMOVED the old <|k|> operator; use 2-arg <|k,EF|> for HNSW or <|k,DIST|> for brute force.
    Latency: HNSW p95 ~13 ms wall / ~2 ms server-side at 1,000 768-dim vectors. DISKANN also supported (DEFINE INDEX ... DISKANN DIMENSION 768 DIST COSINE TYPE F32;).
- SQLite is the FALLBACK backend for NON-vector CRUD + FTS5 only, via the existing surreal->sqlite backend-factory.ts pattern. SQLite does NOT carry the vector index.
  Reason: sqlite-vec is NOT loadable in Bun — bun:sqlite is compiled with SQLITE_OMIT_LOAD_EXTENSION ("This build of sqlite3 does not support dynamic extension loading"); better-sqlite3 (the only loadExtension-capable driver) crashes Bun (NAPI fatal panic). So when SurrealDB is down, semantic/vector search is unavailable (SQLite FTS only), NOT a JS cosine.
- SUPERSEDES Ticket 04's "sqlite-vec FALLBACK" — sqlite-vec is dropped.
- Embed model UNCHANGED this round: text-embedding-nomic-embed-text-v1.5 (768-dim) via LM Studio.
- OPEN (not addressed this round): embed-bench shows nomic is fastest but bge-m3 has higher recall@1 (0.909 vs 0.864) — model pick may be revisited in a later fork.

## Decision: Embed index build policy — lazy + background backfill (2026-08-09)

Decision — Embed index build policy: lazy + background backfill (Round 2 grill; refines Ticket 04 Fork B; dated 2026-08-09).

The embed/vector index (SurrealDB HNSW, per the vector-backend decision recorded elsewhere in these files) is built LAZILY — not eagerly at ingest:

- Lazy-first: ingest stays embed-free (matches the current 06b spine walk-and-ingest.ts [CRUD-mirror + heal only] AND zk's semantic.ts, which already computes embeds lazily on first semantic query, persisted to <vault>/.knowledge-semantic/<model>.json, brute-force in-memory cosine).
- On-demand query embed: a query embeds the query string and searches; if HNSW is cold/partial for some cards, it brute-force cosine-searches the persisted local cache for the un-backfilled cards and merges; an async backfill is fired. Queries never block; semantic results return immediately.
- Background backfill: a deferred INCREMENTAL backfill (reusing the existing session-backfill.ts pattern — setTimeout(0), inProgress-guarded, idempotent re-check, error-isolated, shutdown-drained) warms SurrealDB HNSW for new/changed cards. Triggers: after each ingest-walk, and on first cold query. Incremental only (deltas).
- Delta-keyed invalidation (fixes zk's whole-cache-rebuild weakness): keyed by per-card content-hash + embed-model version — only new/changed cards re-embed.
- Dedup at ingest: uses the existing pluggable DedupStrategy (FTS/hash) — no vector dependency at ingest. Vector-dedup becomes an optional depth-pass once HNSW warms.
- Two-tier vector storage (mirrors backend-factory surreal-primary / sqlite-fallback): SurrealDB HNSW = fast path; zk's persisted JSON cache = complete-set brute-force cosine fallback when SurrealDB is down. Same nomic embedder feeds both (one embed system, two storage tiers) — patches the "vectors vanish when SurrealDB down" gap from the vector-backend decision.

SUPERSEDES/REFINES Ticket 04 Fork B ("INGEST CARD-EMBED (stored) + QUERY EMBED"): the eager-at-ingest half is REPLACED by lazy+backfill; the query-embed half STANDS.

## Cross-reference

- `bun-apps/KNOWLEDGE-LAYER.md` — 3-layer knowledge system map (the retired knowledge-orchestration.md's successor)
- `bun-apps/s2-agent-ext-knowledge-card/` — convergence sink consuming this store
