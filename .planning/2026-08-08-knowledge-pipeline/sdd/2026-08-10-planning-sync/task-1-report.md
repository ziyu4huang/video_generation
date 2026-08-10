# Task 1 Report — `card_md_hash` table (schema DDL + idempotent migration)

**Ticket:** 09-impl (DB↔md sync), Task 1
**Branch:** `knowledge-pipeline/09-impl-planning-sync` (created from origin/main 94adcb60)
**Commit:** `a8c9817f` — `feat(knowledge-pipeline): card_md_hash table + idempotent migration (09-impl T1)`
**Status:** DONE

---

## What was implemented

A purely-additive `card_md_hash` table for planning-card content-hash drift detection
(Tier-1, md-wins), with an idempotent migration so pre-09 legacy DBs get it on next open.
The `memories` schema is **byte-identical** — only a new table + index are appended, and one
new private method + one call site are added. Nothing in `memories` is touched.

- New table on every DB (fresh + legacy), created idempotently via `CREATE TABLE IF NOT EXISTS`.
- `kind TEXT NOT NULL DEFAULT 'mirror'` discriminator so 10-impl can add `kind='validated'`
  rows (dep-validation hashes) WITHOUT a migration.
- Fresh installs get the table from `SCHEMA_SQL`; the `ensureCardMdHashTable` migration only
  fires for pre-09 DBs that predate the table.

## Files changed (3, all in-scope)

1. `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` — DDL appended to `SCHEMA_SQL`.
2. `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` — new `ensureCardMdHashTable` method + call site in `initializeSchema`.
3. `bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts` — 2 new table-existence tests appended.

### Diff hunk — DDL (`schema.ts`)

Appended immediately after `idx_memories_md_id`, before the `session_assembly` block:

```diff
   CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_md_id ON memories(md_id);

+  -- 09-impl (knowledge-pipeline / ticket 09): content-hash state for the
+  -- planning-card mirror (Tier-1, md-wins drift). 'kind' discriminator so 10-impl
+  -- can add dep-validation hashes (kind='validated') WITHOUT a migration.
+  CREATE TABLE IF NOT EXISTS card_md_hash (
+    card_id TEXT PRIMARY KEY,
+    content_hash TEXT NOT NULL,
+    mirrored_at DATE NOT NULL,
+    kind TEXT NOT NULL DEFAULT 'mirror'
+  );
+  CREATE INDEX IF NOT EXISTS idx_card_md_hash_kind ON card_md_hash(kind);
+
   -- Per-session prompt-provenance (UPSP §5): one row per md_id assembled into a session's
```

### Diff hunk — migration call site (`sqlite-backend.ts`, `initializeSchema`)

Inserted immediately after `migrateMemoriesTargetCheckAddPlanning(db)`, before `rebuildMemoryFts(db)`:

```diff
     this.migrateMemoriesTargetCheckAddPlanning(db);
+    // Phase-2 (knowledge-pipeline / ticket 09): ensure the card_md_hash table
+    // for the planning-card content-hash mirror. Idempotent (CREATE TABLE IF
+    // NOT EXISTS). Additive — does NOT touch `memories` (no C3 column-drift).
+    this.ensureCardMdHashTable(db);
     this.rebuildMemoryFts(db);
```

### Diff hunk — new method (`sqlite-backend.ts`, placed right after `ensureMemoriesColumns`)

```diff
   /** 09-impl (ticket 09): ensure the `card_md_hash` table exists. Idempotent
    *  (CREATE TABLE IF NOT EXISTS). Simpler than the T5 target-CHECK migrations
    *  (which rebuild `memories`): this is a brand-new table with no legacy rows,
    *  so there is nothing to carry through a rewrite. Fresh installs already get
    *  it from SCHEMA_SQL; this only fires for pre-09 DBs that predate the table. */
   private ensureCardMdHashTable(db: DatabaseLike): void {
     db.exec(`
       CREATE TABLE IF NOT EXISTS card_md_hash (
         card_id TEXT PRIMARY KEY,
         content_hash TEXT NOT NULL,
         mirrored_at DATE NOT NULL,
         kind TEXT NOT NULL DEFAULT 'mirror'
       );
       CREATE INDEX IF NOT EXISTS idx_card_md_hash_kind ON card_md_hash(kind);
     `);
   }
```

## TDD evidence

### RED (before implementation)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`

