# Hermes Memory-Worth Scoring (Data + Scoring Layer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add memory-worth integer counters (`mw_success`/`mw_fail`, default 0) to each memory entry, applied as a query-time Laplace multiplier `score *= p_success / 0.5` (`p_success = (s+1)/(s+f+2)`; `0/0 → 1.0`) in the shared `graph-ranker`. This plan is the **data + scoring layer only** — the automatic session-outcome **trigger** is Plan 3 (it calls `bumpMemoryWorth`, wired in a later plan). Plan 2 is independently testable: bump worth manually → ranking changes.

**Architecture:** Hermes memory = §-delimited Markdown (source of truth) + SQLite/SurrealDB search index (`config.dbBackend`). Worth counters are **dual-resident**: in the `.md` meta comment (Plan 1's `<!-- meta:{json} -->` channel — counters survive clone/re-sync/commit) AND as read-side DB columns (so the multiplier scores without re-parsing `.md`). `.md` is the source of truth; the DB mirrors it (`syncMemoryEntry` seeds counters on INSERT, preserves them on MERGE). The multiplier lives in ONE place — `graph-ranker.ts:rankMemoryEntries` — serving both backends (both route their merged candidate pool through it). A new `bumpMemoryWorth(id, successDelta?, failDelta?)` repo method is the API Plan 3's trigger will call (DB-side bump; Plan 3 adds the `.md` write-through).

**Tech Stack:** TypeScript, `bun test` (`node:test` + `node:assert/strict` for store tests; `bun:test` `expect/it` for the sqlite-repo + contract tests — match each file's existing convention), on-disk tmpdir fixtures.

**Spec reconciliation (from the planning-phase codebase read):**
- **Design X (.md source of truth, DB mirrors) — corrects an earlier framing.** Plan 1's stated purpose was to carry worth counters in `.md`; spec 06 says "MD stays source of truth." So counters go in BOTH the `.md` meta channel AND the DB columns (not DB-only). The earlier "DB-authoritative like `last_referenced`" framing was wrong — worth counters are *learned* and must survive re-sync/clone; `last_referenced` is a different (touch-only) signal.
- **No-neighbor fast-path NOT closed in Plan 2.** Both repos short-circuit `if (neighbors.length === 0) return lexicalResults.slice(0, limit)` *before* `rankMemoryEntries` (`sqlite-memory-repo.ts:299`, `surreal-memory-repo.ts:159`). Closing it changes ranking order even with all-zero worth (recency-normalized vs raw `last_referenced DESC`) — a behavior change only motivated once worth is non-zero. **Defer the closure to Plan 3** (alongside the trigger). Plan 2's ranking contract assertion forces the ranker path via a shared graph neighbor, so the multiplier IS exercised in-search without closing the fast path.
- **Surreal tests are gated** on `isSurrealUp()`. The Surreal repo changes (Task 5) are dual-backend-mirrored from SQLite (mechanical) and verified by the shared contract test (Task 7) **when a SurrealDB instance is available**; without one, those tests skip (not fail). CI without Surreal validates Surreal changes by code review + structural symmetry only.
- **`mwSuccess`/`mwFail` are OPTIONAL on `MemoryEntry`** (`mwSuccess?: number`) to avoid fan-out churning every test fixture; DB `mapRow` always sets them, and the multiplier does `?? 0`.

## Global Constraints

- **Dual-backend symmetry:** every DB-column/mapRow/INSERT change is made in BOTH `sqlite-memory-repo.ts` and `surreal-memory-repo.ts`, and both must pass the shared `repository-contract.test.ts` (when Surreal is up). No backend-only behavior.
- **`.md` is source of truth for counters; DB mirrors.** `syncMemoryEntry` INSERT seeds counters from the parsed `.md`; MERGE preserves the existing DB counter (trigger may have bumped it). Merge/replace UPDATEs do NOT touch worth.
- **No behavior change to search ranking in Plan 2** (the fast-path stays; all-zero worth → multiplier 1.0 → ranking unchanged). The multiplier is provably correct via the ranker unit test + a shared-neighbor contract assertion.
- `MemoryEntry`/`MemoryRepository` live in `src/store/repository.ts` (not `types.ts`). Provenance/`sources[]` (Plan 1) is untouched.
- Run tests via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test … )` — never top-level `cd` (a git hook blocks it); always `( cd … && … )`.

## File Structure

- **Modify:** `src/store/repository.ts` — `MemoryEntry` (+`mwSuccess?`/`mwFail?`), `MemorySyncInput` (+same), `MemoryRepository` (+`bumpMemoryWorth`).
- **Modify:** `src/store/memory-format.ts` — widen `parseMetadataComment`/`serializeMetadataComment`/`ParsedMarkdownMemoryEntry` to carry `mwSuccess?`/`mwFail?` (generic JSON; no regex change).
- **Modify:** `src/store/memory-store.ts` — `encodeEntry` meta type + `_replaceInner` preserve worth (mirror Plan 1's provenance-preserve); `entriesWithMeta` return widens.
- **Modify:** `src/store/sqlite/schema.ts` — `memories` DDL + `mw_success`/`mw_fail`.
- **Modify:** `src/store/sqlite/sqlite-backend.ts` — `ensureMemoriesColumns` + `copyMemories` + BOTH `migrateLegacyMemoriesTargetConstraint` rebuild branches.
- **Modify:** `src/store/sqlite/sqlite-memory-repo.ts` — `MEMORY_SELECT_COLUMNS`/`MemoryRow`/`mapRow`/both INSERTs + `bumpMemoryWorth`.
- **Modify:** `src/store/surreal/surreal-memory-repo.ts` — `FIELDS`/`Row`/`mapRow`/`addMemory` SET + `bumpMemoryWorth` (no `schema.ts` change — SCHEMALESS).
- **Modify:** `src/store/graph-ranker.ts` — `worthMultiplier(entry)` folded into the score line.
- **Modify tests:** `tests/store/memory-format.test.ts`, `tests/store/memory-metadata.test.ts`, `tests/store/sqlite-memory-repo.test.ts`, `tests/store/surreal-memory-repo.test.ts` (or contract), `tests/store/graph-ranker.test.ts`, `tests/store/repository-contract.test.ts`, `tests/store/db.test.ts` (migration).

---

## Task 1: Types + pure-fn meta channel for worth counters

**Files:**
- Modify: `src/store/repository.ts:10-21` (`MemoryEntry`), `:23-33` (`MemorySyncInput`), `:45-61` (`MemoryRepository`)
- Modify: `src/store/memory-format.ts` (`parseMetadataComment`, `serializeMetadataComment`, `ParsedMarkdownMemoryEntry`, `parseMarkdownMemoryEntry`)
- Modify: `tests/store/memory-format.test.ts`

**Interfaces:**
- Produces: `MemoryEntry.mwSuccess?: number; mwFail?: number`; `MemorySyncInput.mwSuccess?: number | null; mwFail?: number | null`; `MemoryRepository.bumpMemoryWorth(id, successDelta?, failDelta?)`; `parseMetadataComment`/`serializeMetadataComment` carry `mwSuccess?`/`mwFail?`.

- [ ] **Step 1: Write the failing test** — append to `tests/store/memory-format.test.ts`:

```typescript
import { serializeMetadataComment } from "../../src/store/memory-format.js";

describe("serializeMetadataComment — worth counters", () => {
  it("omits counters when zero (no meta bloat for new entries)", () => {
    const out = serializeMetadataComment({ text: "x", created: "2026-05-09", lastReferenced: "2026-05-10", mwSuccess: 0, mwFail: 0 });
    assert.strictEqual(out, "x <!-- created=2026-05-09, last=2026-05-10 -->");
  });
  it("emits non-zero counters in the meta comment", () => {
    const out = serializeMetadataComment({ text: "x", created: "2026-05-09", lastReferenced: "2026-05-10", mwSuccess: 5, mwFail: 1 });
    assert.ok(out.includes('"mwSuccess":5'));
    assert.ok(out.includes('"mwFail":1'));
  });
  it("round-trips non-zero counters through parseMetadataComment", () => {
    const encoded = serializeMetadataComment({ text: "fact", created: "2026-05-09", lastReferenced: "2026-05-10", mwSuccess: 7, mwFail: 2 });
    const decoded = parseMetadataComment(encoded);
    assert.strictEqual(decoded.mwSuccess, 7);
    assert.strictEqual(decoded.mwFail, 2);
    assert.strictEqual(decoded.text, "fact");
  });
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`. Expected: FAIL (no `mwSuccess`/`mwFail` on serialize input / parse return).

- [ ] **Step 3: Add types** — in `src/store/repository.ts`, add to `MemoryEntry` (after `lastReferenced`): `mwSuccess?: number; mwFail?: number;`. Add to `MemorySyncInput`: `mwSuccess?: number | null; mwFail?: number | null;`. Add to `MemoryRepository` (sibling to `touchMemory`): `bumpMemoryWorth(id: number, successDelta?: number, failDelta?: number): Promise<void>;`.

- [ ] **Step 4: Widen the meta channel** — in `src/store/memory-format.ts`:
  - `ParsedMarkdownMemoryEntry`: add `mwSuccess?: number | null; mwFail?: number | null;`.
  - Replace `parseMetadataComment` with a version that also reads `mwSuccess`/`mwFail` (same two-stage structure as Plan 1; widen the `JSON.parse` cast to `as { provenance?: Provenance; sources?: MemorySource[]; mwSuccess?: number; mwFail?: number }`, assign `mwSuccess = typeof parsed.mwSuccess === "number" ? parsed.mwSuccess : undefined` (same for `mwFail`), and include them in both returns via conditional spread).
  - Replace `serializeMetadataComment` input type to add `mwSuccess?: number | null; mwFail?: number | null;`; in the `meta` builder add `if (input.mwSuccess && input.mwSuccess > 0) meta.mwSuccess = input.mwSuccess; if (input.mwFail && input.mwFail > 0) meta.mwFail = input.mwFail;`; widen the final emit guard to `if (meta.provenance || meta.sources || meta.mwSuccess || meta.mwFail)`.
  - In `parseMarkdownMemoryEntry`: destructure `mwSuccess, mwFail` from `parseMetadataComment` and conditionally spread into both return paths (same pattern as Plan 1's provenance/sources).

- [ ] **Step 5: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add src/store/repository.ts src/store/memory-format.ts tests/store/memory-format.test.ts && git commit -m "feat(hermes-memory): worth counters on MemoryEntry + meta channel"`.

---

## Task 2: Thread worth through MemoryStore (preserve on replace)

**Files:**
- Modify: `src/store/memory-store.ts` (`encodeEntry` meta type, `_replaceInner`, `entriesWithMeta`)
- Modify: `tests/store/memory-metadata.test.ts`

**Interfaces:**
- Consumes: Plan 1's `encodeEntry(text, created, last, meta?)` + Task 1's widened meta.
- Produces: `MemoryStore` round-trips `mwSuccess`/`mwFail` via the meta comment; `_replaceInner` preserves them (mirrors Plan 1 Task 5's provenance-preserve).

- [ ] **Step 1: Write the failing test** — append to `tests/store/memory-metadata.test.ts`:

```typescript
  it("replace() preserves non-zero worth counters on the rewritten entry", async () => {
    // Craft a MEMORY.md directly with non-zero worth (no trigger yet to set it via add()).
    const memoryFile = path.join(MEMORY_DIR, "MEMORY.md");
    await fs.promises.mkdir(MEMORY_DIR, { recursive: true });
    await fs.promises.writeFile(
      memoryFile,
      'original fact <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{"mwSuccess":4,"mwFail":1} -->',
      "utf-8",
    );
    const store = makeStore();
    await store.loadFromDisk();
    const res = await store.replace("memory", "original fact", "updated fact");
    assert.strictEqual(res.success, true);
    const raw = await fs.promises.readFile(memoryFile, "utf-8");
    assert.ok(raw.includes("updated fact"));
    assert.ok(raw.includes('"mwSuccess":4'), "worth counters must survive replace");
  });
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )`. Expected: FAIL (`_replaceInner` re-encodes without meta → counters dropped).

- [ ] **Step 3: Preserve worth in `_replaceInner`** — in `src/store/memory-store.ts`, the `_replaceInner` encode call (Plan 1 Task 5 made it `this.encodeEntry(newContent, decoded.created, today, { provenance: decoded.provenance, sources: decoded.sources })`) — extend the meta object to also forward worth: `{ provenance: decoded.provenance, sources: decoded.sources, mwSuccess: decoded.mwSuccess, mwFail: decoded.mwFail }`. (No `encodeEntry` signature change needed — Plan 1's `meta?` already forwards arbitrary keys; just verify the `serializeMetadataComment` call in `encodeEntry` passes `mwSuccess`/`mwFail` through. If `encodeEntry` builds the serialize input explicitly, add `mwSuccess: meta?.mwSuccess, mwFail: meta?.mwFail` there.) Widen the `entriesWithMeta` return type to include `mwSuccess?: number; mwFail?: number;`.

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )` then the full store suite `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/ )`. Expected: PASS, no regression.

- [ ] **Step 5: Commit** — `git add src/store/memory-store.ts tests/store/memory-metadata.test.ts && git commit -m "feat(hermes-memory): preserve worth counters across replace"`.

---

## Task 3: SQLite schema + migrations for worth columns

**Files:**
- Modify: `src/store/sqlite/schema.ts:64-76` (`memories` DDL)
- Modify: `src/store/sqlite/sqlite-backend.ts` (`ensureMemoriesColumns`, `copyMemories`, both `migrateLegacyMemoriesTargetConstraint` branches)
- Modify: `tests/store/db.test.ts` (migration test, mirroring its legacy-migration pattern)

**Interfaces:**
- Produces: `memories.mw_success INTEGER NOT NULL DEFAULT 0` + `mw_fail INTEGER NOT NULL DEFAULT 0`; legacy DBs migrated via `ADD COLUMN`; the rebuild-table path + corruption self-heal carry the columns.

- [ ] **Step 1: Write the failing test** — add to `tests/store/db.test.ts` (mirror the existing "should migrate legacy memories table without category column" test shape using a `RawDatabase` to forge a legacy table):

```typescript
it("should add mw_success/mw_fail columns to a legacy memories table lacking them", () => {
  // Forge a legacy memories table WITHOUT mw_success/mw_fail, reopen the backend, assert columns exist with default 0.
  const legacy = new Database(path.join(tmpDir, "legacy.db"));
  legacy.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, target TEXT, content TEXT, created DATE, last_referenced DATE)`);
  legacy.exec(`INSERT INTO memories (target, content, created, last_referenced) VALUES ('memory','x','2026-01-01','2026-01-01')`);
  legacy.close();
  const reopen = new SqliteBackend(tmpDir); // tmpDir holds legacy.db renamed to sessions.db OR point backend at it per the existing test's mechanism
  reopen.init();   // triggers ensureMemoriesColumns
  const db = reopen.getDb();
  const cols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  assert.ok(cols.some(c => c.name === "mw_success"));
  assert.ok(cols.some(c => c.name === "mw_fail"));
  const row = db.prepare("SELECT mw_success, mw_fail FROM memories").get() as { mw_success: number; mw_fail: number };
  assert.strictEqual(row.mw_success, 0);
  assert.strictEqual(row.mw_fail, 0);
  reopen.close();
});
```
(Follow the exact forging mechanism the existing legacy-migration test in `db.test.ts` uses — read it first and mirror the backend-at-legacy-db wiring.)

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/db.test.ts )`. Expected: FAIL (no `mw_success` column).

- [ ] **Step 3: Add columns** — in `src/store/sqlite/schema.ts` `memories` DDL, append before the closing `)`: `,\n  mw_success INTEGER NOT NULL DEFAULT 0,\n  mw_fail INTEGER NOT NULL DEFAULT 0`. In `src/store/sqlite/sqlite-backend.ts` `ensureMemoriesColumns`, add: `if (!names.has('mw_success')) db.exec('ALTER TABLE memories ADD COLUMN mw_success INTEGER NOT NULL DEFAULT 0');` and the same for `mw_fail`. In `copyMemories` (`:262-299`): add `mw_success`, `mw_fail` to the INSERT column list + params + the `readTableRows` desired-columns list. In BOTH `migrateLegacyMemoriesTargetConstraint` rebuild branches (`:454-481` non-tx + `:483-513` tx): add the two columns to the `memories_new` DDL AND to the `INSERT INTO memories_new (…) SELECT … FROM memories` column list (both copies).

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/db.test.ts )`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/store/sqlite/schema.ts src/store/sqlite/sqlite-backend.ts tests/store/db.test.ts && git commit -m "feat(hermes-memory): sqlite mw_success/mw_fail columns + migrations"`.

---

## Task 4: SQLite repo — SELECT/row/mapper/INSERT + bumpMemoryWorth

**Files:**
- Modify: `src/store/sqlite/sqlite-memory-repo.ts` (`MEMORY_SELECT_COLUMNS`, `MemoryRow`, `mapRow`, `addMemory` INSERT + return, `syncMemoryEntry` INSERT; add `bumpMemoryWorth`)
- Modify: `tests/store/sqlite-memory-repo.test.ts`

**Interfaces:**
- Produces: `mapRow` returns `mwSuccess`/`mwFail`; INSERTs seed 0 (worth not set on add); `bumpMemoryWorth(id, successDelta, failDelta)` increments atomically; merge/replace UPDATEs unchanged (preserve).

- [ ] **Step 1: Write the failing test** — append to `tests/store/sqlite-memory-repo.test.ts` (bun:test `expect/it` per that file's convention):

```typescript
it("addMemory seeds mwSuccess/mwFail = 0; bumpMemoryWorth increments them", async () => {
  const entry = await repo.addMemory({ content: "worth-test", target: "memory" });
  expect(entry.mwSuccess).toBe(0);
  expect(entry.mwFail).toBe(0);
  await repo.bumpMemoryWorth(entry.id, 3, 1);
  const list = await repo.getMemories({ target: "memory" });
  const found = list.find((m) => m.id === entry.id)!;
  expect(found.mwSuccess).toBe(3);
  expect(found.mwFail).toBe(1);
});

it("syncMemoryEntry seeds worth from input on insert; merge preserves DB worth", async () => {
  const ins = await repo.syncMemoryEntry({ content: "seeded", target: "memory", mwSuccess: 2, mwFail: 0 });
  expect(ins.entry.mwSuccess).toBe(2);
  await repo.bumpMemoryWorth(ins.entry.id, 1, 0); // DB now 3
  // re-sync (merge path) must NOT overwrite the bumped DB counter
  await repo.syncMemoryEntry({ content: "seeded", target: "memory", mwSuccess: 2, mwFail: 0 });
  const list = await repo.getMemories({ target: "memory" });
  const found = list.find((m) => m.id === ins.entry.id)!;
  expect(found.mwSuccess).toBe(3);
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`. Expected: FAIL (`mwSuccess` undefined / `bumpMemoryWorth` not a function).

- [ ] **Step 3: Wire the columns** — in `sqlite-memory-repo.ts`: add `mw_success,\n  mw_fail,` to `MEMORY_SELECT_COLUMNS`; add `mw_success: number; mw_fail: number;` to `MemoryRow`; add `mwSuccess: row.mw_success, mwFail: row.mw_fail,` to `mapRow`. In `addMemory` INSERT add the two columns + `0, 0` params; in its returned object literal add `mwSuccess: 0, mwFail: 0`. In `syncMemoryEntry` new-row INSERT add the two columns + `(input.mwSuccess ?? 0), (input.mwFail ?? 0)` params. Add `bumpMemoryWorth` (mirror `touchMemory`):

```typescript
async bumpMemoryWorth(id: number, successDelta = 0, failDelta = 0): Promise<void> {
  return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
    this.db.prepare("UPDATE memories SET mw_success = mw_success + ?, mw_fail = mw_fail + ? WHERE id = ?").run(successDelta, failDelta, id);
  }));
}
```
(Do NOT touch the `syncMemoryEntry` merge UPDATE or `replaceSyncedMemories` UPDATE — worth is preserved, not overwritten.)

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/store/sqlite/sqlite-memory-repo.ts tests/store/sqlite-memory-repo.test.ts && git commit -m "feat(hermes-memory): sqlite repo worth columns + bumpMemoryWorth"`.

---

## Task 5: Surreal repo — FIELDS/row/mapper/SET + bumpMemoryWorth

**Files:**
- Modify: `src/store/surreal/surreal-memory-repo.ts` (`FIELDS`, `Row`, `mapRow`, `addMemory` SET; add `bumpMemoryWorth`)
- Modify: `tests/store/surreal-memory-repo-contract.test.ts` OR the contract test (gated on `isSurrealUp()`)

**Interfaces:**
- Produces: symmetric to Task 4 for SurrealDB (SCHEMALESS — no `schema.ts` change). `mapRow` coalesces missing fields to 0; `bumpMemoryWorth` coalesces on increment (handles pre-existing rows lacking the fields).

- [ ] **Step 1: Write the failing test** — in the surreal contract test file (gated on `isSurrealUp()`), add the same two assertions as Task 4 (`addMemory` seeds 0; `bumpMemoryWorth` increments; merge preserves). If no surreal instance in CI, this test skips — note that in the report.

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal-memory-repo-contract.test.ts )`. Expected: FAIL (if Surreal up) or SKIP (if down).

- [ ] **Step 3: Wire Surreal** — in `surreal-memory-repo.ts`: append `, mwSuccess, mwFail` to `FIELDS`; add `mwSuccess?: number; mwFail?: number;` to `Row`; add `mwSuccess: r.mwSuccess ?? 0, mwFail: r.mwFail ?? 0,` to `mapRow`; in `addMemory` SET clause add `mwSuccess = 0, mwFail = 0`. Add `bumpMemoryWorth`:

```typescript
async bumpMemoryWorth(id: number, successDelta = 0, failDelta = 0): Promise<void> {
  await this.c.query(
    `UPDATE memories SET mwSuccess = (mwSuccess ?? 0) + $s, mwFail = (mwFail ?? 0) + $f WHERE seq = $seq;`,
    { seq: Number(id), s: successDelta, f: failDelta },
  );
}
```
(Do NOT touch the merge/replace UPDATEs — worth preserved. SCHEMALESS means no `schema.ts` edit; `(field ?? 0)` handles pre-feature rows.)

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal-memory-repo-contract.test.ts )`. Expected: PASS (or SKIP if no Surreal — then verify by structural symmetry to Task 4 + the contract test in Task 7).

