# Hermes Memory — SurrealDB Backend (Phase 3) Design

**Date:** 2026-07-22
**Package:** `bun-apps/pi-agent-ext-hermes-memory`
**Status:** Design (pending implementation plan)
**Builds on:** `docs/superpowers/specs/2026-07-22-hermes-memory-backend-abstraction-design.md`
(Phase 1 + 2 — the repository seam — merged in PR #752)

## Context

Phase 1 + 2 introduced a backend-neutral repository seam over the SQLite
layer and shipped it with byte-equivalent SQLite behavior. The
`createBackendBundle` factory's `surrealdb` branch currently throws
`"SurrealDB backend is not implemented yet (Phase 3)."`. This spec defines
Phase 3: implementing that branch as a **pure additive, default-off**
SurrealDB backend.

Three sub-decisions were confirmed during brainstorming (all match the
Phase 1+2 spec's defaults):

1. **`MemoryEntry.id: number` stays.** SurrealDB uses integer record keys
   (`memories:<int>`) with a counter, so the already-merged interface and
   contract test are untouched.
2. **Raw `fetch` against the `/sql` endpoint.** No new dependency — Bun's
   built-in `fetch`, `LET $param` variable binding. Matches the offline /
   no-external-service constraints.
3. **No SQLite → SurrealDB data migration.** The SurrealDB backend starts
   empty; the Markdown layer (`memory-store.ts`) remains the truth source
   and existing `syncMarkdownMemoriesToSqlite` re-feeds memory through the
   `MemoryRepository`, while sessions re-index on first run.

## Scope & invariants

- **Pure additive.** New files under `src/store/surreal/*`; the
  `backend-factory.ts` `surrealdb` branch changes from throw to
  instantiation. `config.dbBackend` defaults to `'sqlite'`; unset =
  behavior identical to today.
- **Upstream is unaware.** `handlers/`, `tools/`, `index.ts` are not
  modified — they consume only `MemoryRepository` / `SessionRepository`.
  A backend swap is invisible upstream.
- **Markdown layer untouched.** `memory-store.ts` stays the source of
  truth. In surrealdb mode the existing markdown→repo sync refills
  memory on startup.
- **No SQLite data migration.** SurrealDB mode boots an empty database.

## Confirmed environment

The local SurrealDB service is **v3.2.3**, resident on `127.0.0.1:8000`
(`root`/`root`, LaunchAgent-managed). Health endpoint returns 200. See the
SurrealDB service reference memory for install/service details.

## Module layout

```
src/store/surreal/
├─ surreal-client.ts      ← fetch /sql wrapper: query(sql, params) → parse + transient retry
├─ surreal-backend.ts     ← implements Backend: init/close/healthCheck + schema bootstrap
├─ surreal-memory-repo.ts ← implements MemoryRepository
├─ surreal-session-repo.ts← implements SessionRepository
└─ schema.ts              ← SurrealQL DDL (analyzer + fulltext index + tables), pure string
```

## SurrealClient (`/sql` + variable binding + retry)

A single `SurrealClient` exposes:

```ts
query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]>
```

- Transport: `POST http://127.0.0.1:8000/sql`, `Content-Type: text/plain`.
- **v3 headers:** `surreal-ns: hermes`, `surreal-db: memory`,
  `surreal-user`/`surreal-pass` (basic). The legacy short `NS`/`DB`
  headers silently 401 in v3. Namespaces/databases are lazily created on
  first write.
- **Variable binding:** parameters are bound by prepending
  `LET $name := <json>;` statements to the request body (the standard
  `/sql` binding mechanism). Values are `JSON.stringify`-encoded, which is
  injection-safe SurrealQL. `null`/number/bool/object/array all encode
  correctly.
- **Response parsing:** the `/sql` body is a JSON array with one object
  per statement (`{ status, result }`). `result` for a query is an array
  of record objects; for DDL/count it is the affected payload. On any
  statement whose `status !== "OK"` (or whose `result` is a string error),
  throw an `Error` carrying the first error `result` string. The client
  returns the last statement's `result` (array) by default, or a tuple of
  all statement results when the caller needs multiple.
- **Transient retry:** connection failure / 5xx / timeout → exponential
  backoff retry with jitter (bounded attempts), handled **inside the
  client** so repository methods just call `client.query()` and inherit
  retry. This replaces SQLite's `runWithTransientRetry` +
  `withCorruptionRecovery` role — a server has no file-corruption
  semantics, so there is no corruption layer and repo methods need no
  extra wrapper.
- `close()`: HTTP is stateless, so this is effectively a no-op, kept for
  interface symmetry.

## Backend + schema bootstrap (`init()`)

`SurrealBackend implements Backend`. `init()` runs an idempotent DDL block
(pure additive, re-entrant):

```sql
DEFINE ANALYZER IF NOT EXISTS hermes_en TOKENIZERS class FILTERS snowball(english);
DEFINE TABLE IF NOT EXISTS memories SCHEMALESS;
DEFINE TABLE IF NOT EXISTS sessions SCHEMALESS;
DEFINE TABLE IF NOT EXISTS messages SCHEMALESS;
DEFINE TABLE IF NOT EXISTS session_files SCHEMALESS;
DEFINE TABLE IF NOT EXISTS extension_metadata SCHEMALESS;
DEFINE INDEX IF NOT EXISTS memory_fts ON TABLE memories FIELDS content FULLTEXT ANALYZER hermes_en;
DEFINE INDEX IF NOT EXISTS message_fts ON TABLE messages FIELDS content FULLTEXT ANALYZER hermes_en;
```

- `FULLTEXT ANALYZER` is the **v3.0+ syntax** (the old `SEARCH ANALYZER`
  clause was renamed in 3.0).
- Fields are camelCase (aligned with the DTO; SCHEMALESS flexible schema
  needs no ALTER migration).
- The FTS index **auto-syncs on write** — no FTS5 external-content virtual
  table, no 6 sync triggers, no `'rebuild'` command.
- `healthCheck()` = `SELECT 1` (or `VERSION()`).
- `close()` = no-op (HTTP stateless).

## id semantics: stored `seq` field (DTO unchanged)

> Verified against the live v3.2.3 server during plan research: passing a
> number to `type::record("memories", n)` produces an **array-encoded**
> record id (`memories:[1]`), which breaks `record::id` → number extraction.
> So integer record keys are NOT used. Instead:

- The DTO `MemoryEntry.id: number` is stored as a plain integer field
  `seq` on each `memories` record. The actual record key is SurrealDB's
  native random id (opaque). `removeMemory(id)` / `touchMemory(id)`
  address records via `WHERE seq = $id`.
- The `seq` counter lives in a dedicated `seq:memory` record (`value`
  field). Allocation is atomic:
  `LET $next = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0];`
  — the `[0]` unwrap is REQUIRED (`RETURN VALUE` wraps in a single-element
  array; without `[0]` the value is stored as `[1]`).
- `init()` bootstraps the counter idempotently:
  `IF array::len((SELECT id FROM seq:memory)) = 0 { CREATE seq:memory SET value = 0; }`
- `MemoryEntry.id: number` contract is **untouched**. The contract test
  asserts `id > 0`, which `seq` satisfies directly.

## Repository implementation map

| Interface method | SurrealQL technique |
|---|---|
| `addMemory` | `LET $next = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0]; CREATE memories SET seq=$next, ... RETURN seq, ...` |
| `syncMemoryEntry` (dedup) | TS-side SELECT by identity → if found `UPDATE … WHERE seq=$seq`, else `addMemory`. (Verified `UPSERT … WHERE` always inserts, so dedup is SELECT-then-branch.) |
| `replaceSyncedMemories` / `removeSyncedMemories` | `WHERE string::contains(content, $old) [AND scope]` → `UPDATE`/`DELETE` (mirrors SQLite `LIKE`) |
| `removeExactSyncedMemories` | `WHERE content = $c [AND scope]` → `DELETE` |
| `searchMemories` | `WHERE content @@ $query [AND scope] ORDER BY lastReferenced DESC LIMIT $n`; on no results, degrade to `string::contains(content, $term)` |
| `getMemories` / `getRecentFailures` / `getMemoryStats` | `SELECT` / `count()` / `GROUP BY` with scope conditions |
| `removeMemory` / `touchMemory` | `DELETE FROM memories WHERE seq = $id` / `UPDATE memories SET lastReferenced = $t WHERE seq = $id` |
| `indexSession` | upsert `sessions:<id>` + `CREATE messages` per message (messages carry denormalized `project`/`cwd` for single-table search) |
| `indexAllSessions` / `indexChangedSessions` | walk sessions dir, dedup by `session_files` mtime/size (same logic as SQLite), `indexSession` per file |
| `searchSessions` | `WHERE content @@ $query` on messages (denormalized project/cwd) |
| `upsertSessionFileMeta` / `needsBackfill` / `touchBackfillTimestamp` / `getIndexedMessageCount` / `getSessionStats` | `UPSERT`/`SELECT`/`count()`/`GROUP BY` |

- `fts-query.ts` (the FTS5 boolean-DSL builder) is **never called** on the
  surreal side. The `@@` operator runs the query string through the same
  server-side analyzer as the index — this is what makes search portable.
- Transient retry is handled inside `SurrealClient.query()` (see above); no
  corruption layer exists for a server backend.

Scope-condition helpers (target / project / category → WHERE fragments) are
shared pure logic; the SQLite backend's `buildScopeConditions` shape is
mirrored but emits SurrealQL `AND` clauses.

## Config (already merged in Phase 1)

`config.ts` already parses `dbBackend` and a shallow `surreal` object
(`endpoint`, `namespace`, `database`, `username`, `password`). Defaults:

```ts
surreal = { endpoint: "http://127.0.0.1:8000", namespace: "hermes",
            database: "memory", username: "root", password: "root" };
```

`SurrealBackend` accepts `config.surreal ?? {}` and fills defaults itself.

## Backend factory wiring

```ts
case "surrealdb": {
  const backend = new SurrealBackend(config.surreal ?? {});
  await backend.init();                 // bootstrap analyzer + index + tables
  return {
    backend,
    memoryRepo: new SurrealMemoryRepository(backend),
    sessionRepo: new SurrealSessionRepository(backend),
  };
}
```

`index.ts` is unchanged (it already destructures the bundle and awaits
`createBackendBundle`).

## Testing strategy

- **Reuse `tests/store/repository-contract.test.ts`.** Add
  `tests/store/surreal-repository-contract.test.ts` that calls
  `runMemoryRepositoryContract("SurrealDB", make)` and
  `runSessionRepositoryContract("SurrealDB", make)`, where `make()` opens a
  `SurrealBackend`, runs `init()`, and `close()`s it. This is the
  behavioral-equivalence benchmark.
- **Local-only gate.** The SurrealDB contract requires the local `:8000`
  service. CI runs only the SQLite contract. The surreal test file probes
  the service at import time and `describe.skip`s (or `it.skip`s) when it
  is absent, so a missing service never red-lights CI.
- **SurrealClient unit tests.** Mock `fetch` to assert: correct v3 headers
  (`surreal-ns`/`surreal-db`), `LET`-binding body assembly, response-array
  parsing (including the error-result throw path), and transient-retry
  behavior on 5xx / connection failure.
- **Namespace hygiene.** Each contract `make()` uses a throwaway SurrealDB
  database (e.g. `memory_test_<nonce>`) so concurrent runs do not collide,
  and drops it on `close()`.
- **Acceptance gate:** surreal contract green; manual run with
  `config.dbBackend: "surrealdb"` exercises `memory_search` /
  `session_search` end-to-end.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Search quality differs from FTS5 (snowball stemmer vs unicode61) | Contract asserts semantic recall, not byte-identical ordering. Documented acceptable. |
| `id: number` integer-key counter races under concurrency | Single `BEGIN TRANSACTION` UPSERT-increment; SurrealDB transaction isolation serializes it (mirrors SQLite `BEGIN IMMEDIATE`). |
| `/sql` multi-statement response parsing edge cases | SurrealClient unit tests cover OK / error / multi-statement shapes. |
| Local service absent in CI | Test file skips when the service probe fails; CI stays SQLite-only. |
| Cross-package typecheck (REQUIRED CI) | Every new file `implements` the existing interfaces; must pass `bun run --cwd bun-apps/pi-agent typecheck`. |
| v3 header/auth gotcha | SurrealClient sets `surreal-ns`/`surreal-db`/`surreal-user`/`surreal-pass`; covered by unit test. |

## Rollback

Pure additive and default-off: a problem affects no one. Revert the PR or
leave it — `config.dbBackend` still defaults to `'sqlite'`.

## Explicit YAGNI (not done)

- Do NOT build a SQLite → SurrealDB data migration (markdown + session
  re-indexing refill the empty DB).
- Do NOT abstract a shared term-extraction layer; the server analyzer
  tokenizes.
- Do NOT build corruption self-heal / WAL / backup pruning for SurrealDB.
- Do NOT add a runtime backend-switch UI — one config flag decides.
- Do NOT widen `MemoryEntry.id` to string (integer record keys preserve
  the contract).
