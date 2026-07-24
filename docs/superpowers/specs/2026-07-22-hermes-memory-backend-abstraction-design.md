# Hermes Memory — Backend Abstraction (SQLite → SurrealDB) Design

**Date:** 2026-07-22
**Package:** `bun-apps/pi-agent-ext-hermes-memory`
**Status:** Design (pending implementation plan)

## Problem

`pi-agent-ext-hermes-memory` is permanently coupled to SQLite. The single
physical `bun:sqlite` import lives in `src/store/db.ts`, but SQL strings,
FTS5 virtual tables, PRAGMAs, `BEGIN IMMEDIATE` dedup transactions, and a
corruption self-heal engine are spread across four store files
(`db.ts`, `sqlite-memory-store.ts`, `session-indexer.ts`, `session-search.ts`).
Upstream handlers/tools already talk only to free-function data-access (DA)
APIs and to `DatabaseManager`, but those APIs take `DatabaseManager` and run
raw SQL — there is no backend-neutral seam.

The goal is to introduce a **backend-neutral abstraction** so that a
SurrealDB backend can be added later as a pure additive change, with zero
upstream awareness.

## Key correction: SurrealDB is NOT SQL-compatible

SurrealDB's query language is **SurrealQL** (SQL-*flavored*, not SQL), and it
has **no SQLite FTS5 virtual tables, no triggers, no PRAGMAs**. Its full-text
search uses `DEFINE ANALYZER` + `DEFINE INDEX ... FULLTEXT ANALYZER` (v3
syntax) and the `@@` operator, where the server-side analyzer tokenizes the
query string. This means a "run SQL strings" abstraction would not achieve
portability — the SQL itself is non-portable. **Only a repository/domain-level
abstraction works.**

SurrealDB FTS auto-syncs on write (no external-content triggers, no
`'rebuild'` command), so the search machinery on the SurrealDB side is
simpler than the FTS5 side.

## Decision

**Approach A — Repository interfaces + async + per-backend encapsulation.**

- `src/store/repository.ts` defines `MemoryRepository`, `SessionRepository`,
  a `Backend` lifecycle interface, and backend-neutral DTOs (pure types).
- `src/store/sqlite/` reorganizes the current four files into a
  `SqliteBackend` + `SqliteMemoryRepository` + `SqliteSessionRepository`.
  FTS5, triggers, PRAGMAs, `BEGIN IMMEDIATE`, and corruption self-heal are
  fully encapsulated inside the SQLite backend.
- `src/store/surreal/` (Phase 3) implements the same interfaces in SurrealQL.
- `index.ts` selects the backend via `config.dbBackend` and injects the
  repository interfaces (not `DatabaseManager`) into handlers/tools.

The interfaces are **async** (`Promise`), forced by the remote SurrealDB
model (HTTP server on `127.0.0.1:8000`, no embedded sync client). This
propagates `await` to ~30 call sites.

## Architecture & module layout

```
handlers/*  tools/*           ← upstream: depends ONLY on interface types
        │  (injected MemoryRepository / SessionRepository)
        ▼
src/store/repository.ts       ← interface layer: MemoryRepository,
                                 SessionRepository, Backend + DTOs
                                 (pure types, zero implementation)
        │  (implemented by)
        ▼
src/store/sqlite/             ← SQLite backend (Phase 1-2)
  ├─ sqlite-backend.ts        ← connection, schema, WAL/PRAGMA, corruption self-heal
  ├─ sqlite-memory-repo.ts    ← MemoryRepository (from sqlite-memory-store.ts)
  ├─ sqlite-session-repo.ts   ← SessionRepository (from session-indexer.ts + session-search.ts)
  └─ fts-query.ts             ← FTS5 query construction (SQLite-specific)

src/store/surreal/            ← SurrealDB backend (Phase 3, pure additive)
  ├─ surreal-backend.ts       ← HTTP connection (127.0.0.1:8000, surreal-ns/surreal-db headers)
  ├─ surreal-memory-repo.ts   ← MemoryRepository (SurrealQL + analyzer)
  └─ surreal-session-repo.ts  ← SessionRepository
```

