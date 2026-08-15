# Hermes Memory — Legacy Random-ID → Graph-Edge Orphan Fix (item 1 + item 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Heal the 934 legacy memory rows whose SurrealDB record id is an auto-generated random string (`memories:01o4ldkat5gz9cehd3b9`) rather than seq-based (`memories:1228`), so that the existing graph-edge code (which hardcodes `memories:<seq>`) attaches edges to the REAL record — converging backfill and stopping the phantom-edge bloat.

**Architecture:** A one-time, idempotent, best-effort migration `SurrealMemoryRepository.normalizeLegacyMemoryIds()` runs at surrealdb-backend startup, BEFORE `backfillGraphEdges()`. For each row where `record::id(id) != seq` it UPSERTs a seq-based clone (`memories:<seq>`, all fields copied) and deletes the random-id original. When it actually migrates ≥1 row it also wipes `tagged` (the bloated phantom/duplicate edges) so the immediately-following `backfillGraphEdges()` rebuilds a minimal, correct edge set for every row. Once all ids are seq-based the migration is a single cheap SELECT that returns 0 rows (no-op); backfill then finds 0 orphans (no-op). New rows are unaffected — the current create path already uses `CREATE type::record("memories", $next)`.

**Tech Stack:** TypeScript (Bun), SurrealDB v3 (local `127.0.0.1:8000`), `proper-lockfile` (unaffected), `bun test` + the existing `isSurrealUp()`-gated surreal contract suite.

---

## Diagnosis — the shared root cause of item 1 (944-orphan) and item 2 (backfill "skip")

**Symptoms reported:**
- item 1: 944 (now 934) of ~1227 (now 1243) memories have NO graph edges, yet 30144 (now 36561) `tagged` edges exist.
- item 2: backfill seems to "skip after one run" — orphans never heal and the edge count keeps climbing every boot.

**Root cause (evidence-backed, live DB probe 2026-08-01, ns `user_huangziyu` / db `memory`):**

1. Legacy memory rows were created with SurrealDB **auto-generated random record ids** — e.g. `SELECT id, seq FROM memories WHERE seq = 1228` → `id = "memories:01o4ldkat5gz9cehd3b9"`, `seq = 1228`. The current create path (`surreal-memory-repo.ts:228,312`) is `CREATE type::record("memories", $next) SET seq = $next, ...`, so all NEW rows are `memories:<seq>` (verified: seq 1890 → `id = "memories:1890"`).
2. Every graph-edge operation keys the source by seq as a literal record id:
   - write path `syncGraphEdges` (`:667`): `DELETE FROM tagged WHERE in = type::record("memories", $seq)` and `:676` `LET $mem = type::record("memories", $seq); ... RELATE $mem->tagged->$tag`.
   - startup `backfillGraphEdges` (`:726`): `RELATE memories:${seq}->tagged->tag:${tagRecordLiteral(t.key)}`.
   - `removeMemory` (`:793`): `DELETE FROM tagged WHERE in = type::record("memories", $seq)`.
   For the 934 legacy rows, `memories:<seq>` is a **phantom record** (the real record is `memories:<random>`), so every edge is attached to a phantom node.
3. The graph walk `count(->tagged)` evaluates on the REAL record (`memories:<random>`), which has no outgoing edges → the row is a permanent orphan. Verified on seq 1228: `count(->tagged) = 0` and `->tagged = []`, yet `SELECT count() FROM tagged WHERE in = type::record("memories", 1228) = 46` (phantom edges on the phantom node).
4. `backfillGraphEdges` finds these orphans every boot and RE-creates edges on `memories:<seq>` phantoms (still invisible to the graph walk on the real record) → **never converges** (the "skip" is a phantom-id no-op, not a real sentinel) and each boot ADDS another duplicate phantom set → `tagged` bloat 30144 → 36561 and counting.
5. **Perfect correlation:** `SELECT count() FROM memories WHERE record::id(id) != seq = 934` = orphan count = `count() WHERE count(->tagged)=0 AND record::id(id)!=seq = 934`. 934 = 934 = 934.

**Why PR #973 didn't fix it:** #973 made the orphan-CHECK fast (`NOT IN` subquery → `count(->tagged)=0`, 10s → 17ms) but the edges it then creates still land on phantom `memories:<seq>` nodes, so orphans persist. The id mismatch is upstream of the query.