- [ ] **Step 5: Commit** — `git add src/store/surreal/surreal-memory-repo.ts tests/store/surreal-memory-repo-contract.test.ts && git commit -m "feat(hermes-memory): surreal repo worth columns + bumpMemoryWorth"`.

---

## Task 6: graph-ranker worth multiplier

**Files:**
- Modify: `src/store/graph-ranker.ts` (`rankMemoryEntries` score line + new `worthMultiplier`)
- Modify: `tests/store/graph-ranker.test.ts` (`mk(...)` builder + worth-ordering test)

**Interfaces:**
- Consumes: `MemoryEntry.mwSuccess`/`mwFail` (Task 1).
- Produces: `rankMemoryEntries` multiplies each candidate's base score by `worthMultiplier(entry)`.

- [ ] **Step 1: Write the failing test** — in `tests/store/graph-ranker.test.ts`, extend the `mk(...)` builder to accept optional `mwSuccess`/`mwFail` (default undefined → multiplier 1.0), then:

```typescript
it("worth multiplier ranks a high-success entry above a low-success one at equal lexical/graph/recency", () => {
  const low = mk({ id: 1, mwSuccess: 0, mwFail: 8 });   // p_success ≈ 0.1 → mult ≈ 0.2 (sinks)
  const high = mk({ id: 2, mwSuccess: 8, mwFail: 0 });  // p_success ≈ 0.9 → mult ≈ 1.8 (boosts)
  const out = rankMemoryEntries({ candidates: [low, high], lexicalMatchIds: new Set([1, 2]), limit: 2 });
  expect(out[0].id).toBe(2);  // high-worth first
  expect(out[1].id).toBe(1);
});

it("uninstrumented (0/0) entries get multiplier 1.0 — no ranking bias", () => {
  const a = mk({ id: 1 });  // mwSuccess/mwFail undefined → ?? 0 → mult 1.0
  const b = mk({ id: 2 });
  const out = rankMemoryEntries({ candidates: [a, b], lexicalMatchIds: new Set([1, 2]), limit: 2 });
  // tie → deterministic id-ascending tiebreak
  expect(out.map((e) => e.id)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/graph-ranker.test.ts )`. Expected: FAIL (worth doesn't affect order; `mk` doesn't accept mw_*).