### Invariants

- Upstream (`handlers/`, `tools/`, `index.ts`) imports only interfaces and
  DTOs. It never imports `bun:sqlite` or any backend implementation file.
  A backend swap is invisible upstream.
- The `bun:sqlite` `require` appears only inside `src/store/sqlite/`
  (preserving the current single physical import point, just relocated).
- `src/store/repository.ts` is a pure-type file — no side effects, safely
  importable by any layer. This file *is* the seam.

### Untouched

- `src/store/memory-store.ts` (Markdown layer), `src/store/session-anchor-search.ts`,
  `src/store/skill-store.ts` are filesystem/JSONL, not SQLite — untouched.

## Interfaces & DTOs (`src/store/repository.ts`)

### DTOs (backend-neutral, de-`Sqlite`-prefixed, camelCase)

```ts
export type MemoryTarget = 'memory' | 'user' | 'failure';
export type MemoryCategory = 'failure' | 'correction' | 'insight'
  | 'preference' | 'convention' | 'tool-quirk';

export interface MemoryEntry {
  id: number;                 // backend-internal primary key (sqlite=autoincrement rowid; surreal=integer record key)
  project: string | null;
  target: MemoryTarget;
  category: MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;            // ISO date
  lastReferenced: string;
}

export interface MemorySyncInput { /* mirrors today's SqliteMemorySyncInput, de-prefixed */ }
export interface MemorySyncResult { action: 'inserted' | 'existing'; entry: MemoryEntry; }
export interface MemoryUpdateResult { matched: number; updated: number; entries: MemoryEntry[]; }
export interface MemoryRemoveResult { matched: number; removed: number; }

// Session side
export interface SessionRecord { id: string; project: string; cwd: string; startedAt: string; endedAt?: string | null; messageCount: number; }
export interface MessageRecord  { id: string; sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; toolCalls?: string | null; }
export interface SessionFileMeta { path: string; sessionId: string; size: number; mtimeMs: number; indexedAt: string; }
export interface SessionSearchResult { sessionId: string; messageId: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; /* + owning-session fields as needed */ }
```

Field naming moves from snake_case to camelCase (TS convention), on **both**
the memory and session sides (e.g. `started_at`→`startedAt`,
`message_count`→`messageCount`, `session_id`→`sessionId`). The SQL↔DTO
mapping lives **inside each backend** (sqlite keeps `mapRow`; surreal does its
own conversion). The interface surface is always camelCase.

`MemoryEntry.id: number` is backend-internal; its semantics differ per backend
(see "id semantics alignment" in the SurrealDB section). Concrete argument
types for the methods below (e.g. `addMemory` input, `replaceSyncedMemories`
updates, `searchMemories` options) are the de-`Sqlite`-prefixed mirrors of
today's `SqliteMemory*` types in `sqlite-memory-store.ts`, finalized in the
implementation plan — they are not new shapes, just renamed.

### `MemoryRepository` (all async)

Maps one-to-one to today's `sqlite-memory-store.ts` public functions:

```ts
export interface MemoryRepository {
  addMemory(input): Promise<MemoryEntry>;
  syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult>;
  replaceSyncedMemories(oldText: string, updates): Promise<MemoryUpdateResult>;
  removeSyncedMemories(oldText: string, opts): Promise<MemoryRemoveResult>;
  removeExactSyncedMemories(content: string, opts): Promise<MemoryRemoveResult>;
  searchMemories(query: string, opts?): Promise<MemoryEntry[]>;   // raw natural-language string; each backend interprets
  getMemories(opts?): Promise<MemoryEntry[]>;
  getRecentFailures(maxAgeDays?: number, project?: string | null): Promise<MemoryEntry[]>;
  getMemoryStats(): Promise<{ total: number; byProject: { project: string | null; count: number }[]; byTarget: { target: string; count: number }[] }>;
  removeMemory(id: number): Promise<boolean>;
  touchMemory(id: number): Promise<void>;
}
```

