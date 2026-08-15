# Task 3 Report — SQLite FK-free `session_assembly` + `session_assembly_meta`

## Status

DONE

## Commit

- `0e3eab2f21205d3ce4529a3dd1f38407d57c5a0d` — `feat(hermes): SQLite FK-free session_assembly + session_assembly_meta tables`

## Files changed

- `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` — appended two FK-free tables + one index to `SCHEMA_SQL` (before the closing backtick, after `idx_memories_md_id`). `sessions` table untouched.
- `bun-apps/pi-agent-ext-hermes-memory/tests/store/sqlite-session-repo.test.ts` — appended a `describe("session_assembly schema")` block reusing the file's existing `SqliteBackend` / tmp-dir idiom.

`sqlite-backend.ts` was **not** modified — both tables are `CREATE TABLE IF NOT EXISTS`, so existing DBs absorb them on next init with no migration.

## Schema appended

```sql
CREATE TABLE IF NOT EXISTS session_assembly (
  session_id TEXT NOT NULL,
  md_id TEXT NOT NULL,
  PRIMARY KEY (session_id, md_id)
);

CREATE INDEX IF NOT EXISTS idx_session_assembly_md_id ON session_assembly(md_id);

CREATE TABLE IF NOT EXISTS session_assembly_meta (
  session_id TEXT NOT NULL PRIMARY KEY,
  hash TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
```

## FK-free rationale (by design)

- `session_assembly.session_id` and `session_assembly_meta.session_id` are **plain join keys**, NOT `REFERENCES sessions(id)`. At the `session_start` capture point the `sessions` row does not yet exist — it is created later by deferred backfill — so an enforced FK would raise a foreign-key violation.
- The block hash lives in its own `session_assembly_meta` table rather than a column on `sessions`, because `sessions` has `NOT NULL project` / `NOT NULL cwd` and is created post-capture, making a hash-on-sessions column unreliable.
- Test asserts the rendered `session_assembly` DDL contains no `REFERENCES` token, locking the FK-free contract.

## Test added

`session_assembly schema > session_assembly + session_assembly_meta tables exist after backend init (FK-free)`:
- Asserts both tables exist in `sqlite_master` after `backend.init()`.
- Asserts the `session_assembly` DDL text does not contain `REFERENCES` (FK-free by design).

## Verification

- `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-session-repo.test.ts )` → **55 pass, 0 fail** (149 expect() calls), including the new test.
- `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )` → **EXIT 0** (`tsc --noEmit` clean).
- `git status` confirmed only the two named files changed.

## Concerns

None.