- [ ] **Step 3: Add the multiplier** — in `src/store/graph-ranker.ts`, add a helper and fold it in:

```typescript
function worthMultiplier(entry: MemoryEntry): number {
  const s = entry.mwSuccess ?? 0;
  const f = entry.mwFail ?? 0;
  return ((s + 1) / (s + f + 2)) / 0.5; // Laplace-smoothed; 0/0 → (1/2)/0.5 = 1.0
}
```
Change the score line (`graph-ranker.ts:78`) from `const score = W_LEX * lexical + W_GRAPH * graphProximity + W_RECENCY * recencyNorm;` to:
```typescript
    const score = (W_LEX * lexical + W_GRAPH * graphProximity + W_RECENCY * recencyNorm) * worthMultiplier(entry);
```

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/graph-ranker.test.ts )`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/store/graph-ranker.ts tests/store/graph-ranker.test.ts && git commit -m "feat(hermes-memory): worth multiplier in graph-ranker"`.

---

## Task 7: Shared contract test — worth round-trip + ranking (both backends)

**Files:**
- Modify: `tests/store/repository-contract.test.ts` (the `runMemoryRepositoryContract` suite — runs for SQLite + Surreal)

**Interfaces:**
- Consumes: Tasks 1–6 (both backends carry + bump worth; ranker applies it).

