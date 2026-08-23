# Hermes Memory Backend Abstraction (Phase 1 + 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a backend-neutral repository interface over `pi-agent-ext-hermes-memory`'s SQLite layer and reorganize the SQLite implementation behind it — behavior byte-equivalent, 640 tests green — so a SurrealDB backend can be added later as a pure additive change.

**Architecture:** Repository/domain interfaces (`MemoryRepository`, `SessionRepository`, `Backend`) + DTOs in a pure-type seam (`src/store/repository.ts`). The current four SQLite files reorganize into `src/store/sqlite/` as `SqliteBackend` + two repository classes. Upstream handlers/tools stop receiving `DatabaseManager` and instead receive the interface types. All data-access methods become `async` (forced by the future remote SurrealDB model). `index.ts` becomes an `async function` entry.

**Tech Stack:** TypeScript (strict), Bun, `bun:sqlite`, `@earendil-works/pi-coding-agent` ExtensionAPI. Tests: `bun test`.

**Scope:** This plan covers **Phase 1 (interfaces + config types, no behavior change) and Phase 2 (SQLite reorganization + async + wiring + contract test, behavior byte-equivalent)**. **Phase 3 (the SurrealDB backend in `src/store/surreal/`) is a separate follow-up plan** — it is pure additive, default-off, depends on the local SurrealDB server, and the spec marks it a distinct cycle. Phase 2's gate (640 green + byte-equivalent) is a complete, mergeable deliverable on its own.

**Spec refinement vs. the design doc:** the design placed `backend-factory.ts` in Phase 1, but the factory must return `MemoryRepository`/`SessionRepository` instances, which do not exist until the SQLite repos are built. This plan therefore moves the factory into Phase 2 (Task 7). No change to the architecture or interfaces.

## Global Constraints

- **Conversation/written language:** discussion in zh_TW; ALL written output (code, comments, commit messages, file content) in English.
- **Python venv / run.py** are irrelevant here — this is a Bun/TS package. Run package tests with `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. Typecheck with `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check`.
- **No top-level `cd`** — `no-cd-drift.sh` blocks it. Use `( cd <dir> && ... )`, `--cwd`, or absolute paths.
- **`bun:sqlite` import confinement:** the `require('bun:sqlite')` may appear ONLY under `src/store/sqlite/`. After this plan, verify with `grep -rn "bun:sqlite" src` → exactly one hit, inside `src/store/sqlite/`.
- **Cross-package typecheck is a REQUIRED CI check** (see memory `test-pi-agent-required-cross-package-typecheck`): a type lie in this package red-lights the whole repo. Every task must keep `bun run check` (`tsc --noEmit`, strict) green.
- **Behavior byte-equivalence (Phase 2 gate):** with `config.dbBackend` unset/default (`'sqlite'`), `sessions.db`, `MEMORY.md`, and all search results must be identical to pre-refactor. The 640 existing tests are the primary guard.
- **TDD + frequent commits.** Commit after every task.

## Pre-flight (already verified — do not re-derive)

- **pi accepts an async extension entry.** SDK type `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>` (`@earendil-works/pi-coding-agent` `dist/core/extensions/types.d.ts:1072`); the loader does `await factory(api)` (`dist/core/extensions/loader.js:373` and `:389`). So `export default async function (pi: ExtensionAPI) { ... }` is valid and awaited. No lazy barrier needed. (Spec's option A confirmed.)
- **The four files that physically touch SQL** are `src/store/db.ts`, `src/store/sqlite-memory-store.ts`, `src/store/session-indexer.ts`, `src/store/session-search.ts`. `src/store/fts-query.ts` is pure (FTS5 query-string builder). `src/store/schema.ts` is a pure SQL string. `memory-store.ts`, `session-anchor-search.ts`, `skill-store.ts` are filesystem/JSONL — untouched.
- **`bun:sqlite` is imported in exactly one place** today: `src/store/db.ts:114` (`createBunCompatDatabaseCtor`).

---

## File Structure

### Created
- `src/store/repository.ts` — **the seam.** Pure types: DTOs + `MemoryRepository` + `SessionRepository` + `Backend` interfaces. Zero implementation, zero imports of any backend.
- `src/store/backend-factory.ts` — `BackendBundle` type + `createBackendBundle(config, memoryDir)`. Phase 2 ships the `sqlite` branch; the `surrealdb` branch is added in the Phase 3 plan.
- `src/store/sqlite/sqlite-backend.ts` — `SqliteBackend implements Backend` (relocated + adapted from `db.ts`). Owns connection, schema init, WAL/PRAGMA, corruption self-heal, `pruneStaleBackups`. Exposes `getDb()` for sibling repos only.
- `src/store/sqlite/sqlite-memory-repo.ts` — `SqliteMemoryRepository implements MemoryRepository` (relocated + async-ified from `sqlite-memory-store.ts`).
- `src/store/sqlite/sqlite-session-repo.ts` — `SqliteSessionRepository implements SessionRepository` (relocated + async-ified from `session-indexer.ts` + `session-search.ts`).
- `src/store/sqlite/schema.ts` — verbatim relocation of `src/store/schema.ts`.
- `src/store/sqlite/fts-query.ts` — verbatim relocation of `src/store/fts-query.ts`.
- `tests/store/repository-contract.test.ts` — shared golden-path contract suite run against any `MemoryRepository`/`SessionRepository`.

### Deleted (after relocations + import updates)
- `src/store/db.ts`, `src/store/sqlite-memory-store.ts`, `src/store/session-indexer.ts`, `src/store/session-search.ts`, `src/store/schema.ts`, `src/store/fts-query.ts`.

### Modified
- `src/types.ts` — add `DbBackend`, `SurrealConnection`; extend `MemoryConfig`.
- `src/config.ts` — parse `dbBackend` + `surreal`; add to `DEFAULT_CONFIG`.
- `src/index.ts` — `async function` entry; replace `new DatabaseManager(...)` with `await createBackendBundle(...)`; pass interfaces to handlers/tools.
- `src/tools/{memory-tool,memory-search-tool,session-search-tool,grill-decision-tool}.ts` — accept `MemoryRepository`/`SessionRepository` instead of `DatabaseManager`; await method calls.
- `src/handlers/{background-review,correction-detector,error-detector,session-backfill,session-live-index,index-sessions,sync-markdown-memories}.ts` — same signature + await changes.
- `tests/store/db.test.ts`, `tests/store/sqlite-memory-store.test.ts`, `tests/store/session-*.test.ts`, `tests/tools/*.test.ts`, `tests/handlers/*.test.ts` — swap `new DatabaseManager(tmpDir)` → `new SqliteBackend(tmpDir)` + `await init()` + construct repos; add `await` before DA calls.

---

## Task 1: Repository interfaces + DTOs (the seam)

**Files:**
- Create: `src/store/repository.ts`
- Test: `tests/store/repository.test.ts`

**Interfaces:**
- Consumes: `MemoryCategory` from `src/types.ts` (reuse; do not duplicate).
- Produces: `MemoryTarget`, `MemoryCategory` (re-export), `MemoryEntry`, `MemorySyncInput`, `MemorySyncResult`, `MemoryUpdateResult`, `MemoryRemoveResult`, `MemoryRemoveOptions`, `MemorySearchOptions`, `MemoryListOptions`, `MemoryStats`, `SessionRecord`, `MessageRecord`, `SessionFileMeta`, `SessionSearchResult`, `SessionStats`, `MemoryRepository`, `SessionRepository`, `Backend`.

- [ ] **Step 1: Write the type-level test**

Create `tests/store/repository.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type {
  MemoryRepository, SessionRepository, Backend,
  MemoryEntry, MemorySyncInput,
} from "../../src/store/repository.js";

describe("repository seam (types)", () => {
  it("a minimal object satisfies MemoryRepository", () => {
    const repo: MemoryRepository = {
      async addMemory() { return {} as MemoryEntry; },
      async syncMemoryEntry(_input: MemorySyncInput) { return { action: "inserted", entry: {} as MemoryEntry }; },
      async replaceSyncedMemories() { return { matched: 0, updated: 0, entries: [] }; },
      async removeSyncedMemories() { return { matched: 0, removed: 0 }; },
      async removeExactSyncedMemories() { return { matched: 0, removed: 0 }; },
      async searchMemories() { return []; },
      async getMemories() { return []; },
      async getRecentFailures() { return []; },
      async getMemoryStats() { return { total: 0, byProject: [], byTarget: [] }; },
      async removeMemory() { return false; },
      async touchMemory() { return; },
    };
    expect(typeof repo.searchMemories).toBe("function");
  });

  it("Backend has init/close/healthCheck only", () => {
    const backend: Backend = {
      async init() { return; },
      async close() { return; },
      async healthCheck() { return; },
    };
    expect(typeof backend.init).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository.test.ts )`
Expected: FAIL — `Cannot find module '../../src/store/repository.js'`.

- [ ] **Step 3: Create `src/store/repository.ts`**

```ts
/**
 * Backend-neutral repository seam for pi-hermes-memory.
 * Pure types only — no implementation, no backend imports.
 * This file IS the abstraction boundary: upstream imports only from here.
 */

