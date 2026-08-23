# Per-Session Assembly Log (Prompt-Provenance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, once per session at `session_start`, the set of `md_id`s assembled into the injected memory block + a SHA-256 of the rendered block, so we can answer "which sessions saw memory M?" — the missing prompt-provenance half (UPSP §5 cheap tier).

**Architecture:** Pure assembly-manifest methods on `MemoryStore` harvest `md_id`s from the *same* entries each renderer uses (set↔hash consistency). A `buildPromptAssembly(...)` builder unions the global + project manifests and SHA-256s the joined block. A new `recordAssembly(...)` on `SessionRepository` writes a normalized FK-free `session_assembly(session_id, md_id)` table + a `session_assembly_meta(session_id, hash)` table (both SQLite + Surreal; neither touches `sessions`). The `session_start` handler captures once, best-effort.

**Tech Stack:** TypeScript (Bun), `bun:sqlite`, SurrealDB, `node:crypto` (sync SHA-256). Package: `bun-apps/pi-agent-ext-hermes-memory`.

## Global Constraints

- **Backend parity is mandatory:** every schema + repo change lands on SQLite (`src/store/sqlite/`) AND Surreal (`src/store/surreal/`) — never one only.
- **Capture is best-effort:** a capture failure MUST NOT abort agent startup (wrap in try/catch; mirror the `backfillStableIds` guard at `src/index.ts:314`).
- **`buildPromptContext`'s signature stays unchanged** (no ripple to `src/index.ts:331` or `src/handlers/preview-context.ts`); add a sibling `buildPromptAssembly`, don't mutate the existing one.
- **Per-session, once:** capture fires at `session_start` (after `loadFromDisk`), NOT per `before_agent_start`. Upsert is idempotent (delete-then-insert).
- **No new user-facing tool/command** in this plan (DB-level query only).
- Run all tests from the package root: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. Contract: `bun test tests/extension-contract.test.ts`.
- The five design decisions (D1–D5) and verified code sites live in `spec.md` — read it before starting.

---

### Task 1: Store assembly-manifest methods (pure, set↔hash consistent)

**Files:**
- Modify: `src/store/memory-store.ts` (add two methods near `formatForSystemPrompt` ~`:1260` and `formatProjectBlock` ~`:1290`)
- Test: `tests/store/memory-store.test.ts` (EDIT)

**Interfaces:**
- Consumes: `this.memoryEntries` / `this.userEntries` / `this.getActiveFailureEntries(maxAgeDays)` (`:663`), `this.decodeEntry(raw)` (returns `{ id, ... }`), `this.config.failureInjectionEnabled` / `failureInjectionMaxAgeDays` / `failureInjectionMaxEntries`, `DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS` / `DEFAULT_FAILURE_INJECTION_MAX_ENTRIES` (same constants `formatForSystemPrompt` uses at `:1271-1272`).
- Produces: `MemoryStore.getAssemblyManifest(): { block: string; mdIds: string[] }` and `MemoryStore.getProjectAssemblyManifest(projectName: string): { block: string; mdIds: string[] }`.

- [ ] **Step 1: Write the failing test** (append to `tests/store/memory-store.test.ts`)

```ts
import { describe, test, expect } from "bun:test";
// ... existing imports; reuse the file's existing MemoryStore construction helper / fixture.
// If the file has a `makeStore(entries)` helper, use it; otherwise build a tmp-dir store like
// the other tests in this file do (see how an existing test constructs MemoryStore).

describe("MemoryStore assembly manifest", () => {
  test("getAssemblyManifest block equals formatForSystemPrompt and ids match the rendered entries", async () => {
    const store = /* construct a MemoryStore loaded with 2 memory + 1 user + 1 active failure
                     entry, each carrying a frontmatter `id` (use serializeMetadataFrontmatter
                     or the file's existing frontmatter fixture helper) */;
    await store.loadFromDisk();

    const manifest = store.getAssemblyManifest();

    // (D2) block is EXACTLY what the agent is injected with:
    expect(manifest.block).toBe(store.formatForSystemPrompt());
    // ids are the unique md_ids of memory + user + post-filter active failures:
    const expected = new Set<string>([
      /* ids of the 2 memory + 1 user + 1 failure entries */
    ]);
    expect(new Set(manifest.mdIds)).toEqual(expected);
  });

  test("getProjectAssemblyManifest block equals formatProjectBlock and ids match project memory", async () => {
    const store = /* construct + loadFromDisk with project-memory entries carrying ids */;
    const name = "demo";
    const manifest = store.getProjectAssemblyManifest(name);
    expect(manifest.block).toBe(store.formatProjectBlock(name));
    expect(manifest.mdIds).toEqual(/* unique project-memory ids */);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )`