Both new tests failed for the **right reason** — `card_md_hash` table not present, so the
`SELECT … name='card_md_hash'` probe returned `undefined`:

```
(fail) card-agnostic store (SQLite round-trip) > creates card_md_hash on a fresh store open (09-impl T1) [0.91ms]
(fail) card-agnostic store (SQLite round-trip) > ensures card_md_hash on a legacy (pre-09) DB via ensureCardMdHashTable [6.72ms]
AssertionError: Expected values to be strictly equal:
+ actual - expected
+ undefined
- 'card_md_hash'
 6 pass
 2 fail
```

Why expected: the table DDL + migration did not exist yet, so both the fresh-DB and
legacy-DB probes correctly found no `card_md_hash` row in `sqlite_master`.

### GREEN (after implementation)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`

```
(pass) … > creates card_md_hash on a fresh store open (09-impl T1) [0.35ms]
(pass) … > ensures card_md_hash on a legacy (pre-09) DB via ensureCardMdHashTable [6.42ms]
 8 pass
 0 fail
Ran 8 tests across 1 file.
```

## Full-suite result (exact counts)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`

- `bun run check` (`tsc --noEmit`): **PASS** (clean).
- `bun test`: **1411 pass / 1 skip / 1 fail**, 1413 tests across 121 files.

Baseline was **1409 pass / 1 skip / 1 fail** (1411 total). The **+2 pass = the 2 new T1
tests**; the **1 fail is the EXACT same pre-existing known failure**, unchanged:

```
(fail) numeric isolation — assembled prompt never leaks memworth (UPSP §7 / DO ticket 04)
       > formatForSystemPrompt never emits memworth (memory + failure blocks — regression pin)
       — tests/store/memory-store.test.ts:2630  (known date-aging time-bomb, ticket-04 concern; NOT touched)
```

**Net: zero new failures. My 2 new tests pass. DoD met.**

## Self-review notes

1. **Brief's test code referenced `memoryDir`, which is NOT in scope in `card-store.test.ts`** —
   the file's top-level temp-dir variable is `dir` (line 10: `const dir = mkdtempSync(...)`),
   and `store` is opened on `memoryDir: dir`. The brief's NOTE claimed `memoryDir` is in scope;
   it is not. I adapted the first test's `join(memoryDir, "sessions.db")` → `join(dir, "sessions.db")`
   to refer to the same on-disk DB file the store uses. Intent (inspect the SAME db file the
   `store` was opened on) is preserved exactly. This is the only deviation from verbatim and it
   is forced by reality.
2. **Brief's `SCHEMA_SQL` comment contained a backtick** (`` `kind` ``). `SCHEMA_SQL` is a JS
   **template literal**, so the backtick prematurely closed the string and broke TypeScript
   parsing (`error: Expected ";" but found "kind"`). I changed the comment's `` `kind` `` →
   `'kind'` (single quotes). The SQL DDL itself is byte-identical to the brief; only the
   *prose comment* changed to be valid inside a template literal.
3. The DDL appears in two places (canonical, by design per the brief): once in `SCHEMA_SQL`
   (fresh installs) and once in `ensureCardMdHashTable` (legacy migration). Both copies are
   byte-identical — verified by eye.
4. `ensureCardMdHashTable` is a plain `CREATE TABLE IF NOT EXISTS` — NOT a rebuild (no data to
   carry, no column-list, no transaction), exactly as the brief prescribes and unlike the T5
   `memories` target-CHECK migrations.
5. Call-site ordering in `initializeSchema`: `… → migrateMemoriesTargetCheckAddPlanning →
   ensureCardMdHashTable → rebuildMemoryFts`. Additive placement after the planning migration
   and before the FTS rebuild is safe: `card_md_hash` has no FTS, and the new table is
   independent of `memories`.
6. **Additive-only confirmed**: the diff touches only the new table/index, the new method, and
   one call site. No `memories` column, CHECK, trigger, or index is altered — `memories` stays
   byte-identical (DoD: additive table only).
7. **Staging discipline**: exactly the 3 in-scope files staged by explicit path; the scratch
   `.planning/.../sdd/` dir was left untracked (`??`), and the stashed `mlx_native.py` was
   not touched. One commit, one subject line.

## Concerns

None blocking. The two minor forced deviations (test variable `memoryDir`→`dir`;
comment backtick→single quote) are documented above and do not change behavior or the DDL.