export type MemoryTarget = "memory" | "user" | "failure";
export type { MemoryCategory } from "../types.js";

export interface MemoryEntry {
  id: number;
  project: string | null;
  target: MemoryTarget;
  category: import("../types.js").MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
}

export interface MemorySyncInput {
  content: string;
  target: MemoryTarget;
  project?: string | null;
  category?: import("../types.js").MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
}

export interface MemorySyncResult { action: "inserted" | "existing"; entry: MemoryEntry; }
export interface MemoryUpdateResult { matched: number; updated: number; entries: MemoryEntry[]; }
export interface MemoryRemoveResult { matched: number; removed: number; }
export interface MemoryRemoveOptions { target: MemoryTarget; project?: string | null; }
export interface MemorySearchOptions { project?: string | null; target?: MemoryTarget; category?: import("../types.js").MemoryCategory; limit?: number; }
export interface MemoryListOptions { project?: string | null; target?: MemoryTarget; category?: import("../types.js").MemoryCategory; }
export interface MemoryStats { total: number; byProject: { project: string | null; count: number }[]; byTarget: { target: string; count: number }[]; }

export interface MemoryRepository {
  addMemory(input: {
    content: string; target?: MemoryTarget; project?: string | null;
    category?: import("../types.js").MemoryCategory | null;
    failureReason?: string | null; toolState?: string | null; correctedTo?: string | null;
    created?: string; lastReferenced?: string;
  }): Promise<MemoryEntry>;
  syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult>;
  replaceSyncedMemories(oldText: string, updates: {
    content: string; target: MemoryTarget; project?: string | null;
    category?: import("../types.js").MemoryCategory | null;
    failureReason?: string | null; toolState?: string | null; correctedTo?: string | null;
    lastReferenced?: string | null;
  }): Promise<MemoryUpdateResult>;
  removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  removeExactSyncedMemories(content: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  getMemories(options?: MemoryListOptions): Promise<MemoryEntry[]>;
  getRecentFailures(maxAgeDays?: number, project?: string | null): Promise<MemoryEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
  removeMemory(id: number): Promise<boolean>;
  touchMemory(id: number): Promise<void>;
}

export interface SessionRecord { id: string; project: string; cwd: string; startedAt: string; endedAt: string | null; messageCount: number; }
export interface MessageRecord { id: string; sessionId: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; toolCalls: string | null; }
export interface SessionFileMeta { path: string; sessionId: string; size: number; mtimeMs: number; indexedAt: string; }
export interface SessionSearchResult { sessionId: string; messageId: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; project: string; cwd: string; }
export interface SessionStats { byProject: { project: string | null; sessions: number; messages: number }[]; }

export interface SessionRepository {
  indexSession(session: { id: string; project?: string; cwd?: string; startedAt?: string; messages?: unknown[] }): Promise<void>;
  indexAllSessions(sessionsDir: string, projectDir?: string): Promise<{ indexed: number; skipped: number }>;
  indexChangedSessions(sessionsDir: string, options?: { maxFilesToIndex?: number }): Promise<{ indexed: number; skipped: number; reachedLimit: boolean }>;
  upsertSessionFileMeta(filePath: string, sessionId: string, options?: { size?: number; mtimeMs?: number }): Promise<void>;
  needsBackfill(sessionsDir: string, now?: number): Promise<boolean>;
  touchBackfillTimestamp(timestamp?: string): Promise<void>;
  searchSessions(query: string, options?: { project?: string | null; role?: "user" | "assistant" | "system"; limit?: number }): Promise<SessionSearchResult[]>;
  getIndexedMessageCount(): Promise<number>;
  getSessionStats(): Promise<SessionStats>;
}

/**
 * Backend lifecycle. NO getDb(), NO withCorruptionRecovery() — those are
 * SQLite implementation details. Retry/corruption recovery is internal to
 * each backend's repository methods.
 */
export interface Backend {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<void>;
}

export interface BackendBundle {
  backend: Backend;
  memoryRepo: MemoryRepository;
  sessionRepo: SessionRepository;
}
```

> **Note on `indexSession` input shape:** the concrete session object passed in is the parsed Pi session (today's `sessionData`). Task 6 will adapt the current `indexSession(dbManager, session)` body to read camelCase fields off this object; if the parsed shape uses different keys, map them at the call site in the handler (Task 8), not in the interface. The interface intentionally uses camelCase.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository.test.ts )`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/repository.ts tests/store/repository.test.ts
git commit -m "feat(hermes-memory): add backend-neutral repository seam (interfaces + DTOs)"
```

---

## Task 2: Config types for backend selection

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DbBackend`, `SurrealConnection`; `MemoryConfig.dbBackend`, `MemoryConfig.surreal`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts` (follow its existing `describe`/`it` style):

```ts
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config dbBackend", () => {
  it("defaults to sqlite when unset", () => {
    const cfg = loadConfig(join(tmpdir(), `hm-cfg-${Date.now()}.json`));
    expect(cfg.dbBackend).toBe("sqlite");
  });
  it("parses dbBackend: surrealdb and surreal connection overrides", () => {
    const p = join(tmpdir(), `hm-cfg-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({
      dbBackend: "surrealdb",
      surreal: { endpoint: "http://db:8000", namespace: "ns1", database: "db1" },
    }));
    const cfg = loadConfig(p);
    expect(cfg.dbBackend).toBe("surrealdb");
    expect(cfg.surreal?.endpoint).toBe("http://db:8000");
    expect(cfg.surreal?.namespace).toBe("ns1");
    rmSync(p, { force: true });
  });
  it("rejects unknown dbBackend and falls back to default", () => {
    const p = join(tmpdir(), `hm-cfg-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ dbBackend: "mongodb" }));
    const cfg = loadConfig(p);
    expect(cfg.dbBackend).toBe("sqlite");
    rmSync(p, { force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts )`
Expected: FAIL — `cfg.dbBackend` is `undefined`.

- [ ] **Step 3: Add types to `src/types.ts`**

```ts
export type DbBackend = "sqlite" | "surrealdb";
export interface SurrealConnection {
  endpoint: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
}
```
Add to `MemoryConfig`:
```ts
  dbBackend?: DbBackend;
  surreal?: Partial<SurrealConnection>;
```

- [ ] **Step 4: Wire parsing in `src/config.ts`**

Add a guard near the other `is*` helpers:
```ts
const DB_BACKENDS: readonly DbBackend[] = ["sqlite", "surrealdb"];
function isDbBackend(value: unknown): value is DbBackend {
  return typeof value === "string" && DB_BACKENDS.includes(value as DbBackend);
}
```
Add to `DEFAULT_CONFIG`:
```ts
  dbBackend: "sqlite",
```
Inside `loadConfig`'s parse block (after the `sessionSearch` parse), add:
```ts
      if (isDbBackend(parsed.dbBackend)) config.dbBackend = parsed.dbBackend;
      if (typeof parsed.surreal === "object" && parsed.surreal !== null) {
        const s = parsed.surreal as Record<string, unknown>;
        const surreal: Record<string, string> = {};
        for (const key of ["endpoint", "namespace", "database", "username", "password"] as const) {
          if (typeof s[key] === "string") surreal[key] = s[key] as string;
        }
        config.surreal = surreal;
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts )`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite still green**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check && ( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: check passes; full suite green (no behavior change).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(hermes-memory): add dbBackend config + surreal connection parsing"
```

---

## Task 3: Relocate pure SQLite files (schema, fts-query) into `sqlite/`

This is a pure move + import-path update. It establishes the `src/store/sqlite/` home before the heavier relocations.

**Files:**
- Create: `src/store/sqlite/schema.ts` (verbatim copy of `src/store/schema.ts`)
- Create: `src/store/sqlite/fts-query.ts` (verbatim copy of `src/store/fts-query.ts`)
- Modify: importers of the two moved files (only `src/store/db.ts` imports `./schema.js`; `sqlite-memory-store.ts` imports `./fts-query.js`). At this stage update those two imports to `./sqlite/schema.js` and `./sqlite/fts-query.js`.
- Delete: `src/store/schema.ts`, `src/store/fts-query.ts`

- [ ] **Step 1: Copy the two files verbatim into `src/store/sqlite/`**

```bash
mkdir -p src/store/sqlite
cp src/store/schema.ts src/store/sqlite/schema.ts
cp src/store/fts-query.ts src/store/sqlite/fts-query.ts
```

- [ ] **Step 2: Update the two internal imports**

In `src/store/db.ts`: change `import { SCHEMA_SQL } from "./schema.js";` → `from "./sqlite/schema.js";`.
In `src/store/sqlite-memory-store.ts`: change `import { ... } from "./fts-query.js";` → `from "./sqlite/fts-query.js";`.

- [ ] **Step 3: Delete the old files**

```bash
rm src/store/schema.ts src/store/fts-query.ts
```

- [ ] **Step 4: Typecheck + full suite green**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check && ( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: green. (If any test imported the moved modules directly, update those import paths too — grep: `grep -rn "store/fts-query\|store/schema" src tests`.)

- [ ] **Step 5: Commit**

```bash
git add -A src/store
git commit -m "refactor(hermes-memory): relocate schema + fts-query into src/store/sqlite/"
```

---

## Task 4: `SqliteBackend` from `db.ts`

Convert `DatabaseManager` into `SqliteBackend implements Backend`. Keep behavior identical. The class keeps all current internals; we add `init()`/`healthCheck()` (async, to satisfy `Backend`) and make `close()` async-compatible. `getDb()` stays (sibling repos + `db.test.ts` use it).

**Files:**
- Create: `src/store/sqlite/sqlite-backend.ts` (adapted from `src/store/db.ts`)
- Delete: `src/store/db.ts`
- Modify: every importer of `./db.js` / `../db.js` (tests + the three store files that will move in Tasks 5–6; for now they still import from `db.ts`'s old location — update them to `./sqlite/sqlite-backend.js`). Concretely: `grep -rn "store/db" src tests`.

**Interfaces:**
- Consumes: `Backend` from `repository.ts`, `SCHEMA_SQL` from `./schema.js`.
- Produces: `SqliteBackend implements Backend`; re-exports `DatabaseLike`, `RawDatabase`, `isTransientDbError`, `runWithTransientRetry`, `withCorruptionRecovery` helper (the class method), `DatabaseRecoveryResult`.

- [ ] **Step 1: Adapt the class**

Copy `src/store/db.ts` → `src/store/sqlite/sqlite-backend.ts`. Then:

1. Rename class `DatabaseManager` → `SqliteBackend`. Add a deprecated alias so in-flight tests/imports don't break during this task: `export const DatabaseManager = SqliteBackend;` (removed in Task 10 cleanup).
2. Implement `Backend`:
```ts
  async init(): Promise<void> {
    this.getDb(); // triggers open() + schema init lazily, same as today
  }
  async healthCheck(): Promise<void> {
    const db = this.getDb();
    const rows = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
    const ok = rows.length > 0 && String(Object.values(rows[0])[0] ?? "").toLowerCase() === "ok";
    if (!ok) throw new Error("SQLite quick_check failed");
  }
```
3. `close()` already exists and is sync. Add an async-safe path without changing existing callers yet:
```ts
  // existing close() stays; Backend.close is async:
  async closeAsync(): Promise<void> { this.close(); }
```
   Then satisfy the interface with a tiny adapter in the factory (Task 7) OR make `close()` itself async. **Decision: keep `close()` sync (db.test.ts and index.ts call it sync today) and add `async healthCheck`/`init`.** The `Backend` interface requires `close(): Promise<void>`; resolve in Task 7's factory by wrapping: the `BackendBundle.backend` exposes an adapter `{ init, close: async () => backend.close(), healthCheck }`. Document this.

4. Update internal imports in the file: `from "./schema.js"` stays (now correct since the file is in `sqlite/`).

- [ ] **Step 2: Update all importers**

For every file matching `grep -rln "store/db\|from \"./db\|from \"../db" src tests`:
- `src/store/sqlite-memory-store.ts`: `from "../db.js"` → `from "./sqlite/sqlite-backend.js"` (the `DatabaseLike` type import too).
- `src/store/session-indexer.ts`, `src/store/session-search.ts`: same.
- `tests/store/db.test.ts`: `from "../../src/store/db.js"` → `from "../../src/store/sqlite/sqlite-backend.js"`; keep `import { RawDatabase as Database }` working (re-export it).
- Any other test importing `DatabaseManager`: now resolves via the alias.

- [ ] **Step 3: Delete `src/store/db.ts`**

```bash
rm src/store/db.ts
```

- [ ] **Step 4: Typecheck + full suite green**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check && ( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: green. `bun:sqlite` still imported exactly once (now in `sqlite-backend.ts`).

- [ ] **Step 5: Commit**

```bash
git add -A src/store tests/store
git commit -m "refactor(hermes-memory): DatabaseManager → SqliteBackend (implements Backend)"
```

---

## Task 5: `SqliteMemoryRepository` (async)

Wrap the free functions of `sqlite-memory-store.ts` into `class SqliteMemoryRepository implements MemoryRepository`. Methods are `async` (bodies unchanged — `bun:sqlite` calls are sync; just `return` the value from an `async` method). Internalize `withCorruptionRecovery` + `runWithTransientRetry` around each public method (this is where call-site wrappers get absorbed).

**Files:**
- Create: `src/store/sqlite/sqlite-memory-repo.ts`
- Delete: `src/store/sqlite-memory-store.ts`
- Modify: importers of `sqlite-memory-store.js` → point at the new module (handled in Task 8 sweep). **For this task**, keep a thin re-export shim at the old path so the build stays green: create `src/store/sqlite-memory-store.ts` that re-exports adapter functions delegating to a repo instance? **No** — the old free functions take `dbManager`; the new API takes a repo. Instead, do the import-switch in Task 8 and accept that this task + Task 8 land together. To keep each task independently green, this task creates the new repo class AND keeps `sqlite-memory-store.ts` intact (not deleted yet). Deletion happens in Task 8 once call sites migrate.

**Interfaces:**
- Consumes: `SqliteBackend` (for `getDb()`, `withCorruptionRecovery`), `MemoryRepository` + DTOs from `../repository.js`, `fts-query` helpers, `memory-lookup`.
- Produces: `SqliteMemoryRepository`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/sqlite-memory-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";

describe("SqliteMemoryRepository", () => {
  let dir: string; let backend: SqliteBackend; let repo: SqliteMemoryRepository;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hm-mem-"));
    backend = new SqliteBackend(dir);
    await backend.init();
    repo = new SqliteMemoryRepository(backend);
  });
  afterEach(() => { backend.close(); rmSync(dir, { recursive: true, force: true }); });

  it("addMemory + getMemories round-trip", async () => {
    const entry = await repo.addMemory({ content: "use pnpm not npm", target: "failure" });
    expect(entry.id).toBeGreaterThan(0);
    const list = await repo.getMemories({ target: "failure" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("use pnpm not npm");
  });

  it("syncMemoryEntry is idempotent (dedup)", async () => {
    const a = await repo.syncMemoryEntry({ content: "x", target: "memory" });
    const b = await repo.syncMemoryEntry({ content: "x", target: "memory" });
    expect(a.action).toBe("inserted");
    expect(b.action).toBe("existing");
    expect(a.entry.id).toBe(b.entry.id);
  });

  it("searchMemories recalls by term", async () => {
    await repo.addMemory({ content: "the quick brown fox", target: "memory" });
    const hits = await repo.searchMemories("quick");
    expect(hits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store/sqlite/sqlite-memory-repo.ts`**

Strategy: copy the bodies of the existing free functions verbatim into async methods, mapping snake_case rows → camelCase DTOs via an internal `mapRow`. Constructor takes `SqliteBackend`. Each public method wraps its body in `this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => { ... }))` — absorbing the call-site wrapper.

Skeleton (fill every method from the original file; this shows the pattern for `addMemory`, `syncMemoryEntry`, `searchMemories`; repeat the pattern for the rest):

```ts
import type { SqliteBackend } from "./sqlite-backend.js";
import type {
  MemoryRepository, MemoryEntry, MemorySyncInput, MemorySyncResult,
  MemoryUpdateResult, MemoryRemoveResult, MemoryRemoveOptions,
  MemorySearchOptions, MemoryListOptions, MemoryStats, MemoryTarget,
} from "../repository.js";
import type { MemoryCategory } from "../../types.js";
import { buildFallbackFts5Query, isFts5QueryError, normalizeFts5Query } from "./fts-query.js";
import { normalizeMemoryLookupText } from "../memory-lookup.js";

// (copy verbatim from sqlite-memory-store.ts: today(), normalizeNullable,
//  normalizeCategory, FAILURE_CATEGORY_SET, runExclusive, parseMetadataComment,
//  formatFailureMemoryContent, parseMarkdownMemoryEntry — the pure helpers
//  stay exported for any non-DB callers.)

function mapRow(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as number,
    project: (row.project as string | null) ?? null,
    target: row.target as MemoryTarget,
    category: (row.category as MemoryCategory | null) ?? null,
    content: row.content as string,
    failureReason: (row.failure_reason as string | null) ?? null,
    toolState: (row.tool_state as string | null) ?? null,
    correctedTo: (row.corrected_to as string | null) ?? null,
    created: row.created as string,
    lastReferenced: row.last_referenced as string,
  };
}

export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly backend: SqliteBackend) {}

  private get db() { return this.backend.getDb(); }

  async addMemory(input: {
    content: string; target?: MemoryTarget; project?: string | null;
    category?: MemoryCategory | null; failureReason?: string | null;
    toolState?: string | null; correctedTo?: string | null;
    created?: string; lastReferenced?: string;
  }): Promise<MemoryEntry> {
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
      // body copied verbatim from today's addMemory(), using input.* defaults,
      // returning a MemoryEntry (camelCase). lastInsertRowid via result.lastInsertRowid.
      ...
    }));
  }

  async syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult> {
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
      // body copied from syncMemoryEntry(): the runExclusive(db, ...) dedup
      // block stays; map rows via mapRow; call this.addMemory(...) for the
      // insert branch and this.getMemoryById for the return.
    }));
  }

  async searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    // body copied from searchMemories(); uses normalizeFts5Query/buildFallbackFts5Query
    // (unchanged — these are the SQLite-specific FTS5 builders, now local).
  }
  // … repeat for: getMemories, getRecentFailures, getMemoryStats,
  //   removeMemory, touchMemory, replaceSyncedMemories,
  //   removeSyncedMemories, removeExactSyncedMemories, getMemoryById (private).
}
```

> The bodies are mechanical copies of today's functions with: (a) `dbManager.getDb()` → `this.db`; (b) snake_case row objects → `mapRow`; (c) the `withCorruptionRecovery`/`runWithTransientRetry` wrapper added once per public method. No query logic changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + full suite green**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check && ( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: green (old `sqlite-memory-store.ts` still exists and is still used by handlers until Task 8 — both coexist).

- [ ] **Step 6: Commit**

```bash
git add src/store/sqlite/sqlite-memory-repo.ts tests/store/sqlite-memory-repo.test.ts
git commit -m "feat(hermes-memory): SqliteMemoryRepository (async, absorbs corruption-recovery wrapper)"
```

---

## Task 6: `SqliteSessionRepository` (async)

Same pattern as Task 5, merging `session-indexer.ts` + `session-search.ts` into `class SqliteSessionRepository implements SessionRepository`.

**Files:**
- Create: `src/store/sqlite/sqlite-session-repo.ts`
- (Defer deletion of `session-indexer.ts` / `session-search.ts` to Task 8.)

**Interfaces:**
- Consumes: `SqliteBackend`, `SessionRepository` + DTOs, `session-parser` (pure), filesystem helpers already used by indexer.
- Produces: `SqliteSessionRepository`.

> **`indexSession` input shape:** today `indexSession(dbManager, session)` reads fields like `session.id`, `session.messages`, `session.cwd` directly off the parsed Pi session object. The interface (Task 1) types the param as `{ id, project?, cwd?, startedAt?, messages? }` in camelCase. **In the implementation, read the real parsed-session fields and map to the schema columns** (the same columns as today). Keep the on-disk schema column names unchanged (snake_case) — only the DTO/method surface is camelCase. The handler (Task 8) passes the parsed session through unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/store/sqlite-session-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteSessionRepository } from "../../src/store/sqlite/sqlite-session-repo.js";

describe("SqliteSessionRepository", () => {
  let dir: string; let backend: SqliteBackend; let repo: SqliteSessionRepository;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hm-sess-"));
    backend = new SqliteBackend(dir);
    await backend.init();
    repo = new SqliteSessionRepository(backend);
  });
  afterEach(() => { backend.close(); rmSync(dir, { recursive: true, force: true }); });

  it("indexSession + searchSessions round-trip", async () => {
    await repo.indexSession({
      id: "sess-1", project: "demo", cwd: "/tmp/demo", startedAt: "2026-07-22T00:00:00Z",
      messages: [{ id: "m1", role: "user", content: "deploy with bun", timestamp: "2026-07-22T00:00:01Z" }] as any,
    });
    const hits = await repo.searchSessions("bun");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe("sess-1");
  });

  it("getIndexedMessageCount counts messages", async () => {
    await repo.indexSession({ id: "s2", messages: [{ id: "m", role: "user", content: "hi", timestamp: "t" }] as any });
    expect(await repo.getIndexedMessageCount()).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store/sqlite/sqlite-session-repo.ts`**