`searchMemories(query, opts)` takes the **raw natural-language string**. The
FTS5 logic (`normalizeFts5Query` / `buildFallbackFts5Query`) sinks into the
SQLite backend. The interface exposes no FTS5/`MATCH` concept — the SurrealDB
backend interprets the same string with its own analyzer. This is what makes
search portable.

### `SessionRepository` (all async)

Maps to the data operations of `session-indexer.ts` + `session-search.ts`.
The `indexLiveSession` / `indexCurrentSession` helpers (which derive a
session from a `sessionManager`) stay in the handler layer — they are not
data operations — and call `await repo.indexSession(session)`:

```ts
export interface SessionRepository {
  indexSession(session): Promise<void>;
  indexAllSessions(sessionsDir: string, projectDir?: string): Promise<{ indexed: number; skipped: number }>;
  indexChangedSessions(sessionsDir: string, opts?): Promise<{ indexed: number; skipped: number }>;  // incremental backfill
  upsertSessionFileMeta(filePath: string, sessionId: string, opts?): Promise<void>;
  needsBackfill(sessionsDir: string, now?): Promise<boolean>;
  touchBackfillTimestamp(ts?: string): Promise<void>;
  searchSessions(query: string, opts?): Promise<SessionSearchResult[]>;   // raw query string in, backend interprets
  getIndexedMessageCount(): Promise<number>;
  getSessionStats(): Promise<{ byProject: { project: string | null; sessions: number; messages: number }[] }>;   // mirrors today's getSessionStats shape
}
```

### `Backend` (lifecycle interface)

Abstracts the connection lifecycle of today's `DatabaseManager` (schema init,
close, health). **Corruption self-heal, WAL, PRAGMAs are NOT on the
interface** — they are SQLite-specific and stay inside `SqliteBackend`:

```ts
export interface Backend {
  init(): Promise<void>;        // open connection, build schema/migration, analyzer (surreal)
  close(): Promise<void>;
  healthCheck(): Promise<void>; // sqlite=PRAGMA quick_check; surreal=version/SELECT 1
  // NOTE: no getDb(), no withCorruptionRecovery() — those are impl details
}
```

`withCorruptionRecovery(...)` disappears from all call sites: retry/corruption
recovery becomes an internal responsibility of SQLite backend methods
(wrapped inside `indexSession`/`syncMemoryEntry` etc.). Upstream no longer
needs to know.

## SQLite backend reorganization (Phase 1-2)

### File moves & responsibilities

| Current file | New location | Change |
|---|---|---|
| `store/db.ts` | `store/sqlite/sqlite-backend.ts` | `DatabaseManager` → `SqliteBackend implements Backend`. `getDb()`, `withCorruptionRecovery()`, WAL/PRAGMA, row-by-row corruption rebuild, `pruneStaleBackups` all retained as internal methods. Adds `init()/close()/healthCheck()`. `getDb()` is only used by the two sibling repos in the same folder. |
| `store/schema.ts` | `store/sqlite/schema.ts` | Unchanged (pure SQL string, SQLite-specific, relocated). |
| `store/sqlite-memory-store.ts` | `store/sqlite/sqlite-memory-repo.ts` | Free functions → `class SqliteMemoryRepository implements MemoryRepository`. All methods async. `mapRow` stays here for snake_case→camelCase. `BEGIN IMMEDIATE` dedup logic unchanged. |
| `store/session-indexer.ts` | `store/sqlite/sqlite-session-repo.ts` | `indexSession`/`indexAllSessions`/`indexChangedSessions`/`upsertSessionFileMeta`/backfill bookkeeping → repo methods. `indexLiveSession`/`indexCurrentSession` (taking `sessionManager`) stay in handlers, calling `await repo.indexSession(...)`. |
| `store/session-search.ts` | merged into `sqlite-session-repo.ts` | `searchSessions`/`getIndexedMessageCount` become repo methods. |
| `store/fts-query.ts` | `store/sqlite/fts-query.ts` | Unchanged, SQLite-specific. |

### Decentralizing `withCorruptionRecovery`