Expected: FAIL — `getAssemblyManifest is not a function` (compile error / type error).

- [ ] **Step 3: Implement the two methods** (in `src/store/memory-store.ts`, right after `formatProjectBlock`)

```ts
/**
 * Prompt-provenance manifest (UPSP §5): the rendered block (== formatForSystemPrompt())
 * PLUS the md_id set of EXACTLY the entries that block was built from — memory + user +
 * post-filter active failures. Same selection logic as formatForSystemPrompt so the logged
 * id set and any hash over `block` are consistent by construction. Failure filtering mirrors
 * formatForSystemPrompt's call-site config (active-only, maxAge, maxEntries).
 */
getAssemblyManifest(): { block: string; mdIds: string[] } {
  const block = this.formatForSystemPrompt();
  const ids: string[] = [];
  const pushIds = (entries: string[]) => {
    for (const raw of entries) {
      const id = this.decodeEntry(raw).id;
      if (id) ids.push(id);
    }
  };
  pushIds(this.memoryEntries);
  pushIds(this.userEntries);
  if (this.config.failureInjectionEnabled !== false) {
    const maxAgeDays = this.config.failureInjectionMaxAgeDays ?? DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS;
    const maxFailures = this.config.failureInjectionMaxEntries ?? DEFAULT_FAILURE_INJECTION_MAX_ENTRIES;
    pushIds(this.getActiveFailureEntries(maxAgeDays).slice(0, maxFailures));
  }
  return { block, mdIds: [...new Set(ids)] };
}

/**
 * Project-memory assembly manifest: the rendered project block (== formatProjectBlock())
 * PLUS the md_id set of the project-memory entries it renders. Mirrors formatProjectBlock's
 * selection (memoryEntries of the project store instance).
 */
getProjectAssemblyManifest(projectName: string): { block: string; mdIds: string[] } {
  const block = this.formatProjectBlock(projectName);
  const ids: string[] = [];
  for (const raw of this.memoryEntries) {
    const id = this.decodeEntry(raw).id;
    if (id) ids.push(id);
  }
  return { block, mdIds: [...new Set(ids)] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts
git commit -m "feat(hermes): add MemoryStore assembly-manifest methods (prompt-provenance, UPSP §5)"
```

---

### Task 2: `buildPromptAssembly` builder (pure, SHA-256 receipt)

**Files:**
- Modify: `src/prompt-context.ts` (add `buildPromptAssembly` alongside `buildPromptContext`)
- Test: `tests/prompt-context.test.ts` (NEW)

**Interfaces:**
- Consumes: `store.getAssemblyManifest()` + `projectStore.getProjectAssemblyManifest(name)` (Task 1); `config.memoryMode`.
- Produces: `buildPromptAssembly(config, store, projectStore, projectName): { mdIds: string[]; hash: string } | null`. `buildPromptContext` is NOT modified.

- [ ] **Step 1: Write the failing test** (`tests/prompt-context.test.ts`, NEW)

```ts
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildPromptAssembly, buildPromptContext } from "../src/prompt-context.js";
// import a minimal MemoryStore stub or a real tmp-dir MemoryStore (see tests/store helpers).
// If stubbing, implement getAssemblyManifest/getProjectAssemblyManifest returning fixed blocks+ids.

describe("buildPromptAssembly", () => {
  test("populated store → unions ids + sha256 of joined memoryBlock+projectBlock", async () => {
    const store = /* MemoryStore whose getAssemblyManifest() = { block: "M", mdIds: ["a","b"] } */;
    const projectStore = /* getProjectAssemblyManifest("p") = { block: "P", mdIds: ["b","c"] } */;
    const config = { memoryMode: "default" } as any;

    const got = buildPromptAssembly(config, store, projectStore, "p")!;

    expect(got.mdIds.sort()).toEqual(["a", "b", "c"]);            // unioned + deduped
    const expectedHash = createHash("sha256").update("M\n\nP", "utf8").digest("hex");
    expect(got.hash).toBe(expectedHash);
  });

  test("policy-only mode → null", () => {
    const got = buildPromptAssembly({ memoryMode: "policy-only" } as any, store, null, "p");
    expect(got).toBeNull();
  });

  test("empty store (no block) → null", () => {
    const store = /* getAssemblyManifest() = { block: "", mdIds: [] } */;
    expect(buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/prompt-context.test.ts )`
