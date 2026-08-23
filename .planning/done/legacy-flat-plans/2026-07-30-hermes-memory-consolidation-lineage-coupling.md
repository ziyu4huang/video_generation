# Hermes-Memory Consolidation-Lineage Coupling (5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent consolidation/trim from resurrecting superseded memory or breaking active lineage chains — capacity pressure offloads superseded entries first; only all-active overflow triggers destructive consolidation.

**Architecture:** Four grilling-resolved decisions (D0–D4) shape a unified capacity loop. Consolidation is **destructive** (D0): the LLM-merged entry is fresh-active with no inherited lineage; consumed entries and their DB rows are deleted with no audit (D4). On any overflow, the store **offloads superseded first** (D2): an injected provider queries the DB for superseded contents, the store purges matching `.md` entries by content-key, and the caller syncs the DB. **Trim never touches active** (D3): `fifo-evict`/`vault-offload`/`reject` all fall back to consolidation when only active entries remain, so active lineage chains never break. The `.md` format is untouched (no status frontmatter); DB↔`.md` bridging uses the existing `removeExactSyncedMemories` content-key mechanism.

**Tech Stack:** TypeScript (Bun), SQLite + SurrealDB dual backend (`MemoryRepository`), `.md`-ground-truth `MemoryStore`, in-process `spawnSubagent` consolidation.

## Global Constraints