Today upstream writes `dbManager.withCorruptionRecovery(() => indexSession(...))`
everywhere. After refactor, each repo method wraps its own corruption recovery
+ transient retry (`runWithTransientRetry` + `withCorruptionRecovery` both
internal to the SQLite backend). Call sites become a plain
`await repo.indexSession(session)`.

### Async propagation

- The 4 store files: sync → async methods.
- ~30 call sites (`handlers/*.ts`, `tools/*.ts`, `index.ts`) add `await`.
  Most handlers are already `async`; they just gain `await` before DA calls.
- `session_shutdown`'s `dbManager.close()` → `await backend.close()`.

### Test strategy (keep 640 tests green)

- Existing tests build via `new DatabaseManager(tmpDir)`. After refactor:
  `new SqliteBackend(tmpDir)` → `await init()` → construct repos. **Assert
  logic unchanged**; only setUp/teardown injection + `await` change.
- `tests/store/db.test.ts` imports `RawDatabase` to open a second connection
  for corruption fixtures — this path is preserved (`RawDatabase` still
  exported from `sqlite-backend.ts`; SQLite-specific tests may touch sqlite
  internals).
- **New:** `tests/store/repository-contract.test.ts` — a shared contract suite
  (add→sync→search→remove golden paths) run against the
  `MemoryRepository`/`SessionRepository` interfaces. The Phase-3 SurrealDB
  backend runs the **same contract**, proving behavioral equivalence.

### Backward compatibility

- `config.dbBackend` defaults to `'sqlite'`; unset = identical behavior,
  identical file (`sessions.db`).
- The physical `bun:sqlite` import stays in exactly one place
  (`src/store/sqlite/`).
- Zero end-user impact — same `MEMORY.md`, same `sessions.db`, same search
  results.

## Config, backend factory, `index.ts` wiring (Phase 1-2 / Phase 3)

### Config (`src/config.ts` + `src/types.ts`)

```ts
// types.ts
export type DbBackend = 'sqlite' | 'surrealdb';
export interface SurrealConnection {
  endpoint: string;    // default http://127.0.0.1:8000
  namespace: string;   // default 'hermes'
  database: string;    // default 'memory'
  username: string;    // default 'root'
  password: string;    // default 'root'
}
// MemoryConfig adds:
//   dbBackend?: DbBackend;            // default 'sqlite'
//   surreal?: Partial<SurrealConnection>;
```

`loadConfig` gains two parse segments (an `isDbBackend` guard + shallow
object merge for `surreal`), following the existing manual field-parse style.
Unset `dbBackend` = today's sqlite behavior verbatim.

### Backend factory (`src/store/backend-factory.ts`)

```ts
export interface BackendBundle {
  backend: Backend;
  memoryRepo: MemoryRepository;
  sessionRepo: SessionRepository;
}
export async function createBackendBundle(config, memoryDir): Promise<BackendBundle> {
  switch (config.dbBackend ?? 'sqlite') {
    case 'sqlite': { /* SqliteBackend + two sqlite repos */ }
    case 'surrealdb': { /* SurrealBackend + two surreal repos (Phase 3) */ }
  }
}
```

The factory and the surreal implementation are Phase 3; the interface is
defined now, and Phase 3 adds a `case`.

### `index.ts` wiring

Today (L113): `const dbManager = new DatabaseManager(globalDir);` then passed
everywhere. Becomes:

```ts
const { backend, memoryRepo, sessionRepo } = await createBackendBundle(config, globalDir);
```

The default export becomes `async function` (option A). **Plan step 0 must
verify that pi's `ExtensionAPI` accepts an async extension entry.** If it
does not, fall back to a lazy `bundleReady` promise barrier (sync entry;
each handler awaits the bundle on first use). This is the single wiring
risk and is listed as the plan's first verification step.

All `registerXxxTool(pi, ..., dbManager, ...)` / `setupXxx(pi, ..., dbManager, ...)`
signatures replace `dbManager: DatabaseManager` with `memoryRepo:
MemoryRepository` (some also take `sessionRepo`). Types move from concrete
class to interface — the concrete realization of "upstream does not know the
backend." `withCorruptionRecovery(...)` wrappers are removed from all call
sites.

