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