- **Dual backend:** Every read-side DB change (the `getMemories` status filter in Task 1) must land in BOTH `sqlite-memory-repo.ts` and `surreal-memory-repo.ts` and pass the shared `tests/store/repository-contract.test.ts`.
- **`.md` stays source of truth, no schema change:** No `status`/`id` frontmatter added to `.md` entries. DB↔`.md` bridging is content-key only (existing `stripMetadata` + `removeExactSyncedMemories`).
- **Layer discipline:** `MemoryStore` does not hold a `MemoryRepository` reference. Cross-layer capability is injected via a provider callback, mirroring the existing `setConsolidator(fn)` pattern.
- **Destructive consolidation (D0/D4):** Consolidation produces a fresh-active entry with NO lineage; consumed entries are hard-removed from `.md` AND their DB rows deleted (no `archived`/audit status).
- **TDD:** Each task writes the failing test first, verifies RED, implements minimal code, verifies GREEN, commits. Mutation-verify guard/contract tests.
- **No top-level `cd`** (repo has `no-cd-drift.sh`); use `( cd <dir> && ... )` or `--cwd`.
- **Run tests from repo root:** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test <path> )`.
- **Typecheck:** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — must be clean before each commit.
- **Shell discipline / venv** rules from `CLAUDE.md` apply.

---

## File Structure

- **Modify** `src/store/repository.ts` — extend `MemoryListOptions` with `status`, extend the `MemoryRepository` interface comment.
- **Modify** `src/store/sqlite/sqlite-memory-repo.ts` — `getMemories` honors `status`.
- **Modify** `src/store/surreal/surreal-memory-repo.ts` — `getMemories` honors `status`.
- **Modify** `tests/store/repository-contract.test.ts` — add a status-filter contract test (runs on both backends).
- **Modify** `src/store/memory-store.ts` — add `setSupersededContentProvider`, `purgeSupersededFromMarkdown`, insert offload-superseded-first into the overflow path, route all-active overflow to consolidation.
- **Modify** `tests/store/memory-store.test.ts` — unit-test the provider injection + purge + overflow routing.
- **Modify** `src/index.ts` — wire the provider (binds `repo.getMemories` with `status:"superseded"`).
- **Modify** `src/handlers/review-memory-ops.ts` (or the memory-tool add caller) — sync DB rows for purged superseded entries via `syncEvictions`.
- **Modify** `tests/handlers/` — integration test for the capacity→offload-superseded→sync loop.
- **Add** a resurrect-stale guard contract test asserting a superseded entry is never recalled after consolidation.

---

## Task 1: DB `getMemories` status filter (dual backend)

**Files:**
- Modify: `src/store/repository.ts:48` (extend `MemoryListOptions`), `src/store/sqlite/sqlite-memory-repo.ts:632` (`getMemories`), `src/store/surreal/surreal-memory-repo.ts` (`getMemories`)
- Test: `tests/store/repository-contract.test.ts`

**Interfaces:**
- Consumes: existing `MemoryRepository.getMemories`, `MemoryEntry.content`, the `status: "active"|"superseded"` column (already present on both backends from the merged 5c work).
- Produces: `getMemories({ ..., status?: "active" | "superseded" })` returns entries filtered by the `status` column. Later tasks (Task 3 wiring) call `repo.getMemories({ target, project, status: "superseded" })` to source the superseded content list.

- [ ] **Step 1: Write the failing contract test**

Append to `tests/store/repository-contract.test.ts` (inside the shared contract suite that runs on both SQLite and Surreal backends). This test seeds an active and a superseded entry (supersede via the existing `supersedeMemory` flow from 5c), then asserts the filter:

```typescript
it("getMemories filters by status when the status option is set", async () => {
  // Seed two active memories in the same project/target.
  const a = await repo.addMemory({
    target: "memory",
    project: "status-filter-proj",
    content: "status filter active one zqxklt",
    category: "insight",
    failureReason: null,
    toolState: null,
    correctedTo: null,
  });
  const b = await repo.addMemory({
    target: "memory",
    project: "status-filter-proj",
    content: "status filter active two zqxklt",
    category: "insight",
    failureReason: null,
    toolState: null,
    correctedTo: null,
  });
  // Supersede b with a (b becomes superseded).
  await repo.supersedeMemory(b.id, a.id);

  const active = await repo.getMemories({ project: "status-filter-proj", status: "active" });
  const superseded = await repo.getMemories({ project: "status-filter-proj", status: "superseded" });
  const all = await repo.getMemories({ project: "status-filter-proj" });

  // active filter returns only the non-superseded entry.
  expect(active.some((m) => m.id === a.id)).toBe(true);
  expect(active.some((m) => m.id === b.id)).toBe(false);
  // superseded filter returns only the superseded entry.
  expect(superseded.some((m) => m.id === b.id)).toBe(true);
  expect(superseded.some((m) => m.id === a.id)).toBe(false);
  // no status filter returns both (back-compat: existing callers unaffected).
  expect(all.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )`
Expected: FAIL — `status` is not a known property on `MemoryListOptions` (type error) and/or the backend ignores it (returns both entries).

- [ ] **Step 3: Extend `MemoryListOptions`**

In `src/store/repository.ts`, change the interface:

```typescript
export interface MemoryListOptions {
  project?: string | null;
  target?: MemoryTarget;
  category?: import("../types.js").MemoryCategory;
  /** When set, filter by the supersession status column. Omit = return all. */
  status?: "active" | "superseded";
}
```

- [ ] **Step 4: Implement the SQLite filter**

In `src/store/sqlite/sqlite-memory-repo.ts`, locate `getMemories(options: MemoryListOptions = {})` (line ~632). Add a `status` clause to the WHERE construction, mirroring how `searchMemories` already pushes `"m.status = 'active'"` (see line ~485 for the established pattern). Concretely, build the conditions array and append `options.status ? \`m.status = '${options.status}'\` ` only when `options.status` is set:

```typescript
async getMemories(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
  const conditions: string[] = [];
  if (options.project !== undefined) conditions.push("m.project IS ?", options.project ?? null);
  if (options.target) conditions.push("m.target = ?", options.target);
  if (options.category) conditions.push("m.category = ?", options.category);
  if (options.status) conditions.push("m.status = ?", options.status);
  // ... assemble the existing SELECT with the conditions, preserving the current
  // row-mapping (mapRow). Keep ORDER BY created DESC as today.
}
```

(Adapt the existing parameter-binding style already used in this method — do not introduce string interpolation for values; use `?` placeholders as the surrounding code does. The `options.status` value is the literal enum, safe to bind.)

- [ ] **Step 5: Implement the Surreal filter**

In `src/store/surreal/surreal-memory-repo.ts`, locate `getMemories` and add the equivalent `status` WHERE clause using SurrealQL parameter binding (the existing method already builds a WHERE with `project`/`target`/`category` — append `status = $status` when set, threaded through the same params object).

- [ ] **Step 6: Run the contract test to verify it passes on BOTH backends**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )`
Expected: PASS on SQLite and (when the Surreal harness is live) Surreal. If the Surreal harness is not running locally, confirm the SQLite path passes and note Surreal as CI-gated (the determinism + contract CI jobs exercise it).

- [ ] **Step 7: Typecheck + commit**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )
git add bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/repository-contract.test.ts
git commit -m "feat(hermes-memory): getMemories supports status filter (dual backend)"
```

---

## Task 2: MemoryStore offload-superseded-first + active-only→consolidate routing

**Files:**
- Modify: `src/store/memory-store.ts` (constructor area ~line 58, `setConsolidator` neighbor; overflow path in `add` ~line 488–520; new private helper)
- Test: `tests/store/memory-store.test.ts`

**Interfaces:**
- Consumes: Task 1's `MemoryListOptions.status` (via the injected provider, which the wiring in Task 3 binds to `repo.getMemories`).
- Produces:
  - `setSupersededContentProvider(fn: (target) => Promise<string[]>): void` — mirrors `setConsolidator`.
  - The `add()` overflow path now: (a) purges superseded first via the provider, (b) re-probes, (c) if still over and only active remains, routes ALL strategies to consolidation (never `fifo`/`vault` shift on active).
  - `MemoryResult` gains an optional `offloaded_superseded?: string[]` field so the caller can DB-sync purged rows.

- [ ] **Step 1: Write the failing unit test**

In `tests/store/memory-store.test.ts`, add a test that uses a tiny in-memory config + a fake provider to prove superseded entries are purged before any destructive strategy runs. (Use the existing test harness in this file for constructing a `MemoryStore` with a low char limit — copy the setup pattern from an existing capacity test in the file.)

```typescript
// This test is added INSIDE the existing describe block, so `makeConfig`
// (helper at line ~33) and the temp memoryDir (beforeEach) are already in
// scope — do not re-import. memoryCharLimit: 60 forces overflow on the third
// short add (see the existing overflow test at line ~189 using limit 50).
it("overflow offloads superseded entries first (injected provider) before any destructive strategy", async () => {
  const store = new MemoryStore(makeConfig({ memoryCharLimit: 60 }));

  // Seed two active entries + pretend the DB reports the FIRST as superseded.
  await store.add("memory", "keep me active overflowprobe aaa");
  await store.add("memory", "superseded one overflowprobe bbb");
  // Provider returns the content of the entry that is superseded in the DB.
  store.setSupersededContentProvider(async () => ["superseded one overflowprobe bbb"]);

  // This add overflows; expect the superseded entry purged and the new one added.
  const result = await store.add("memory", "new entry overflowprobe ccc");

  expect(result.success).toBe(true);
  expect(result.offloaded_superseded).toEqual(["superseded one overflowprobe bbb"]);

  // The superseded entry must no longer be in the .md entries.
  const entries = store.getMemoryEntries();
  expect(entries.some((e) => e.includes("superseded one overflowprobe bbb"))).toBe(false);
  // The active entry and the new entry remain.
  expect(entries.some((e) => e.includes("keep me active overflowprobe aaa"))).toBe(true);
  expect(entries.some((e) => e.includes("new entry overflowprobe ccc"))).toBe(true);
});
```

Also add the companion test for D3 (active-only overflow routes to consolidation, never touches active):

```typescript
it("all-active overflow routes to consolidation, not fifo/vault shift", async () => {
  // Use fifo-evict strategy to PROVE even fifo now consolidates instead of shift()ing active.
  const store = new MemoryStore(makeConfig({ memoryCharLimit: 60, memoryOverflowStrategy: "fifo-evict" }));
  await store.add("memory", "active one activeonlyprobe aaa");
  await store.add("memory", "active two activeonlyprobe bbb");
  // No superseded to offload.
  store.setSupersededContentProvider(async () => []);
  let consolidateCalls = 0;
  store.setConsolidator(async () => {
    consolidateCalls++;
    // Simulate consolidation freeing space: clear the store so the retried _addInner fits.
    // (Real consolidation rewrites the .md; the stub fakes that by emptying entries + saving.)
    (store as unknown as { setEntries: (t: "memory" | "user" | "failure", e: string[]) => void }).setEntries("memory", []);
    return { consolidated: true };
  }, "stub");

  // Overflow with no superseded available → must consolidate, not fifo-shift active.
  const result = await store.add("memory", "overflow activeonlyprobe ccc");

  // D3: consolidator was invoked (under the old fifo-evict branch it would have
  // shift()'d an active entry without ever calling the consolidator).
  expect(consolidateCalls).toBeGreaterThan(0);
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )`
Expected: FAIL — `setSupersededContentProvider` is not a function; `offloaded_superseded` is undefined.

- [ ] **Step 3: Add the provider field + setter**

In `src/store/memory-store.ts`, near the existing `consolidator` field and `setConsolidator` method (after the constructor, ~line 60), add:

```typescript
private supersededContentProvider: ((target: "memory" | "user" | "failure") => Promise<string[]>) | null = null;

/**
 * Inject a provider that returns the CONTENTS of superseded entries for a target
 * (sourced from the DB status column). Mirrors setConsolidator's injection
 * pattern — keeps MemoryStore free of a direct MemoryRepository reference.
 * Called from index.ts once the repo is available.
 */
setSupersededContentProvider(fn: (target: "memory" | "user" | "failure") => Promise<string[]>): void {
  this.supersededContentProvider = fn;
}
```

- [ ] **Step 4: Add the purge helper**

Add a private method that removes content-matched entries from the in-memory `.md` entry list and persists. It reuses the existing `stripMetadata` for matching (so metadata comments don't defeat the content-key match) and `setEntries`/`saveToDisk` for persistence (mirror `fifoEvictAndAdd`'s persistence steps):

```typescript
/**
 * Remove entries whose stripped content matches one of `supersededContents`.
 * Content-key match (D2): .md has no id, so we match on stripped content — the
 * same key removeExactSyncedMemories uses on the DB side. Returns the purged
 * (stripped) contents so the caller can sync the DB rows.
 */
private async purgeSupersededFromMarkdown(
  target: "memory" | "user" | "failure",
  supersededContents: string[],
): Promise<string[]> {
  if (supersededContents.length === 0) return [];
  const want = new Set(supersededContents);
  const entries = this.entriesFor(target);
  const purged: string[] = [];
  const remaining: string[] = [];
  for (const entry of entries) {
    const stripped = this.stripMetadata(entry);
    if (want.has(stripped)) {
      purged.push(stripped);
    } else {
      remaining.push(entry);
    }
  }
  if (purged.length > 0) {
    this.setEntries(target, remaining);
    await this.saveToDisk(target);
  }
  return purged;
}
```

- [ ] **Step 5: Insert offload-superseded-first into the overflow path**

The overflow logic lives in `_addInner` (the private inner that `add` delegates to under `runExclusive` + `withFileLock`). Its signature is `_addInner(target, content, signal?, _retriesLeft = 1, addedMessage, onProgress?, meta?)`. The current overflow block (memory-store.ts ~line 488–520) reads:

```typescript
const newTotal = [...entries, encoded].join(ENTRY_DELIMITER).length;
if (newTotal > limit) {
  const strategy = this.memoryOverflowStrategy();
  if (strategy === "fifo-evict") return this.fifoEvictAndAdd(target, entries, encoded, content.length, limit);
  if (strategy === "vault-offload") return this.vaultOffloadAndAdd(target, entries, encoded, content.length, limit);
  if (strategy === "auto-consolidate") {
    if (this.consolidator && _retriesLeft > 0) {
      try {
        const result = await this.runConsolidator(target, signal, onProgress);
        if (result.consolidated) {
          await this.loadFromDisk();
          return this._addInner(target, content, signal, _retriesLeft - 1, addedMessage, onProgress, meta);
        }
      } catch { /* fall through to floor */ }
    }
    return this.vaultOffloadAndAdd(target, entries, encoded, content.length, limit);  // FLOOR
  }
  return this.memoryFullError(target, content.length);  // reject
}
```

Rewrite this block to (a) offload superseded first (D2), and (b) collapse fifo-evict/vault-offload/auto-consolidate onto the consolidation path with the existing vault-offload floor, leaving only `reject` to hard-reject (D3: trim never `shift()`s active). Replace the whole `if (newTotal > limit) { ... }` body with:

```typescript
if (newTotal > limit) {
  // D2: offload superseded entries first. They are semantic discard and must
  // never be resurrected into a consolidation merge. Provider is injected
  // (setSupersededContentProvider); absent in unit/test contexts.
  let offloadedSuperseded: string[] = [];
  if (this.supersededContentProvider) {
    try {
      const supersededContents = await this.supersededContentProvider(target);
      offloadedSuperseded = await this.purgeSupersededFromMarkdown(target, supersededContents);
    } catch {
      offloadedSuperseded = [];  // provider failure is non-fatal
    }
  }
  if (offloadedSuperseded.length > 0) {
    const afterPurge = this.entriesFor(target);
    const reTotal = [...afterPurge, encoded].join(ENTRY_DELIMITER).length;
    if (reTotal <= limit) {
      afterPurge.push(encoded);
      this.setEntries(target, afterPurge);
      await this.saveToDisk(target);
      return {
        ...this.successResponse(target, `Memory updated. Offloaded ${offloadedSuperseded.length} superseded ${offloadedSuperseded.length === 1 ? "entry" : "entries"} to stay within the limit.`),
        offloaded_superseded: offloadedSuperseded,
      };
    }
    // Still over after purge → only active remains. Fall through to consolidation.
  }

  const strategy = this.memoryOverflowStrategy();
  // D3: superseded already purged, so remaining overflow is all-active. The
  // fifo-evict/vault-offload branches used to shift() active entries here,
  // breaking lineage chains. Collapse every non-reject strategy onto the
  // consolidation path (runConsolidator + the existing vault-offload floor),
  // so active entries are never silently shifted. Only "reject" hard-rejects.
  if (strategy !== "reject") {
    if (this.consolidator && _retriesLeft > 0) {
      try {
        const result = await this.runConsolidator(target, signal, onProgress);
        if (result.consolidated) {
          await this.loadFromDisk();
          return this._addInner(target, content, signal, _retriesLeft - 1, addedMessage, onProgress, meta);
        }
      } catch { /* fall through to floor */ }
    }
    // FLOOR: vault-offload as last resort (preserves the never-hard-reject
    // guarantee for non-reject strategies). Active lineage may break here ONLY
    // in the rare consolidation-failure case — accepted as destructive capacity
    // compaction (consistent with D0).
    return this.vaultOffloadAndAdd(target, this.entriesFor(target), encoded, content.length, limit);
  }
  return this.memoryFullError(target, content.length);
}
```

> **Note on dead code:** after this change, `_addInner` never calls `fifoEvictAndAdd` (fifo-evict no longer dispatches to it). Leave `fifoEvictAndAdd` in place for now (existing tests may reference it); do not delete it in this task. The behavioral guarantee is: `_addInner`'s overflow never `shift()`s an active entry when superseded are absent — it consolidates instead.

- [ ] **Step 6: Add `offloaded_superseded` to the result type**

In `src/types.ts`, extend the `MemoryResult` interface (where `evicted_entries`/`evicted_count`/`transferred_entries` already live) with:

```typescript
offloaded_superseded?: string[];
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )`
Expected: both new tests PASS, and no existing capacity/overflow test regresses.

- [ ] **Step 8: Mutation-verify the D3 guard**

Mutation A (D3 lock): temporarily restore the original dispatch — replace the `if (strategy !== "reject") { ... }` block with the old `if (strategy === "fifo-evict") return this.fifoEvictAndAdd(...)` / `if (strategy === "vault-offload") return this.vaultOffloadAndAdd(...)` branches (so fifo/vault `shift()` active again). Re-run the "all-active overflow routes to consolidation" test → expect FAIL (`consolidateCalls` stays 0 because fifo-evict shifted an active entry instead of consolidating). Revert.

Mutation B (D2 lock): short-circuit the provider (`const supersededContents = [];`). Re-run the offload-superseded test → expect FAIL (the superseded entry was NOT purged from `.md`). Revert.

Confirm both mutations RED, originals GREEN. This proves the tests lock both D2 (purge) and D3 (no active shift).

- [ ] **Step 9: Typecheck + commit**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/types.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts
git commit -m "feat(hermes-memory): overflow offloads superseded first; all-active routes to consolidation"
```

---

## Task 3: Wire provider + DB sync (D2 complete, D4 destructive)

**Files:**
- Modify: `src/index.ts` (wire `setSupersededContentProvider` alongside `setConsolidator`)
- Modify: `src/handlers/review-memory-ops.ts` (`syncEvictions` already handles `evicted_entries`; extend the caller to also sync `offloaded_superseded`)
- Modify: `src/tools/memory-tool.ts` (the primary `store.add` caller at line ~388 — surface `offloaded_superseded` to the same sync path)
- Test: `tests/handlers/review-memory-ops.test.ts` (or a new integration test)

**Interfaces:**
- Consumes: Task 1 `getMemories({status:"superseded"})`, Task 2 `setSupersededContentProvider` + `MemoryResult.offloaded_superseded`, existing `syncEvictions`/`removeExactSyncedMemories`.
- Produces: an end-to-end loop — capacity hit → DB superseded queried → `.md` purged → DB rows deleted (destructive, no audit). Consolidation's consumed entries are synced the same way (existing `loadFromDisk` + `syncEvictions` difference).

- [ ] **Step 1: Write the failing integration test**

Prefer a new file `tests/handlers/overflow-superseded-sync.test.ts` so the store+repo fixture is self-contained. The fixture mirrors `correction-detector.test.ts:233-331` exactly: a temp dir, `new SqliteBackend(tmpDir)`, `new SqliteMemoryRepository(backend)`, and a `MemoryStore` with a low `memoryCharLimit` (80) so the overflow add trips the limit. Imports needed:

```typescript
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { applyReviewOperations } from "../../src/handlers/review-memory-ops.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// beforeEach: tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-sync-"));
//   backend = new SqliteBackend(tmpDir);
//   repo = new SqliteMemoryRepository(backend);
//   store = new MemoryStore({ memoryDir: tmpDir, memoryCharLimit: 80 } as any);
// afterEach: await backend.close(); fs.rmSync(tmpDir, { recursive: true, force: true });