Merge the bodies of `session-indexer.ts` (`indexSession`, `indexAllSessions`, `indexChangedSessions`, `upsertSessionFileMetadata`→`upsertSessionFileMeta`, `needsBackfill`, `touchBackfillTimestamp`→`touchBackfillTimestamp`, `getSessionStats`) and `session-search.ts` (`searchSessions`, `getIndexedMessageCount`) into async methods. Wrap each public method in `this.backend.withCorruptionRecovery(() => runWithTransientRetry(...))`. Map rows → DTOs. Keep all SQL identical.

Note: `indexAllSessions`/`indexChangedSessions` today read the sessions dir and call `parseSessionFile` + `indexSession` internally — that orchestration stays inside the repo method.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite green**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check && ( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/store/sqlite/sqlite-session-repo.ts tests/store/sqlite-session-repo.test.ts
git commit -m "feat(hermes-memory): SqliteSessionRepository (async, merges indexer + search)"
```

---

## Task 7: Backend factory + `index.ts` async wiring

**Files:**
- Create: `src/store/backend-factory.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `BackendBundle`, `Backend` from `repository.js`; `SqliteBackend`, `SqliteMemoryRepository`, `SqliteSessionRepository`; `MemoryConfig`.
- Produces: `createBackendBundle(config, memoryDir): Promise<BackendBundle>`.

- [ ] **Step 1: Create `src/store/backend-factory.ts`**

```ts
import type { BackendBundle, Backend } from "./repository.js";
import { SqliteBackend } from "./sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "./sqlite/sqlite-memory-repo.js";
import { SqliteSessionRepository } from "./sqlite/sqlite-session-repo.js";
import type { MemoryConfig } from "../types.js";

export async function createBackendBundle(config: MemoryConfig, memoryDir: string): Promise<BackendBundle> {
  switch (config.dbBackend ?? "sqlite") {
    case "sqlite": {
      const sqlite = new SqliteBackend(memoryDir);
      await sqlite.init();
      // Adapter so Backend.close() is async while SqliteBackend.close() stays sync.
      const backend: Backend = {
        init: async () => { await sqlite.init(); },
        close: async () => { sqlite.close(); },
        healthCheck: async () => { await sqlite.healthCheck(); },
      };
      return {
        backend,
        memoryRepo: new SqliteMemoryRepository(sqlite),
        sessionRepo: new SqliteSessionRepository(sqlite),
      };
    }
    case "surrealdb":
      // Phase 3 (separate plan).
      throw new Error("SurrealDB backend is not implemented yet (Phase 3).");
  }
}
```

- [ ] **Step 2: Typecheck (factory compiles standalone)**

Run: `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check`
Expected: green.

- [ ] **Step 3: Commit the factory**

```bash
git add src/store/backend-factory.ts
git commit -m "feat(hermes-memory): createBackendBundle factory (sqlite branch)"
```

> `index.ts` wiring is done in Task 8 together with the call-site sweep, because changing `index.ts` to use repos requires the handler/tool signatures (Task 8) to accept repos — otherwise it will not typecheck. Tasks 7 and 8 are intentionally ordered so the factory exists first.

---

## Task 8: Call-site sweep — signatures → interfaces, async, remove `withCorruptionRecovery` wrappers

This is the large mechanical task. **Transformation rule (apply uniformly):**

1. **Signature:** every `registerXxx`/`setupXxx`/internal helper that takes `dbManager: DatabaseManager` (or `DatabaseManager | null`) now takes `memoryRepo: MemoryRepository` and/or `sessionRepo: SessionRepository` (same nullability). Drop the `DatabaseManager` import; import the interface type from `../store/repository.js`.
2. **Call form:** `syncMemoryEntry(dbManager, { ... })` → `await memoryRepo.syncMemoryEntry({ ... })`. `searchMemories(dbManager, q, opts)` → `await memoryRepo.searchMemories(q, opts)`. `indexSession(dbManager, s)` → `await sessionRepo.indexSession(s)`. Etc. — one await per call, field names already match the DTOs (camelCase).
3. **`withCorruptionRecovery` wrappers removed:** `dbManager.withCorruptionRecovery(() => indexSession(...))` → `await sessionRepo.indexSession(...)` (recovery is now internal to the repo method).
4. **Containing function async-ness:** if a handler callback body now uses `await`, the callback must be `async`. Most already are.

**Files & exact changes:**

| File | Signature change | Call changes |
|---|---|---|
| `src/tools/memory-search-tool.ts` | `registerMemorySearchTool(pi, memoryRepo: MemoryRepository)` | `getMemoryStats(dbManager)` → `await memoryRepo.getMemoryStats()`; `searchMemories(...)` → `await memoryRepo.searchMemories(...)`; `touchMemory(...)` → `await memoryRepo.touchMemory(...)` |
| `src/tools/session-search-tool.ts` | `registerSessionSearchTool(pi, sessionRepo, config)`; internal `registerLegacySessionSearchTool(pi, sessionRepo)` | `getIndexedMessageCount` → `await sessionRepo.getIndexedMessageCount()`; `searchSessions` → `await sessionRepo.searchSessions(...)` |
| `src/tools/grill-decision-tool.ts` | `dbManager: DatabaseManager \| null` → `memoryRepo: MemoryRepository \| null` | `syncMemoryEntry(dbManager,{...})` → `memoryRepo && await memoryRepo.syncMemoryEntry({...})` |
| `src/tools/memory-tool.ts` | all internal `sync*ToSqlite(...dbManager...)` helpers → take `memoryRepo`; `registerMemoryTool(pi, store, projectStore, memoryRepo, projectName)` | each `syncAddToSqlite/ syncReplaceToSqlite/ syncEvictionsFromSqlite/ syncRemoveFromSqlite` body calls the repo methods (awaited); `removeExactSyncedMemories(dbManager,...)` → `await memoryRepo.removeExactSyncedMemories(...)` |
| `src/handlers/correction-detector.ts` | `setupCorrectionDetector(pi, store, projectStore, config, memoryRepo, projectName)` | `syncMemoryEntry(dbManager,{...})` → `await memoryRepo.syncMemoryEntry({...})` |
| `src/handlers/error-detector.ts` | `setupErrorDetector(pi, store, projectStore, config, memoryRepo, projectName)` | same `syncMemoryEntry` change |
| `src/handlers/background-review.ts` | `setupBackgroundReview(pi, store, projectStore, config, { memoryRepo, projectName })` (replace `dbManager` in the opts object) | any `addMemory`/`searchMemories`/`getRecentFailures` calls → awaited repo calls |
| `src/handlers/session-backfill.ts` | `scheduleSessionBackfill(sessionRepo, sessionsDir, opts)` — replace `dbManager` + the injected `needsBackfillFn`/`indexSessionsFn`/`touchBackfillTimestampFn` with direct repo method calls (await) | `needsBackfillFn(dbManager,...)` → `await sessionRepo.needsBackfill(...)`; `indexSessionsFn(...)` → `await sessionRepo.indexChangedSessions(...)`; `touchBackfillTimestampFn(dbManager)` → `await sessionRepo.touchBackfillTimestamp()` |
| `src/handlers/session-live-index.ts` | `scheduleLiveSessionIndex(sessionRepo, sessionManager, opts)` | `indexLiveSession` orchestration calls `await sessionRepo.indexSession(...)`; if it derives the session from `sessionManager`, keep that derivation, pass result to `indexSession` |
| `src/handlers/index-sessions.ts` | `registerIndexSessionsCommand(pi, memoryDir, config)` — the command creates its own bundle via `await createBackendBundle(config, memoryDir)` instead of `new DatabaseManager(memoryDir)`, then uses `sessionRepo` | `indexAllSessions` → `await sessionRepo.indexAllSessions(...)` |
| `src/handlers/sync-markdown-memories.ts` | `registerSyncMarkdownMemoriesCommand(pi, memoryRepo, ...)`; `syncMarkdownMemoriesToSqlite(memoryRepo, ...)` → async | the backfill loop calls `await memoryRepo.syncMemoryEntry(...)`; `index.ts` startup call becomes `await syncMarkdownMemoriesToSqlite(memoryRepo, ...)` |

- [ ] **Step 1: Update `src/index.ts` to async entry + factory + pass repos**

Change the default export to `async function` and replace `new DatabaseManager(globalDir)`:

```ts
import { createBackendBundle } from "./store/backend-factory.js";

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  // ... existing globalDir resolution unchanged ...
  const { backend, memoryRepo, sessionRepo } = await createBackendBundle(config, globalDir);

  // startup backfill (was sync try/catch):
  try {
    await syncMarkdownMemoriesToSqlite(memoryRepo, globalDir, config.projectsMemoryDir, agentRoot);
  } catch { /* best-effort */ }

  // pass memoryRepo/sessionRepo to register/setup calls instead of dbManager:
  registerMemoryTool(pi, store, projectStore, memoryRepo, projectName);
  registerGrillDecisionTool(pi, store, memoryRepo);
  setupBackgroundReview(pi, store, projectStore, config, { memoryRepo, projectName: projectName || null });
  setupCorrectionDetector(pi, store, projectStore, config, memoryRepo, projectName);
  setupErrorDetector(pi, store, projectStore, config, memoryRepo, projectName);
  registerSyncMarkdownMemoriesCommand(pi, memoryRepo, globalDir, config.projectsMemoryDir, agentRoot);
  registerMemorySearchTool(pi, memoryRepo);
  registerSessionSearchTool(pi, sessionRepo, config.sessionSearch ?? { variant: "legacy" });
  registerIndexSessionsCommand(pi, globalDir, config);

  // session_start handler: scheduleSessionBackfill(sessionRepo, ...)
  pi.on("session_start", async (_event, ctx) => {
    // ... existing migration/skill/load code ...
    scheduleSessionBackfill(sessionRepo, sessionsDir, { notify: ... });
  });

  // message_end: scheduleLiveSessionIndex(sessionRepo, ...)
  pi.on("message_end", async (_event, ctx) => {
    scheduleLiveSessionIndex(sessionRepo, ctx.sessionManager, { onError: ... });
  });

  // session_shutdown: await repo methods; await backend.close()
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile && require("node:fs").existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          await sessionRepo.indexSession(sessionData);
          await sessionRepo.upsertSessionFileMeta(sessionFile, sessionData.id);
        }
      }
    } catch { /* silent */ } finally {
      try {
        await Promise.all([ waitForSessionBackfill(...), waitForLiveSessionIndex(...) ]);
      } catch { /* best effort */ }
      try { await backend.close(); } catch { /* best effort */ }
    }
  });
}
```

> The `withCorruptionRecovery(() => { indexSession(...); upsertSessionFileMetadata(...); })` block in the shutdown handler is gone — both calls are now awaited repo methods with recovery internalized.

- [ ] **Step 2: Apply the signature + call changes in every file in the table above**

Work file-by-file. After each file, run `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check` to catch type errors immediately (a missed `await` returns a `Promise` and breaks at the interface type).

- [ ] **Step 3: Update tests that call the changed register/setup helpers**

For each `tests/tools/*.test.ts` and `tests/handlers/*.test.ts` that constructs a `DatabaseManager` and passes it to a `register`/`setup` function: build `const backend = new SqliteBackend(dir); await backend.init(); const memoryRepo = new SqliteMemoryRepository(backend); const sessionRepo = new SqliteSessionRepository(backend);` and pass the repos. Add `await` before DA calls inside test bodies. (This is mechanical; the test assertions themselves do not change.)

- [ ] **Step 4: Delete the old free-function store files**

```bash
rm src/store/sqlite-memory-store.ts src/store/session-indexer.ts src/store/session-search.ts
```
Remove the `DatabaseManager` alias export added in Task 4 (search for `export const DatabaseManager`).

- [ ] **Step 5: Verify confinement + typecheck + full suite**

Run:
```bash
grep -rn "bun:sqlite" src                         # expect exactly 1 hit, in src/store/sqlite/sqlite-backend.ts
grep -rln "DatabaseManager" src                    # expect 0 hits (alias removed)
bun run --cwd bun-apps/pi-agent-ext-hermes-memory check
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
```
Expected: 1 sqlite hit; 0 DatabaseManager hits; check green; **640 tests green**.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "refactor(hermes-memory): wire upstream to repository interfaces; async sweep; internalize withCorruptionRecovery"
```

---

## Task 9: Shared repository contract test

A golden-path suite run against `MemoryRepository`/`SessionRepository` (currently only the SQLite impl; the Phase-3 SurrealDB impl will run the same suite). This is the equivalence benchmark.

**Files:**
- Create: `tests/store/repository-contract.test.ts`

**Interfaces:**
- Consumes: `MemoryRepository`, `SessionRepository` from `src/store/repository.js`.
- Produces: a reusable contract suite function (so Phase 3 can call it with a surreal repo).

- [ ] **Step 1: Write the contract suite**

```ts
import { describe, it, expect } from "bun:test";
import type { MemoryRepository, SessionRepository } from "../../src/store/repository.js";

// Factory lets Phase 3 reuse this exact suite against a SurrealDB backend.
export function runMemoryRepositoryContract(
  name: string,
  make: () => Promise<{ repo: MemoryRepository; close: () => Promise<void> }>,
) {
  describe(`${name} MemoryRepository contract`, () => {
    it("add → get → search → remove lifecycle", async () => {
      const { repo, close } = await make();
      try {
        const entry = await repo.addMemory({ content: "bun install not npm install", target: "correction" as any, category: "correction" });
        expect(entry.id).toBeGreaterThan(0);
        const got = await repo.getMemories({ target: "correction" as any });
        expect(got.find((m) => m.id === entry.id)).toBeTruthy();

        const hits = await repo.searchMemories("bun install");
        expect(hits.some((m) => m.id === entry.id)).toBe(true);

        const removed = await repo.removeMemory(entry.id);
        expect(removed).toBe(true);
      } finally {
        await close();
      }
    });

    it("syncMemoryEntry dedups by identity", async () => {
      const { repo, close } = await make();
      try {
        const a = await repo.syncMemoryEntry({ content: "shared lesson", target: "memory" });
        const b = await repo.syncMemoryEntry({ content: "shared lesson", target: "memory" });
        expect(a.action).toBe("inserted");
        expect(b.action).toBe("existing");
        expect(a.entry.id).toBe(b.entry.id);
      } finally { await close(); }
    });

    it("search recalls morphological variants (stemming)", async () => {
      const { repo, close } = await make();
      try {
        await repo.addMemory({ content: "the service was running slowly", target: "memory" });
        const hits = await repo.searchMemories("runs"); // snowball stems runs≈run≈running
        expect(hits.length).toBeGreaterThanOrEqual(1);
      } finally { await close(); }
    });
  });
}

// SQLite instantiation of the contract:
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

runMemoryRepositoryContract("SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-contract-"));
  const backend = new SqliteBackend(dir);
  await backend.init();
  return {
    repo: new SqliteMemoryRepository(backend),
    close: async () => { backend.close(); rmSync(dir, { recursive: true, force: true }); },
  };
});
```

> A `runSessionRepositoryContract` sibling covers `indexSession → searchSessions → getIndexedMessageCount` and incremental backfill, structured identically.

- [ ] **Step 2: Run the contract suite**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/store/repository-contract.test.ts
git commit -m "test(hermes-memory): shared repository contract suite (SQLite; reusable for SurrealDB)"
```