Expected: FAIL — `buildPromptAssembly is not a function`.

- [ ] **Step 3: Implement** (in `src/prompt-context.ts`)

```ts
import { createHash } from "node:crypto";
// keep existing imports; DO NOT change buildPromptContext.

/**
 * Prompt-provenance receipt (UPSP §5 request_body_sha256 analogue). Returns the unioned
 * md_id set across all injected blocks + a SHA-256 of the joined memory+project block —
 * mirroring buildPromptContext's assembly so the logged set and hash describe the exact
 * text the agent is injected with (policy text excluded; it is constant config, not memory).
 * Returns null for policy-only mode or an empty assembly (nothing to prove).
 *
 * Sync: node:crypto's createHash is synchronous, avoiding async contagion at the session_start
 * wire-in. `buildPromptContext` is unchanged (no ripple to index.ts:331 / preview-context.ts).
 */
export function buildPromptAssembly(
  config: Pick<MemoryConfig, "memoryMode">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
): { mdIds: string[]; hash: string } | null {
  if (config.memoryMode === "policy-only") return null;
  const main = store.getAssemblyManifest();
  const proj = projectStore
    ? projectStore.getProjectAssemblyManifest(projectName)
    : { block: "", mdIds: [] as string[] };
  const block = [main.block, proj.block].filter((b) => b.length > 0).join("\n\n");
  if (!block) return null;
  const mdIds = [...new Set([...main.mdIds, ...proj.mdIds])];
  const hash = createHash("sha256").update(block, "utf8").digest("hex");
  return { mdIds, hash };
}
```

> Note: `MemoryConfig` and `MemoryStore` are already imported in `prompt-context.ts` (used by `buildPromptContext`). If `MemoryConfig` is imported as a type-only import, ensure `memoryMode` is present on the existing `Pick` — widen this function's `Pick<"memoryMode">` independently so `buildPromptContext`'s signature is untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/prompt-context.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/prompt-context.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/prompt-context.test.ts
git commit -m "feat(hermes): add buildPromptAssembly (sha256 receipt over assembled block, UPSP §5)"
```

---

### Task 3: SQLite schema — FK-free `session_assembly` + `session_assembly_meta`

**Files:**
- Modify: `src/store/sqlite/schema.ts` (`SCHEMA_SQL` — append two tables)
- Test: `tests/store/sqlite-session-repo.test.ts` (EDIT — assert both tables exist)

**Interfaces:**
- Consumes: `SCHEMA_SQL` (`schema.ts:13`).
- Produces: FK-free `session_assembly(session_id, md_id, PK(session_id,md_id))` + idx; FK-free `session_assembly_meta(session_id PK, hash, captured_at)`. **No** `sessions` column change, **no** `sqlite-backend.ts` migration (see spec §Timing — the `sessions` row is created post-capture, so no FK and no hash-on-sessions).

- [ ] **Step 1: Write the failing test** (append to `tests/store/sqlite-session-repo.test.ts`)

```ts
import { describe, test, expect } from "bun:test";
// reuse the file's existing SqliteBackend/tmp-dir setup helper.