## SurrealDB backend design (Phase 3, pure additive)

### Connection (`src/store/surreal/surreal-backend.ts`)

- Uses Bun's built-in `fetch` against `http://127.0.0.1:8000/sql` (POST,
  body=raw SurrealQL, `Content-Type: text/plain`). Response is a JSON array,
  one object per statement; parse `result`.
- **v3 header gotcha:** use `surreal-ns` / `surreal-db` headers (or
  `?ns=&db=` query param); legacy `NS`/`DB` silently 401.
- ns/db default `hermes` / `memory` (lazily created on first write).
  `init()` runs schema bootstrap.
- `Backend` methods: `init()` (connect + bootstrap schema/analyzer/index),
  `close()` (stateless HTTP, effectively no-op, kept for interface
  symmetry), `healthCheck()` (`VERSION()` or `SELECT 1`).
- No connection pool, no WAL, no corruption self-heal — those are SQLite
  file semantics; SurrealDB is a server. `withCorruptionRecovery` has no
  equivalent here; transient errors use HTTP retry (5xx / connection
  failure, exponential backoff).

### Schema mapping (`init()` bootstrap SurrealQL)

SurrealDB's record model, but field semantics align with the contract
(camelCase DTO):

```sql
DEFINE ANALYZER IF NOT EXISTS hermes_en TOKENIZERS class FILTERS snowball(english);
DEFINE INDEX IF NOT EXISTS memory_fts ON TABLE memories FIELDS content FULLTEXT ANALYZER hermes_en;
DEFINE INDEX IF NOT EXISTS message_fts ON TABLE messages FIELDS content FULLTEXT ANALYZER hermes_en;
-- memories / sessions / messages / session_files / extension_metadata are SCHEMALESS tables
--   (same fields as today, camelCase; surreal flexible schema needs no ALTER migration)
```

FTS index auto-syncs on write — no FTS5-style 6 triggers, no `'rebuild'`.

### id semantics alignment (the only semantic seam)

- sqlite: `memories.id` = `INTEGER AUTOINCREMENT` (DTO `id: number`).
- surreal: record id is `memories:<rand>` string. To keep the
  `MemoryEntry.id: number` DTO contract, the SurrealDB backend uses
  **integer record keys** (`memories:<int>`, maintaining a counter in
  `extension_metadata`, or `type::number(record::id(...))`). The contract
  test verifies both backends yield a comparable numeric `id`.
- Fallback (Phase-3 sub-decision): if integer record keys prove too awkward,
  widen the DTO to `id: string`; this cascades a DTO type change and would
  be re-confirmed before adopting.

### Repository implementation notes

- `searchMemories(query)` → `SELECT * FROM memories WHERE content @@ $query
  [AND scope...] ORDER BY lastReferenced DESC LIMIT $n`. `$query` is the raw
  natural-language string (server-side analyzer tokenizes it); `fts-query.ts`
  is NOT called. No-result fallback: SurrealDB has no FTS5 OR-fallback, so
  degrade to `string::contains(content, $term)` (matches today's fallback
  spirit).
- `syncMemoryEntry` (dedup upsert) → SurrealDB **`UPSERT` + `BEGIN
  TRANSACTION / COMMIT`**. Today's cross-connection `BEGIN IMMEDIATE`
  serialization is provided by SurrealDB's transaction isolation — the
  read-then-write stays inside one transaction.
- `addMemory`/`getMemories`/`removeMemory`/`touchMemory`/stats and the
  session side (`indexSession`/`indexAllSessions`/`indexChangedSessions`/
  `upsertSessionFileMeta`/backfill/`searchSessions`/`getIndexedMessageCount`)
  translate directly to SurrealQL (`CREATE`/`SELECT`/`UPDATE`/`DELETE`/
  `UPSERT`/`COUNT`/`GROUP BY`, all supported).
- `INSERT OR IGNORE` → `UPSERT ... WHERE` or `SELECT`-then-`CREATE`;
  `ON CONFLICT DO UPDATE` → `UPSERT`.

