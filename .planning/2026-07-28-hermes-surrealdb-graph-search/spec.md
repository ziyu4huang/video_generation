# hermes-memory SurrealDB Graph-Augmented Search

## Status
Implemented 2026-07-28 via TDD. Branch `feat/hermes-surrealdb-graph-search`:
- `df9f2720` spec
- `3c3d749e` shared ranker + unit tests
- `7cf59a9b` SQLite wiring (part 1)
- `22ae3ea7` SurrealDB RELATE wiring (part 2)

758/758 tests green; tsc clean. Both backends pass the shared graph-recall contract case (real SQLite + real SurrealDB, gated by `isSurrealUp`).

## Destination
Leverage SurrealDB's native graph power (`RELATE` edges) so hermes-memory's
`searchMemories` recalls graph-related entries, while keeping the SQLite
backend fully compatible and the repository contract unchanged. Transparent
recall boost + numeric combined re-rank, driven by a shared cross-backend ranker.

## Decisions (pinned via grilling, one corrected mid-flight)
1. **Core power:** SurrealDB graph edges (`RELATE`).
2. **Surface model:** transparent search-recall boost; `searchMemories → MemoryEntry[]` contract unchanged.
3. **Edge source:** implicit tags = the existing `project` / `category` / `target` fields.
   - *Premise correction:* the original "tag edges (memory↔tag)" choice was built on a false premise — `memories` has **no tags column** (only `target/category/project/content/failureReason/toolState/correctedTo/created/lastReferenced`). Re-decided to the existing implicit tags. **No schema change.**
4. **Search integration:** lexical FTS results + graph neighbors merged and re-ranked by a numeric combined score.
5. **Architecture:** a shared pure-TS ranker reads `MemoryEntry` fields; SQLite uses column-equality to find neighbors (zero schema change); SurrealDB adds `tag` nodes + `RELATE memory->tagged->tag` edges + graph traversal. Both backends feed candidate pools to the same ranker → cross-backend result identity.

## Key existing facts (verified against src/)
- `searchMemories` today = fulltext-match-as-filter + `ORDER BY last_referenced DESC`. **No relevance score exists** in either backend.
- SurrealDB: `SELECT ... WHERE content @@ $q ORDER BY lastReferenced DESC` (`@@` = fulltext match op), no score.
- SQLite: `m.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?) ORDER BY m.last_referenced DESC`, no score.
- `MemoryEntry` already carries `project` / `target` / `category` → the shared ranker can compute graph proximity from fields already present. **SQLite needs no schema change at all.**

## Architecture
- **`src/store/graph-ranker.ts` (new):** pure function. Input: candidate pool `MemoryEntry[]`, seed-set ids, query. Output: scored + sorted `MemoryEntry[]`. No backend imports. Called by both repos inside `searchMemories`.
- **SurrealDB graph layer (new):** `DEFINE TABLE tag`; tag-nodes keyed `tag:⟨kind:value⟩` (e.g. `tag:project:video_generation__memory`); `RELATE $mem->tagged->$tag` for each non-null implicit tag; neighbor traversal `SELECT <-tagged<-memory.* FROM tag WHERE id IN $seedTags`.
- **SQLite:** no schema change. Neighbor query uses existing columns: `WHERE project IN (...) OR category IN (...) OR target IN (...)`.

## Data flow (inside searchMemories)
1. Lexical match (existing path) → **seed set** (top-N, N≈10).
2. From seeds' implicit-tag values, fetch **graph neighbors** (memories sharing ≥1 of project/category/target), exclude already-lexical-matched, cap pool (≈20).
3. Merge pool → **shared ranker** → score + sort → truncate to `options.limit` (default 10).

## Scoring formula (graph-ranker.ts)
```
graphProximity = (distinct shared {project,category,target} values w/ seed set) / 3   ∈ [0,1]
recencyNorm    = 1 / (1 + ageDays/30)                                                 ∈ (0,1]
score = 1.0 * lexicalMatch(0|1) + 0.5 * graphProximity + 0.25 * recencyNorm
```
- **Invariant:** lexical matches always rank above neighbors (non-match max = 0.5 + 0.25 = 0.75 < 1.0).
- Weights centralized as constants in `graph-ranker.ts` (tunable; do not affect cross-backend equivalence).