---

## Task 10: Final verification + cleanup

- [ ] **Step 1: Full typecheck + full test suite**

Run:
```bash
bun run --cwd bun-apps/pi-agent-ext-hermes-memory check
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
```
Expected: `tsc` green; **all tests pass (target: 640+ green, no skips added)**.

- [ ] **Step 2: Behavior byte-equivalence smoke check**

Manual: pick an existing real `sessions.db` + `MEMORY.md` from a prior session, run the extension's self-test, and confirm memory search / session search return the same results as before. Command pattern (adjust paths):
```bash
# ensure dbBackend is unset (defaults to sqlite) — do NOT set config.dbBackend
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/flow.test.ts )
```
Expected: integration flow green.

- [ ] **Step 3: Confinement re-check**

Run:
```bash
grep -rn "bun:sqlite" src        # exactly 1 hit: src/store/sqlite/sqlite-backend.ts
grep -rln "withCorruptionRecovery\|dbManager" src   # 0 hits in handlers/tools/index; only inside sqlite/*
```
Expected: as stated.

- [ ] **Step 4: Cross-package typecheck canary**

Per memory `test-pi-agent-required-cross-package-typecheck`, this package feeds a repo-wide required check. Run the package check (Step 1) — it is the relevant gate. If repo CI has a dedicated cross-package tsc step, confirm it is not broken by these changes (no new type exports that disagree across packages).

