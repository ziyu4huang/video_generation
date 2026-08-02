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

