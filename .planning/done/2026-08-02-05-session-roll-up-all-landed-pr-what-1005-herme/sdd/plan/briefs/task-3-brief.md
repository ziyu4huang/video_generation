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