### HTTP client / parameter binding

- SurrealQL uses `$param` variable binding (injection-safe) via the `/sql`
  endpoint body with `LET $param := ...;`. A `query(sql, params)` helper
  unifies binding + response parsing + transient retry.

### Behavioral equivalence with sqlite

- The **same `repository-contract.test.ts`** runs against both backends
  (fixture injects `MemoryRepository`/`SessionRepository`). Phase-3 gate:
  contract green = behavioral equivalence.
- Search quality is **not guaranteed byte-identical** (FTS5 vs SurrealDB
  analyzer differences). The contract uses **semantic fixtures** ("runs"/
  "running" must recall) and verifies "both backends recall", not
  "identical ordering".

## Phased delivery, acceptance gates, risk, rollback

### Three phases (spec covers all; implementation lands in phases)

**Phase 1 — Interfaces & DTOs (no behavior change)**
- Add `src/store/repository.ts`, `src/store/backend-factory.ts` (sqlite
  branch only).
- Gate: `bun test` fully green with zero behavior change; `tsc --noEmit`
  passes; no call-site changes.

**Phase 2 — SQLite reorganization + async + wiring (behavior unchanged, engine reorganized)**
- Move 4 files into `src/store/sqlite/`, implement interfaces, go async,
  `index.ts` async entry (**plan step 0 verifies pi accepts async entry**;
  else lazy-init barrier fallback).
- Remove `withCorruptionRecovery` from call sites; internalize in sqlite
  methods.
- Add `repository-contract.test.ts` (sqlite-backed).
- Gate: **640 tests green** (incl. schema-cost regression); `config.dbBackend`
  default sqlite = byte-equivalent to pre-refactor; `bun run check` passes;
  manual `--self-test` confirms `sessions.db` still reads old data.
- **Mergeable at end of Phase 2** — invisible to users, seam in place.

**Phase 3 — SurrealDB backend (pure additive)**
- Add `src/store/surreal/*`, factory `surrealdb` case, config `surreal`
  connection fields.
- `init()` bootstraps analyzer + fulltext index + table schema.
- Same `repository-contract.test.ts` runs against the surreal backend
  (requires local `:8000` service; CI uses sqlite, surreal contract is a
  local/manual gate).
- Gate: surreal contract green; `config.dbBackend:'surrealdb'` runs
  `memory_search`/`session_search` end-to-end.

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| pi extension entry rejects `async function` | step 0 verifies; else lazy `bundleReady` barrier. Fallback exists. |
| ~30 call-site async conversions missed → compile error | `strict` tsc is the guard (a missing `await` returning a Promise breaks at the interface type); contract + 640 existing tests double-cover. |
| Async changes alter `session_shutdown` close ordering | shutdown handler is already `async`; `await backend.close()` replaces sync `close()`, ordering preserved (last DB handler). Flagged as a key verification in the plan. |
| SurrealDB `id: number` contract | integer record key + contract test; widen to `id: string` if too hard (Phase-3 sub-decision). |
| SurrealDB search quality differs from FTS5 | contract uses semantic fixtures verifying "recall", not "byte-identical ordering"; documented as acceptable. |
| Cross-package typecheck (REQUIRED CI) | any type lie red-lights the whole repo; interfaces/DTOs must pass `strict`. |
| Breaking the single `bun:sqlite` import point | lint/check ensures `bun:sqlite` only under `src/store/sqlite/`. |

### Rollback

- Phase 2: `config.dbBackend` defaults sqlite and is behavior-equivalent →
  revert the PR directly, no data risk (same `sessions.db`).
- Phase 3: pure additive and default-off → a problem affects no one; revert
  or leave.

### Explicit YAGNI (not done)

- Do NOT abstract a shared "term extraction" layer (unless both backends
  end up using it during implementation).
- Do NOT build corruption self-heal / WAL / backup pruning for SurrealDB.
- Do NOT build a multi-backend runtime switch UI — one config flag decides.
- Do NOT touch the Markdown layer (`memory-store.ts`) or the
  skill/session-anchor filesystem layers.