- [ ] **Step 1: Write the failing test** — inside `runMemoryRepositoryContract`, add (mirror the graph-recall test's shape — a shared graph neighbor forces the ranker path so the multiplier applies in-search without closing the no-neighbor fast path):

```typescript
    it("worth: bumped entry outranks an equal-lexical peer via the ranker (shared-neighbor path)", async () => {
      const { repo, close } = await make();
      try {
        const nonce = "zxqwbu-worth-anchor";
        const high = await repo.addMemory({ content: `high-worth note ${nonce}`, target: "memory", project: "worth-proj" });
        const low = await repo.addMemory({ content: `low-worth note ${nonce}`, target: "memory", project: "worth-proj" });
        const neighbor = await repo.addMemory({ content: "shared project neighbor unrelated wording", target: "memory", project: "worth-proj" });
        await repo.bumpMemoryWorth(high.id, 8, 0);  // boost high
        await repo.bumpMemoryWorth(low.id, 0, 8);   // sink low
        const hits = await repo.searchMemories(nonce);
        const highIdx = hits.findIndex((h) => h.id === high.id);
        const lowIdx = hits.findIndex((h) => h.id === low.id);
        expect(highIdx).toBeGreaterThanOrEqual(0);
        expect(lowIdx).toBeGreaterThanOrEqual(0);
        expect(highIdx).toBeLessThan(lowIdx);  // high-worth ranks above low-worth
      } finally { await close(); }
    });

    it("worth: addMemory seeds 0; bumpMemoryWorth increments; fields surface on getMemories", async () => {
      const { repo, close } = await make();
      try {
        const e = await repo.addMemory({ content: "worth-roundtrip", target: "memory" });
        expect(e.mwSuccess).toBe(0);
        expect(e.mwFail).toBe(0);
        await repo.bumpMemoryWorth(e.id, 2, 1);
        const got = await repo.getMemories({ target: "memory" });
        const found = got.find((m) => m.id === e.id)!;
        expect(found.mwSuccess).toBe(2);
        expect(found.mwFail).toBe(1);
      } finally { await close(); }
    });
```

- [ ] **Step 2: Run RED then GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )` (SQLite); the Surreal instantiation (`surreal-memory-repo-contract.test.ts`) runs the same suite when Surreal is up. Fix any backend asymmetry the contract exposes.

- [ ] **Step 3: Commit** — `git add tests/store/repository-contract.test.ts && git commit -m "test(hermes-memory): worth round-trip + ranking contract (both backends)"`.

---

## Self-Review

1. **Spec coverage (06 item #1):** counters on `MemoryEntry` + `.md` meta (Task 1/2) + DB columns dual-backend (Task 3/4/5) + Laplace multiplier `p_success/0.5` (Task 6) + `bumpMemoryWorth` (Task 4/5) + contract (Task 7). ✅ The TRIGGER (increment on session outcome) is explicitly Plan 3 — flagged in Goal + Architecture.
2. **Placeholder scan:** every code step has real code; the one place to "mirror an existing test's forging mechanism" (Task 3 Step 1) names the exact reference test to copy — read it first. No TBD/TODO.
3. **Type consistency:** `mwSuccess`/`mwFail` (camelCase DTO) ↔ `mw_success`/`mw_fail` (snake_case DB) match the existing `failureReason`/`failure_reason` convention; Surreal uses camelCase (matches its existing `FIELDS`). `bumpMemoryWorth(id, successDelta?, failDelta?)` signature identical on the interface + both repos.
4. **Dual-backend symmetry:** Tasks 3/4 (SQLite) and 5 (Surreal) are mirrored; Task 7's contract runs for both. Surreal SCHEMALESS → no DDL; `(field ?? 0)` handles pre-feature rows.
5. **Behavior change audit:** the no-neighbor fast-path is NOT closed (deferred to Plan 3) → no ranking-order change in Plan 2 (all-zero worth → multiplier 1.0). The multiplier is proven via the ranker unit test (Task 6) + a shared-neighbor contract assertion (Task 7) that forces the ranker path.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-hermes-memory-worth-scoring.md`.

**Two execution options:**
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between, fast iteration (same flow as Plan 1).
2. **Inline Execution** — execute in this session via executing-plans.

**Which approach?**

This is **Plan 2 of the Tier-1 worth-scoring feature (data + scoring layer).** Plan 3 = the worth **trigger** (recall-set + `turn_end` handler + `isCorrection`/`isLessonWorthy` classification + `bumpMemoryWorth` calls + `.md` write-through + the no-neighbor fast-path closure). Plan 4 = supersession. Plan 2 is a prerequisite for Plan 3 (which calls `bumpMemoryWorth` and relies on the `mw_*` columns + multiplier landing first).