describe("session_assembly schema", () => {
  test("session_assembly + session_assembly_meta tables exist (FK-free)", () => {
    const backend = /* create a fresh SqliteBackend in a tmp dir (existing helper) */;
    const db = backend.getDb();

    const t1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_assembly'").get();
    expect(t1).toBeTruthy();
    const t2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_assembly_meta'").get();
    expect(t2).toBeTruthy();

    // FK-free by design: no REFERENCES sessions(id). Confirm via schema text:
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='session_assembly'").get() as any).sql;
    expect(ddl).not.toContain("REFERENCES");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )`
Expected: FAIL — `session_assembly` / `session_assembly_meta` tables absent.

- [ ] **Step 3a: Add the two FK-free tables to `SCHEMA_SQL`** (`src/store/sqlite/schema.ts` — append before the closing backtick, after the existing indexes; do NOT touch the `sessions` table)

```sql
  -- Per-session prompt-provenance (UPSP §5): one row per md_id assembled into a session's
  -- memory block. FK-FREE by design — the sessions row is created later by deferred backfill,
  -- so session_id is a plain join key, not an enforced FK. Composite PK dedupes; md_id index
  -- backs "which sessions saw memory M?".
  CREATE TABLE IF NOT EXISTS session_assembly (
    session_id TEXT NOT NULL,
    md_id TEXT NOT NULL,
    PRIMARY KEY (session_id, md_id)
  );

  CREATE INDEX IF NOT EXISTS idx_session_assembly_md_id ON session_assembly(md_id);

  -- Per-session block hash (the receipt). Separate from sessions (NOT NULL project/cwd +
  -- post-capture row creation make hash-on-sessions unreliable). One row per session.
  CREATE TABLE IF NOT EXISTS session_assembly_meta (
    session_id TEXT NOT NULL PRIMARY KEY,
    hash TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );
```

- [ ] **Step 3b: (none — no `sqlite-backend.ts` change; the tables are `IF NOT EXISTS`)**

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/sqlite-session-repo.test.ts
git commit -m "feat(hermes): SQLite FK-free session_assembly + session_assembly_meta tables"
```

---

### Task 4: `SessionRepository.recordAssembly` — interface + SQLite impl

**Files:**
- Modify: `src/store/repository.ts` (`SessionRepository` interface, `:174`) — add the method
- Modify: `src/store/sqlite/sqlite-session-repo.ts` — implement
- Test: `tests/store/sqlite-session-repo.test.ts` (EDIT)

**Interfaces:**
- Consumes: `runWithTransientRetry` + `this.backend.withCorruptionRecovery` + `this.backend.getDb()` (the `writeXToDb(db,…)` core + wrapper idiom at `sqlite-session-repo.ts:127`/`:231`); `DatabaseLike`.
- Produces: `recordAssembly(sessionId: string, mdIds: readonly string[], hash: string): Promise<void>` on `SessionRepository`.

- [ ] **Step 1: Write the failing test** (append to `tests/store/sqlite-session-repo.test.ts`)

```ts
describe("SqliteSessionRepository.recordAssembly", () => {
  test("writes one row per md_id + meta hash; idempotent; queryable by md_id (no sessions row needed)", async () => {
    const { repo, db } = /* existing helper that builds a repo + db */;
    // NOTE: no sessions row pre-inserted — capture runs before backfill creates it (FK-free).
    await repo.recordAssembly("sess-1", ["m1", "m2", "m1"], "deadbeef");

    const meta = db.prepare("SELECT hash FROM session_assembly_meta WHERE session_id = ?").get("sess-1") as any;
    expect(meta.hash).toBe("deadbeef");

    const rows = db.prepare("SELECT md_id FROM session_assembly WHERE session_id = ? ORDER BY md_id").all("sess-1") as any[];
    expect(rows.map((r) => r.md_id)).toEqual(["m1", "m2"]); // deduped by PK

    // headline query: md_id → sessions (LEFT JOIN sessions for project/cwd when indexed)
    const sids = db.prepare("SELECT DISTINCT session_id FROM session_assembly WHERE md_id = ?").all("m1") as any[];
    expect(sids.map((r) => r.session_id)).toEqual(["sess-1"]);

    // idempotent re-call replaces, does not duplicate:
    await repo.recordAssembly("sess-1", ["m3"], "cafebabe");
    const after = db.prepare("SELECT md_id FROM session_assembly WHERE session_id = ?").all("sess-1") as any[];
    expect(after.map((r) => r.md_id)).toEqual(["m3"]);
    const h2 = (db.prepare("SELECT hash FROM session_assembly_meta WHERE session_id = ?").get("sess-1") as any).hash;
    expect(h2).toBe("cafebabe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )`
Expected: FAIL — `recordAssembly is not a function`.

- [ ] **Step 3a: Add to the interface** (`src/store/repository.ts`, in `SessionRepository` ~`:174`)

```ts
  /** Per-session prompt-provenance (UPSP §5): record the assembled md_id set + block hash.
   *  Idempotent (re-call replaces). Best-effort: callers swallow throws. */
  recordAssembly(sessionId: string, mdIds: readonly string[], hash: string): Promise<void>;
```

- [ ] **Step 3b: Implement in SQLite** (`src/store/sqlite/sqlite-session-repo.ts`, mirror the `writeSessionToDb` core + `indexSession` wrapper idiom)

```ts
  // Transaction-free core (mirrors writeSessionToDb at :127). FK-free: never touches sessions.
  private writeAssemblyToDb(
    db: DatabaseLike,
    sessionId: string,
    mdIds: readonly string[],
    hash: string,
  ): void {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO session_assembly_meta (session_id, hash, captured_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET hash = excluded.hash, captured_at = excluded.captured_at",
    ).run(sessionId, hash, now);
    db.prepare("DELETE FROM session_assembly WHERE session_id = ?").run(sessionId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO session_assembly (session_id, md_id) VALUES (?, ?)",
    );
    for (const id of mdIds) ins.run(sessionId, id);
  }

  async recordAssembly(
    sessionId: string,
    mdIds: readonly string[],
    hash: string,
  ): Promise<void> {
    await runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const db = this.backend.getDb();
        const txn = db.transaction(() => this.writeAssemblyToDb(db, sessionId, mdIds, hash));
        txn();
      }),
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-session-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/sqlite-session-repo.test.ts
git commit -m "feat(hermes): SessionRepository.recordAssembly + SQLite impl"
```

---

### Task 5: Surreal `recordAssembly` + schemaless table

**Files:**
- Modify: `src/store/surreal/schema.ts` (add `session_assembly` + `session_assembly_meta` SCHEMALESS tables + indexes)
- Modify: `src/store/surreal/surreal-session-repo.ts` (implement `recordAssembly`; **no** change to the session UPSERT at `:83`)
- Test: `tests/store/surreal/surreal-session-repo-contract.test.ts` (EDIT)

**Interfaces:**
- Consumes: `this.c` getter → `backend.client` (`:42`); schemaless `DEFINE TABLE ... SCHEMALESS` + `DEFINE INDEX ... FIELDS ...` (`schema.ts:15-26`).
- Produces: `recordAssembly(...)` on `SurrealSessionRepository`; `session_assembly` records + one `session_assembly_meta` record per session (hash). The session doc is NOT modified (hash lives in the meta table — see spec §Timing).

- [ ] **Step 1: Write the failing test** (append to `tests/store/surreal/surreal-session-repo-contract.test.ts`; the file already has a Surreal-client fixture — reuse it, skip if no live Surreal per the file's existing guard)

```ts
describe("SurrealSessionRepository.recordAssembly", () => {
  test("writes session_assembly rows + meta hash; idempotent; queryable by mdId", async () => {
    const repo = /* existing fixture repo (skip if Surreal unavailable — match file's guard) */;
    const sid = "sess-surr-1";
    await repo.indexSession({ id: sid, project: "p", cwd: "/p", startedAt: new Date().toISOString(), messages: [] } as any);
    await repo.recordAssembly(sid, ["m1", "m2", "m1"], "h1");

    const rows = await repo["c"].query<Array<{ mdId: string }>>(
      `SELECT mdId FROM session_assembly WHERE sessionId = $sid;`, { sid },
    );
    expect(rows.map((r) => r.mdId).sort()).toEqual(["m1", "m2"]);

    const sess = await repo["c"].query<Array<{ hash: string }>>(
      `SELECT hash FROM session_assembly_meta WHERE sessionId = $sid LIMIT 1;`, { sid },
    );
    expect(sess[0]?.hash).toBe("h1");

    // idempotent replace:
    await repo.recordAssembly(sid, ["m3"], "h2");
    const after = await repo["c"].query<Array<{ mdId: string }>>(
      `SELECT mdId FROM session_assembly WHERE sessionId = $sid;`, { sid },
    );
    expect(after.map((r) => r.mdId)).toEqual(["m3"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** (skip gracefully if the env has no Surreal, as the file already does)

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-session-repo-contract.test.ts )`
Expected: FAIL — `recordAssembly is not a function` (or skip if no Surreal; then verify by typecheck below).

- [ ] **Step 3a: Add schemaless tables + indexes** (`src/store/surreal/schema.ts`, alongside the existing `DEFINE TABLE`/`DEFINE INDEX` lines)

```surql
DEFINE TABLE IF NOT EXISTS session_assembly SCHEMALESS;
DEFINE INDEX IF NOT EXISTS session_assembly_md_id ON TABLE session_assembly FIELDS mdId;
DEFINE INDEX IF NOT EXISTS session_assembly_session ON TABLE session_assembly FIELDS sessionId;
DEFINE TABLE IF NOT EXISTS session_assembly_meta SCHEMALESS;
DEFINE INDEX IF NOT EXISTS session_assembly_meta_sid ON TABLE session_assembly_meta FIELDS sessionId UNIQUE;
```

- [ ] **Step 3b: (none — the session UPSERT at `:83` is NOT changed; the hash lives in `session_assembly_meta`, not on the session doc)**

- [ ] **Step 3c: Implement `recordAssembly`** (`src/store/surreal/surreal-session-repo.ts`)

```ts
  async recordAssembly(sessionId: string, mdIds: readonly string[], hash: string): Promise<void> {
    // Meta (hash) upsert + replace assembly rows. The session doc is never touched (hash lives
    // in session_assembly_meta; the sessions row is created later by backfill — see spec §Timing).
    await this.c.query(
      `UPSERT type::record("session_assembly_meta", $sid) SET sessionId = $sid, hash = $hash, capturedAt = $now;`,
      { sid: sessionId, hash, now: new Date().toISOString() },
    );
    await this.c.query(`DELETE FROM session_assembly WHERE sessionId = $sid;`, { sid: sessionId });
    const unique = [...new Set(mdIds)];
    if (unique.length === 0) return;
    const params: Record<string, unknown> = { sid: sessionId };
    const stmts = unique.map((id, i) => {
      params[`m${i}`] = id;
      return `CREATE type::record("session_assembly") SET sessionId = $sid, mdId = $m${i};`;
    });
    await this.c.query(stmts.join("\n"), params);
  }
```

- [ ] **Step 4: Run test to verify it passes** (and a typecheck so the impl is exercised even where Surreal is absent)

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-session-repo-contract.test.ts )` then `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )`
Expected: PASS (or skip + clean typecheck).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/schema.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-session-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-session-repo-contract.test.ts
git commit -m "feat(hermes): Surreal recordAssembly + session_assembly schemaless table"
```

---

### Task 6: Wire the capture into `session_start` (best-effort, once)

**Files:**
- Modify: `src/index.ts` (`session_start` handler, `:261` — after the stable-id backfill try/catch at `:311-322`, near the `scheduleSessionBackfill(sessionRepo, …)` call at `:312`)
- Test: `tests/integration/session-assembly.test.ts` (NEW)

**Interfaces:**
- Consumes: `buildPromptAssembly` (Task 2), `sessionRepo` (`index.ts:170`), `config` / `store` / `projectStore` / `projectName` (all in scope at the handler), `ctx.sessionManager.getSessionId()` (pi `extensions.md:669`).
- Produces: one `recordAssembly` call per session start, wrapped in try/catch.

- [ ] **Step 1: Write the failing test** (`tests/integration/session-assembly.test.ts`, NEW — use the file's/`tests/helpers`'s pi-extension harness pattern if one exists; otherwise unit-test the capture logic by extracting it)

```ts
import { describe, test, expect, mock } from "bun:test";
// Reuse an existing pi-event harness from tests/helpers if present (search tests/integration/*.test.ts
// for how they construct the extension + emit session_start). If no harness, extract the capture
// into a testable function captureAssembly({getSessionId, buildPromptAssembly, recordAssembly}).

describe("session_start assembly capture", () => {
  test("records manifest once; swallows capture errors; policy-only writes nothing", async () => {
    const recordAssembly = mock(() => Promise.resolve());
    // ... construct the extension with a stub sessionRepo whose recordAssembly = recordAssembly;
    //     emit session_start with a ctx.sessionManager.getSessionId = () => "sess-x";
    //     store preloaded with ≥1 memory entry carrying an id.

    // emit session_start
    expect(recordAssembly).toHaveBeenCalledTimes(1);
    const [sid, mdIds, hash] = recordAssembly.mock.calls[0];
    expect(sid).toBe("sess-x");
    expect(mdIds.length).toBeGreaterThan(0);
    expect(typeof hash).toBe("string");
  });

  test("a throwing recordAssembly does not abort session_start", async () => {
    const recordAssembly = mock(() => Promise.reject(new Error("boom")));
    // ... emit session_start; assert the handler resolves (no throw) despite the failure.
  });
});
```

> If extracting a pure `captureAssembly` helper is cleaner than driving the full pi harness, do that and unit-test it; then add a thin integration smoke that just asserts the `session_start` handler calls it with `ctx.sessionManager.getSessionId()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/session-assembly.test.ts )`
Expected: FAIL — no capture wired / `recordAssembly` not called.

- [ ] **Step 3: Wire the capture** (`src/index.ts`, inside the `session_start` handler, after the backfill try/catch and the `scheduleSessionBackfill(...)` call)

```ts
    // Per-session prompt-provenance (UPSP §5): capture the assembled md_id set + block hash
    // ONCE per session. Best-effort — never abort startup (mirrors the backfillStableIds guard).
    try {
      const sm = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
      const sid = sm?.getSessionId?.();
      if (sid) {
        const assembly = buildPromptAssembly(config, store, projectStore, projectName);
        if (assembly) {
          await sessionRepo.recordAssembly(sid, assembly.mdIds, assembly.hash);
        }
      }
    } catch {
      /* best-effort provenance; never block startup */
    }
```

Add the import near the existing `buildPromptContext` import (`index.ts:63`): `import { buildPromptContext, buildPromptAssembly } from "./prompt-context.js";`

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/session-assembly.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/integration/session-assembly.test.ts
git commit -m "feat(hermes): wire per-session prompt-provenance capture at session_start"
```

---

### Task 7: Full test matrix + extension-contract green

**Files:**
- Test: whole package

- [ ] **Step 1: Run the full hermes-memory suite**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: PASS — all existing tests (memory-store, repos, integration, contract) + the 6 new tests green.

- [ ] **Step 2: Run the extension-contract test**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/extension-contract.test.ts )`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )`
Expected: no errors (both SQLite + Surreal paths).

- [ ] **Step 4: If any regression, fix inline; otherwise open the PR**

```bash
# branch already fix/await-pr-merge-behind-dirty-tree is unrelated; create a fresh feature branch
git checkout main && git checkout -b feat/hermes-session-assembly-log
git push -u origin feat/hermes-session-assembly-log
gh pr create --title "feat(hermes): per-session assembly log (prompt-provenance, UPSP §5)" \
  --body "Implements UPSP §5 cheap tier: capture the assembled md_id set + block hash once per session at session_start into a new session_assembly table (SQLite + Surreal). See .planning/2026-08-02-05-session-roll-up-all-landed-pr-what-1005-herme/spec.md."
```

---

## Self-review (run before handing off)

- **Spec coverage:** D1 (scope) ✓ Tasks 1–6; D2 (all injected blocks) ✓ Task 1; D3 (once at session_start) ✓ Task 6; D4 (FK-free session_assembly + session_assembly_meta, both backends, neither touches sessions) ✓ Tasks 3–5; D5 (sha256 of rendered block excl. policy) ✓ Tasks 1–2. Acceptance 1–6 ✓ Tasks 1–6.
- **Placeholder scan:** no TBD/TODO; test bodies reference the file's existing construction helpers (flagged "reuse the file's helper") rather than invented fixtures — the implementer reads the neighboring test to match idiom.
- **Type consistency:** `getAssemblyManifest()` / `getProjectAssemblyManifest(name)` / `buildPromptAssembly(...)` / `recordAssembly(sessionId, mdIds, hash)` names + signatures match across Tasks 1→2→4→5→6.