- [ ] **Step 5: Commit any remaining cleanup + update docs**

```bash
git add -A
git commit -m "chore(hermes-memory): final cleanup after backend-abstraction refactor"
```

Update `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` "Extended store" / "Sessions" sections to note the repository seam (one line each). Commit:
```bash
git add bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md
git commit -m "docs(hermes-memory): note repository seam in CONTEXT.md"
```

---

## Self-Review (run after writing — results)

**1. Spec coverage:**
- Repository/domain interface (Approach A) → Task 1. ✓
- DTOs de-`Sqlite`-prefixed, camelCase, both memory + session sides → Task 1. ✓
- `MemoryRepository`/`SessionRepository`/`Backend` interfaces → Task 1. ✓
- SQLite reorganization into `src/store/sqlite/` (db.ts, sqlite-memory-store.ts, session-indexer.ts, session-search.ts, schema.ts, fts-query.ts) → Tasks 3–6. ✓
- async conversion of all DA + ~30 call sites → Tasks 5, 6, 8. ✓
- `withCorruptionRecovery` removed from call sites, internalized → Tasks 5, 6 (wrapper) + Task 8 (call-site removal). ✓
- Config `dbBackend` + `surreal` → Task 2. ✓
- Backend factory (sqlite branch) → Task 7. ✓
- `index.ts` async entry (option A, pre-flight confirmed) → Task 8 Step 1. ✓
- `repository-contract.test.ts` → Task 9. ✓
- 640 tests green + byte-equivalence gate → Task 10. ✓
- `bun:sqlite` single import point → Task 10 Step 3. ✓
- **Phase 3 (SurrealDB backend):** deliberately out of scope — separate plan (documented at top). ✓

**2. Placeholder scan:** No "TBD"/"TODO". Task 5/6 intentionally say "copy the body verbatim" with a concrete skeleton + the exact transformation rule — this is the honest representation of a mechanical port of existing, in-tree code (not a placeholder; the source bodies already exist in the files being relocated). The sweep in Task 8 is a complete enumerated table, not "similar to…".

**3. Type consistency:** `MemoryRepository`/`SessionRepository`/`Backend`/`BackendBundle` names are identical in Task 1 (definition) and Tasks 5–8 (consumption). `createBackendBundle` consistent (Task 7 def, Task 8 use). `SqliteBackend.init/healthCheck` (Task 4) match `Backend` (Task 1) via the Task 7 adapter; `close` async-wrapping documented. DTO field names (`failureReason`, `lastReferenced`, `sessionId`, `startedAt`, `messageCount`) consistent across Task 1 and the `mapRow`/mappings in Tasks 5–6.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-hermes-memory-backend-abstraction.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