## Write path + backfill (SurrealDB only)
- `addMemory` / `replaceSyncedMemories` / `syncMemoryEntry`: after row write, idempotently `RELATE $mem->tagged->$tag` for each non-null implicit tag.
- **One-time backfill** on `backend.init`: if tag-edge count is 0, scan existing memories and build tag-nodes + edges. Idempotent, re-runnable. SQLite: no-op.

## Error handling
- SurrealDB graph traversal failure → **graceful degrade** to current behavior (lexical + recency, no expansion). Graph is a recall booster, never blocks search.

## Testing (refined — leverages the existing cross-backend harness)

**The repo already has structural cross-backend e2e:**
`repository-contract.test.ts` exports `runMemoryRepositoryContract(name, make)` (backend-agnostic). SQLite instantiates it in-file; SurrealDB instantiates the **same** suite in `tests/store/surreal/surreal-memory-repo-contract.test.ts` against a **real** local SurrealDB server (gated by `isSurrealUp()` health probe → auto-skips when no server, runs against a real server + unique namespace per run when up).

- **Add graph-recall cases to the SHARED `runMemoryRepositoryContract`** → they automatically run against **both** real backends (this *is* the cross-backend e2e equivalence proof):
  - Seed two memories sharing `project`, with no shared content lexicon; search one's content; assert the other appears (graph recall) at an **identical position in both backends**; assert a non-sharing memory does NOT appear.
- **`tests/store/graph-ranker.test.ts` (new, unit, no backend):** lexical-above-neighbor invariant, `graphProximity` computation, recency decay, limit truncation, determinism.
- **SurrealDB-specific (gated on server up):** backfill idempotency, write-creates-3-edges, traversal correctness.
- **SQLite:** no schema change → existing tests unaffected.

### Env switch?
**No env var needed — by design.** Backend selection is structural (shared factory × two test files), not env-driven. SurrealDB auto-runs when its server is up. This is strictly safer than an env toggle (you can't forget to run a backend). We follow the existing convention rather than introducing an env var.

## Risks
- **Low.** SQLite: zero schema change. SurrealDB: only adds the graph layer. Shared ranker guarantees equivalence. Main work = SurrealDB graph layer + ranker + tests.
- **Tunable risk:** scoring weights need real-data calibration, but they are centralized and equivalence-neutral.

## Implementation notes (resolved during TDD)
- **SurrealDB record id**: deterministic `memories:⟨seq⟩` via `CREATE type::record("memories", $next)` (chosen over random-id+lookup for simplest RELATE).
- **SurrealDB v3 quirks discovered**: the record-id constructor is `type::record` (NOT `type::thing`, which is v1); `RELATE` does NOT accept a `type::record(...)` call in source/target position (parse error on `::`) — bind via `LET $mem = type::record(...)` first, then `RELATE $mem->tagged->$tag`.
- **Tag nodes** keyed `type::record("tag", key)` with a queryable `key` field (= `kind:value`); neighbor lookups use `WHERE key IN $keys`.
- **Edge idempotency**: `syncGraphEdges` does `DELETE FROM tagged WHERE in = ...` then rebuilds (delete-then-UPSERT/RELATE).

## Deferred (YAGNI — not needed for the contract test; revisit if/when)
- **Backfill** of tag edges for pre-existing SurrealDB data (default-off backend; fresh test namespaces per run).
- **Bulk-remove edge cleanup** (`removeSyncedMemories`/`removeExactSyncedMemories`) — orphan edges are harmless to traversal (filtered out); only single `removeMemory` cleans its edges today.
- **Scoring weight calibration** (`1.0/0.5/0.25`, recency decay, seed top-N ≈10, pool cap ≈20) — tune after real-data use.