it("overflow add offloads a superseded entry and deletes its DB row (D2 + D4 destructive)", async () => {
  // active + superseded in the same target/project
  const active = await repo.addMemory({ target: "memory", project: "sync-proj", content: "active keeper syncprobe yyy", category: "insight", failureReason: null, toolState: null, correctedTo: null });
  const prior = await repo.addMemory({ target: "memory", project: "sync-proj", content: "superseded doomed syncprobe yyy", category: "insight", failureReason: null, toolState: null, correctedTo: null });
  await repo.supersedeMemory(prior.id, active.id);

  // Wire the provider the same way index.ts will.
  store.setSupersededContentProvider(async (t) => {
    const list = await repo.getMemories({ target: t, project: "sync-proj", status: "superseded" });
    return list.map((m) => m.content);
  });

  // Drive an overflow add through the operation path that syncs evictions.
  const result = await applyReviewOperations(store, null, [{
    target: "memory",
    operation: "add",
    content: "new overflow syncprobe zzz".repeat(20),  // large enough to overflow the low limit
  }], repo, "sync-proj");

  // The superseded entry's DB row must be deleted (D4: destructive, no audit row).
  const remaining = await repo.getMemories({ project: "sync-proj" });
  expect(remaining.some((m) => m.content.includes("superseded doomed syncprobe yyy"))).toBe(false);
  // The active keeper survives.
  expect(remaining.some((m) => m.content.includes("active keeper syncprobe yyy"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/review-memory-ops.test.ts )`
Expected: FAIL — the DB row for the superseded entry is still present (no sync of `offloaded_superseded`).

- [ ] **Step 3: Wire the provider in `index.ts`**

In `src/index.ts`, where `store.setConsolidator(...)` is already called (after the repo is constructed), add the provider binding immediately after:

```typescript
store.setSupersededContentProvider(async (target) => {
  // status filter from Task 1; map the store target to the repo options.
  const list = await repo.getMemories({ target, status: "superseded" });
  return list.map((m) => m.content);
});
```

(If a `projectStore` exists alongside, wire the same provider on it. Match the exact target/project option shape the repo expects — inspect how `getMemories` is called elsewhere in `index.ts`/`review-memory-ops.ts` for the project-scoping convention.)

- [ ] **Step 4: Sync `offloaded_superseded` to the DB**

In `src/handlers/review-memory-ops.ts`, the caller at line ~337 currently does:

```typescript
result = await activeStore.add(memoryTarget, op.content);
if (...) await syncEvictions(rawTarget, result.evicted_entries, memoryRepo, projectName);
```

Extend it to also sync purged superseded entries (they use the SAME `removeExactSyncedMemories` content-key path — `syncEvictions` is target-agnostic, it just needs the content list):

```typescript
result = await activeStore.add(memoryTarget, op.content);
await syncEvictions(rawTarget, result.evicted_entries, memoryRepo, projectName);
await syncEvictions(rawTarget, result.offloaded_superseded, memoryRepo, projectName);
```

Do the equivalent in `src/tools/memory-tool.ts` at the primary `store.add` call site (~line 388): after `result = await store_.add(...)`, if `result.offloaded_superseded?.length`, invoke the same eviction-sync the tool already performs for `evicted_entries` (find the existing `syncEvictions`/`removeExactSyncedMemories` call near that line and add the `offloaded_superseded` list to it).

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/review-memory-ops.test.ts )`
Expected: PASS — superseded DB row deleted, active keeper survives.

- [ ] **Step 6: Typecheck + full suite + commit**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit && bun test )
git add bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/handlers/review-memory-ops.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/review-memory-ops.test.ts
git commit -m "feat(hermes-memory): wire superseded provider + sync purged DB rows (D2+D4)"
```

---

## Task 4: Resurrect-stale guard contract test (mutation-verified)

**Files:**
- Test only: `tests/store/repository-contract.test.ts` (or `tests/handlers/` if consolidation orchestration is cleaner to drive there)

**Interfaces:**
- Consumes: Tasks 1–3 (full offload-superseded-first loop). This is the guard that locks the D0/D2 promise: a superseded entry is never recalled by consolidation.

- [ ] **Step 1: Write the failing-then-passing contract test**

This is a guard test (writes the test, expects it to PASS on the implemented code, then mutation-verifies). Add to the contract suite:

```typescript
it("consolidation never resurrects a superseded entry (resurrect-stale guard)", async () => {
  // The contract: a superseded entry must not appear in any recall path after
  // capacity pressure, even when consolidation runs. Offload-superseded-first
  // (Task 2/3) guarantees the consolidator never sees superseded content.
  //
  // Seed: active + superseded in the same target/project, then drive the store
  // to capacity with the provider wired (as in Task 3). After the overflow add,
  // assert the superseded content is absent from BOTH:
  //   (a) store.getMemoryEntries() (the .md the consolidator would read), and
  //   (b) repo.searchMemories(<superseded nonce>) (recall).
  //
  // Use a unique nonce in the superseded entry's content (e.g. "resurrectguard qqxnv")
  // and assert it is NOT recalled. Mirror the Task 3 setup (store+repo, provider wired).
  // ... (full setup mirroring Task 3's helper, plus the two absence assertions)
});
```

> Because the test setup mirrors Task 3 exactly, the implementer should COPY the Task 3 setup verbatim (do not write "similar to Task 3" — inline the helper). The distinguishing assertions are the two absence checks on the superseded nonce.

- [ ] **Step 2: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )`
Expected: PASS (Tasks 1–3 already implement the guard).

- [ ] **Step 3: Mutation-verify the guard**

Mutation A — disable offload-superseded-first: in `memory-store.ts`, temporarily short-circuit the provider block (`const supersededContents = [];`). Re-run → expect FAIL (the superseded nonce IS recalled / present in `.md`, because consolidation merged it). Revert.

Mutation B — make `getMemories` ignore `status` (return all): re-run → expect FAIL (provider returns active+superseded, purging would drop the active keeper). Revert.

Confirm both mutations RED, originals GREEN. This proves the test locks both the purge (A) and the status filter (B).

- [ ] **Step 4: Typecheck + commit**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )
git add bun-apps/pi-agent-ext-hermes-memory/tests/store/repository-contract.test.ts
git commit -m "test(hermes-memory): resurrect-stale guard (superseded never consolidated into recall)"
```

---

## Self-Review

**1. Spec coverage.** The grilling decisions map to tasks as follows:
- D0 (destructive compaction, no inherited lineage): realized by Task 2's purge-first + Task 3's destructive DB sync — the new consolidated entry is plain `add`-ed with no lineage linkage, and consumed entries are hard-deleted (no `archived` status anywhere in the plan). ✓
- D2 (offload superseded before consolidation): Task 1 (status filter) + Task 2 (purge-first in overflow) + Task 3 (provider wiring + DB sync). ✓
- D3 (trim never touches active): Task 2 routes all all-active overflow to consolidation; the original `fifo`/`vault` `shift()` on active is unreachable post-purge. Mutation-verified in Task 2 Step 8. ✓
- D4 (destructive, no audit): Task 3 deletes DB rows via `removeExactSyncedMemories`; no `archived`/tombstone status introduced. ✓

**2. Placeholder scan.** Task 2's tests use `makeConfig({ memoryCharLimit: 60 })` — `makeConfig` is an existing helper at the top of `memory-store.test.ts` (line ~33), used by every capacity test in that file (e.g. line ~189), so this is a concrete existing fixture, not a placeholder. Task 3's store+repo fixture mirrors `correction-detector.test.ts:233-331` verbatim (imports + `beforeEach`/`afterEach` inlined in the plan). Task 4 copies Task 3's setup verbatim. No "TBD"/"handle edge cases"/"add validation" anywhere. Every code step shows the actual code.

**3. Type consistency.** `MemoryListOptions.status` (Task 1) is consumed identically in Task 3's provider wiring. `setSupersededContentProvider` (Task 2) is named consistently in Task 3's `index.ts` wiring. `MemoryResult.offloaded_superseded` (Task 2 types change) is read in Task 3's sync. `purgeSupersededFromMarkdown` is the single name used in Task 2 and referenced nowhere else.

**4. Scope boundary.** 5d (stable-id / `.md` status frontmatter) is deliberately NOT in this plan — bridging is content-key only, consistent with the grilling outcome. Phase-2 (semantic/vector recall) remains eval-gated and untouched.

**Execution note (non-blocking):** Task 2 Step 5 reuses the existing `runConsolidator(target, signal, onProgress)` helper (already called by the `auto-consolidate` branch in `_addInner`) — no new helper to extract. The D3 change collapses fifo-evict/vault-offload/auto-consolidate onto that same consolidation path (+ the existing vault-offload floor), so the only net-new code is the offload-superseded-first prefix. The implementer should preserve `_addInner`'s `_retriesLeft`/`loadFromDisk`/floor mechanics exactly as written in the rewritten block.