**Why this also resolves item 2 ("sentinel"):** there is no deliberate skip sentinel. Once ids are normalized, `backfillGraphEdges` converges to 0 orphans on the next boot and becomes a genuine no-op (a single cheap SELECT returning 0). A separate skip-sentinel is unnecessary (the plan's "Out of scope" anticipated this: "investigate why edges don't stick if it never converges" — answer: phantom ids).

---

## Fix design + decisions

**Decision 1 — fix the DATA, not the edge code.** The edge code's `memories:<seq>` assumption is correct for all current/future rows (the create path guarantees `id = memories:<seq>`). Only the 934 legacy rows violate it. Normalizing their ids to `memories:<seq>` is the complete, permanent fix; no production edge-code change is needed and no per-edge id-lookup round-trip is added to the write path.

**Decision 2 — migration lives on `SurrealMemoryRepository`** (co-located with `backfillGraphEdges`, same `this.c.query` client, unit-testable via the existing `isSurrealUp()` surreal suite). Called from `backend-factory.ts` surrealdb branch AFTER `backend.init()`, BEFORE `backfillGraphEdges()`.

**Decision 3 — edge rebuild is folded into the migration, gated on "did we migrate any row".** `DELETE FROM tagged` is destructive, so it runs ONLY inside the migration when `mismatched.length > 0` (one-time). The immediately-following `backfillGraphEdges()` then rebuilds every row's edge set from scratch (after the wipe, all rows are orphans → backfill heals all). On subsequent boots the migration is a no-op SELECT → `DELETE FROM tagged` does not run → legit edges are not wiped.

**Decision 4 — idempotent + best-effort + batched.** Mirrors `backfillGraphEdges`: chunked SurrealQL scripts (CHUNK=100), whole method wrapped in try/catch returning 0 on any error so it can NEVER trip the `createBackendBundleWithFallback` sqlite fallback. Re-runnable: once all rows are seq-based, the mismatch SELECT returns 0 → no-op.

**Decision 5 — field copy is explicit (mirrors the existing CREATE field list).** Rather than rely on `CREATE ... CONTENT <record>` semantics (uncertain id-field conflict handling), the migration inlines every field via the existing `sqlStr` helper, matching the field list at `surreal-memory-repo.ts:228`: `seq, project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, mwSuccess, mwFail, status, supersedes, supersededBy, parentIds`. `UPSERT type::record("memories", $seq) SET ...` (create-or-update, safe if a seq-id row somehow pre-exists) then `DELETE memories:<oldRandomIdPart>`.

**Decision 6 — known concurrency limitation (accepted, one-time).** Multiple sibling agents booting simultaneously could each run the first migration. The UPSERT+DELETE per row is idempotent (duplicate UPSERT updates, duplicate DELETE no-ops), but two concurrent `DELETE FROM tagged` + `backfillGraphEdges` could create some duplicate edges. This is non-fatal (graph recall still works; slight bloat) and the window is the one-time first migration only. NOT engineered around (would need a cross-process lock equivalent to hermes's `withFileLock`, out of scope). Documented in code comment.

**Lineage safety:** `supersedes` / `supersededBy` / `parentIds` reference the INTEGER seq (the public `MemoryEntry.id`), never the Surreal record id, so re-iding a row does not break lineage. The migration copies these fields verbatim.

---

## File Structure

- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts`
  - Add `async normalizeLegacyMemoryIds(): Promise<number>` (near `backfillGraphEdges`, ~`:695`). Selects mismatched rows, UPSERTs seq-id clones, deletes random-id originals, wipes `tagged` when ≥1 migrated. Best-effort try/catch → 0.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/backend-factory.ts`
  - In the `surrealdb` branch, add `await memoryRepo.normalizeLegacyMemoryIds();` immediately BEFORE `await memoryRepo.backfillGraphEdges();` (with a one-line comment).
- **Test:** `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-memory-graph.test.ts`
  - Extend the `describe("backfill graph edges")` / add `describe("normalize legacy ids")` block, gated on `isSurrealUp()`, using the existing unique-namespace `make()` pattern.

No new files. No production change to `syncGraphEdges`, `backfillGraphEdges`, or the create path.

---

## Task 1: `normalizeLegacyMemoryIds()` migration (TDD)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts` (add method near `:695`)
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-memory-graph.test.ts`

**Interfaces:**
- Consumes: `this.c.query` (SurrealClient), `sqlStr` (existing export at `:41`).
- Produces: `SurrealMemoryRepository.normalizeLegacyMemoryIds(): Promise<number>` — returns the count of rows migrated (0 when already normalized or on best-effort failure). Called by `backend-factory.ts` (Task 2).

- [ ] **Step 1: Write the failing tests** (add to `surreal-memory-graph.test.ts`, inside the `isSurrealUp()`-gated suite; reuse the existing `make()` that opens a fresh unique-namespace `SurrealBackend` + `init()` + repos).

```typescript
describe("normalizeLegacyMemoryIds", () => {
  it("migrates random-id rows to memories:<seq>, preserving fields, and is idempotent", async () => {
    const { memoryRepo, backend } = await make();
    // Plant a legacy row: CREATE without an explicit id → Surreal auto-generates
    // a random id; seq is stored as a field. This reproduces the legacy shape.
    await backend.client.query(
      `CREATE memories SET seq = 55, project = "demo", target = "memory",
        category = NONE, content = "legacy body", failureReason = NONE,
        toolState = NONE, correctedTo = NONE, created = "2026-01-01",
        lastReferenced = "2026-01-02", mwSuccess = 0, mwFail = 0,
        status = "active", supersedes = NONE, supersededBy = NONE, parentIds = [];`,
    );

    const migrated = await memoryRepo.normalizeLegacyMemoryIds();
    assert.strictEqual(migrated, 1, "one legacy row migrated");

    // The row now lives at memories:55 (seq-based), fields preserved.
    const rows = await backend.client.query<Array<{ id: string; seq: number; content: string; project: string | null }>>(
      `SELECT id, seq, content, project FROM memories WHERE seq = 55;`,
    );
    assert.strictEqual(rows.length, 1, "exactly one row for seq 55 (old random-id gone)");
    assert.strictEqual(rows[0]!.id, "memories:55", "id is now seq-based");
    assert.strictEqual(rows[0]!.content, "legacy body", "content preserved");
    assert.strictEqual(rows[0]!.project, "demo", "project preserved");

    // Idempotent: a second run migrates nothing.
    const again = await memoryRepo.normalizeLegacyMemoryIds();
    assert.strictEqual(again, 0, "idempotent — no rows to migrate on second run");
  });

  it("wipes tagged edges when it migrates, so the following backfill rebuilds them cleanly", async () => {
    const { memoryRepo, backend } = await make();
    // Legacy row + a phantom duplicate edge set on memories:<seq> (the bloat shape).
    await backend.client.query(
      `CREATE memories SET seq = 77, target = "failure", category = "insight",
        content = "x", created = "2026-01-01", lastReferenced = "2026-01-01",
        status = "active", parentIds = [];`,
    );
    // Two duplicate phantom edges on the phantom node memories:77 (as backfill does).
    await backend.client.query(`RELATE memories:77->tagged->tag:` + "`target:failure`" + `;`);
    await backend.client.query(`RELATE memories:77->tagged->tag:` + "`target:failure`" + `;`);

    const migrated = await memoryRepo.normalizeLegacyMemoryIds();
    assert.strictEqual(migrated, 1, "migrated the legacy row");

    // Migration wiped tagged (rebuild happens via the caller's backfillGraphEdges).
    const edgeCount = await backend.client.query<Array<{ c: number }>>(
      `SELECT count() AS c FROM tagged GROUP ALL;`,
    );
    assert.strictEqual(edgeCount[0]?.c ?? 0, 0, "tagged wiped by the migration");

    // Now backfill rebuilds exactly one correct edge set on the real memories:77.
    const built = await memoryRepo.backfillGraphEdges();
    assert.strictEqual(built, 1, "backfill rebuilt the one row");
    const after = await backend.client.query<Array<{ c: number }>>(
      `SELECT count(->tagged) AS c FROM memories:77 GROUP ALL;`,
    );
    assert.strictEqual(after[0]?.c, 2, "two edges (target:failure + category:insight), no duplicates");
  });

  it("is a no-op (returns 0, does not wipe tagged) when all rows are already seq-based", async () => {
    const { memoryRepo, backend } = await make();
    // A correctly-shaped row + a legit edge that must survive.
    await backend.client.query(
      `CREATE type::record("memories", 99) SET seq = 99, target = "memory",
        content = "ok", created = "2026-01-01", lastReferenced = "2026-01-01",
        status = "active", parentIds = [];`,
    );
    await backend.client.query(`RELATE memories:99->tagged->tag:` + "`target:memory`" + `;`);

    const migrated = await memoryRepo.normalizeLegacyMemoryIds();
    assert.strictEqual(migrated, 0, "no mismatched rows");
    const surviving = await backend.client.query<Array<{ c: number }>>(
      `SELECT count() AS c FROM tagged GROUP ALL;`,
    );
    assert.strictEqual(surviving[0]?.c ?? 0, 1, "legit edge NOT wiped when nothing migrated");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-memory-graph.test.ts )`
Expected: FAIL — `normalizeLegacyMemoryIds is not a function` (method does not exist yet). Requires a live SurrealDB on `127.0.0.1:8000` (the suite auto-skips otherwise — confirm `isSurrealUp()` is true locally).

- [ ] **Step 3: Implement `normalizeLegacyMemoryIds()`** (add to `surreal-memory-repo.ts`, immediately above `backfillGraphEdges`).

```typescript
/**
 * One-time migration: heal legacy memory rows whose Surreal record id is an
 * auto-generated random string (`memories:<random>`) rather than seq-based
 * (`memories:<seq>`). Such rows were created before the create path switched
 * to `CREATE type::record("memories", $next)`. Every graph-edge operation
 * (syncGraphEdges / backfillGraphEdges / removeMemory) keys the source by
 * `memories:<seq>`, so legacy rows' edges land on a PHANTOM node and the row
 * is a permanent graph orphan — backfill re-creates phantom edges every boot
 * (never converging) and the `tagged` table bloats with duplicates.
 *
 * For each mismatched row: UPSERT a seq-based clone with all fields copied,
 * then delete the random-id original. When ≥1 row is migrated, ALSO wipe
 * `tagged` so the caller's immediately-following `backfillGraphEdges()`
 * rebuilds a minimal correct edge set (the wipe is gated on actual migration
 * so it never runs on an already-clean DB and never destroys legit edges).
 *
 * Idempotent: once every row is seq-based the mismatch SELECT returns 0 →
 * no-op. Best-effort: any error is swallowed (returns 0) so it cannot trip
 * the sqlite fallback in createBackendBundleWithFallback. Chunked (CHUNK=100)
 * to bound each HTTP request. Concurrency note: sibling agents racing the
 * first migration could create some duplicate edges (non-fatal; one-time).
 */
async normalizeLegacyMemoryIds(): Promise<number> {
  try {
    const legacy = await this.c.query<Row[]>(
      `SELECT id, seq, project, target, category, content, failureReason,
              toolState, correctedTo, created, lastReferenced, mwSuccess,
              mwFail, status, supersedes, supersededBy, parentIds
       FROM memories WHERE record::id(id) != seq;`,
    );
    if (legacy.length === 0) return 0;

    const CHUNK = 100;
    const str = (v: unknown): string => (v == null ? "NONE" : sqlStr(String(v)));
    const num = (v: unknown): string => (v == null ? "NONE" : String(Number(v)));
    for (let i = 0; i < legacy.length; i += CHUNK) {
      const stmts: string[] = [];
      for (const r of legacy.slice(i, i + CHUNK)) {
        const seq = Number(r.seq);
        // Inline the old random id part (alphanumeric, safe as a literal).
        const oldIdPart = String((r.id as unknown as string).split(":")[1]);
        stmts.push(
          `UPSERT type::record("memories", ${seq}) SET ` +
            `seq = ${seq}, project = ${str(r.project)}, target = ${str(r.target)}, ` +
            `category = ${str(r.category)}, content = ${str(r.content)}, ` +
            `failureReason = ${str(r.failureReason)}, toolState = ${str(r.toolState)}, ` +
            `correctedTo = ${str(r.correctedTo)}, created = ${str(r.created)}, ` +
            `lastReferenced = ${str(r.lastReferenced)}, mwSuccess = ${num(r.mwSuccess)}, ` +
            `mwFail = ${num(r.mwFail)}, status = ${str(r.status)}, ` +
            `supersedes = ${num(r.supersedes)}, supersededBy = ${num(r.supersededBy)}, ` +
            `parentIds = ${r.parentIds == null ? "[]" : String(r.parentIds)};`,
        );
        stmts.push(`DELETE memories:${oldIdPart};`);
      }
      await this.c.query(stmts.join("\n"));
    }
    // Wipe bloated/phantom edges ONLY because we migrated ≥1 row; the caller's
    // backfillGraphEdges() rebuilds a clean minimal set for every row.
    await this.c.query(`DELETE FROM tagged;`);
    return legacy.length;
  } catch {
    // Best-effort: never abort startup or trigger the sqlite fallback.
    return 0;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-memory-graph.test.ts )`
Expected: PASS (3 new cases + existing graph cases green). Requires live SurrealDB.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-memory-graph.test.ts
git commit -m "fix(hermes-memory): add normalizeLegacyMemoryIds migration for random-id rows"
```

---

## Task 2: Wire into startup (before backfill) + convergence verification

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/backend-factory.ts` (surrealdb branch, ~`:37`)
- Verify: live DB orphan count drops to 0 on next boot.

**Interfaces:**
- Consumes: `SurrealMemoryRepository.normalizeLegacyMemoryIds()` (Task 1).
- Produces: a surrealdb startup that heals legacy ids then rebuilds edges.

- [ ] **Step 1: Wire the migration before backfill** (`backend-factory.ts` surrealdb branch).

```typescript
      const memoryRepo = new SurrealMemoryRepository(backend);
      // One-time, idempotent: heal legacy random-id rows → memories:<seq> so the
      // graph-edge code (which keys by seq) attaches edges to the real record.
      // When it migrates ≥1 row it also wipes `tagged` (next call rebuilds it).
      await memoryRepo.normalizeLegacyMemoryIds();
      // Auto-heal `tagged` graph edges for rows written before graph-augmented
      // search shipped. Best-effort (never throws) so it cannot trip the sqlite
      // fallback in createBackendBundleWithFallback. A no-op once every row
      // has edges.
      await memoryRepo.backfillGraphEdges();
```

- [ ] **Step 2: Verify on the live DB (manual, evidence)** — run a one-off boot against the real namespace, then re-probe.

Run a pi startup once (e.g. `bun-apps/pi-agent/run.sh` or `bun --cwd bun-apps/pi-agent run src/cli.ts --list-models` — anything that triggers `createBackendBundle`). Then:

```bash
NS="user_huangziyu"; DB="memory"
probe() { curl -s -X POST http://127.0.0.1:8000/sql -H "surreal-ns: $NS" -H "surreal-db: $DB" -H "Accept: application/json" -u "root:root" --data "$1"; }
echo -n "mismatched-id rows: "; probe 'SELECT count() AS n FROM memories WHERE record::id(id) != seq GROUP ALL;'
echo -n "orphans (count(->tagged)=0): "; probe 'SELECT count() AS n FROM memories WHERE count(->tagged) = 0 GROUP ALL;'
echo -n "tagged edges: "; probe 'SELECT count() AS n FROM tagged GROUP ALL;'
```

Expected: mismatched = 0, orphans = 0, tagged edges ≈ (memories × ~2.5 tags, i.e. a few thousand, NOT 36000+). A second boot: mismatched stays 0, orphans stay 0, tagged unchanged (both calls no-ops).

- [ ] **Step 3: Run the full hermes-memory suite + tsc**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: tsc exit 0; all tests pass (881+ before, plus the 3 new Task-1 cases).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/backend-factory.ts
git commit -m "fix(hermes-memory): run normalizeLegacyMemoryIds before backfill on surrealdb startup"
```

---

## Out of scope

- **A deliberate skip-sentinel for backfill** — unnecessary: once ids are normalized, backfill converges to 0 orphans and is already a no-op SELECT. Do NOT add one.
- **Hardening the edge code against future id drift** — the create path guarantees `id = memories:<seq>`; a defensive id-lookup per edge write adds round-trips for a non-recurring risk. Skip unless a future create-path change reintroduces random ids.
- **Cross-process migration lock** — sibling-agent race on the one-time first migration may leave a few duplicate edges (non-fatal); engineering a hermes-`withFileLock`-equivalent for Surreal is out of scope.
- **D — structural 120s lock-contention** (consolidation LLM holding `withFileLock`) — separate effort; the retry-defect half is already shipped (commit `0a429437`).

---

## Self-Review

**1. Spec coverage:**
- item 1 (orphans heal) → Task 1 migrates ids; Task 2 wires it; convergence probe asserts orphan=0. ✓
- item 2 (backfill stops re-bloating / "skip" explained) → Task 1 wipes+rebuilds edges once; Task 2 verifies tagged count sane + stable on second boot; the Diagnosis section explicitly explains there is no real sentinel. ✓
- Idempotency / no-op on clean DB → Task 1 Step 1 case 3 + Step 4; Decision 4. ✓
- Best-effort (no sqlite-fallback trip) → Decision 4 + try/catch in Step 3 code. ✓
- Field preservation / lineage safety → Task 1 Step 1 case 1 asserts content/project; Decision 6 notes seq-keyed lineage. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/etc. All code blocks contain real SurrealQL/TS. The `str`/`num` helpers and field list are concretely specified. ✓

**3. Type consistency:** `normalizeLegacyMemoryIds(): Promise<number>` matches across Task 1 (definition), Task 2 (call), and the Interfaces blocks. `Row` type is the existing one (`:55`). `sqlStr` is the existing helper (`:41`). ✓

---

## Execution Handoff

Plan complete and saved to `.planning/2026-08-01-hermes-legacy-id-graph-orphan/plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session via executing-plans, checkpoints for review.
