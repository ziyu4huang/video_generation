# Hermes Memory Worth Error→Fail + Supersession Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the post-Tier-1 supersession/worth backlog (spec items 5c + minor hardening): make worth-scoring count lesson-worthy tool errors as `mw_fail`, make `supersedeMemory` atomic across both backends, let `memory_supersede` attach grounding `sources[]`, and lock the graph-neighbor status filter behind a regression test.

**Architecture:** Four independent, self-contained hardening tasks on `bun-apps/pi-agent-ext-hermes-memory`. (1) `worth-scoring.ts` gains a `tool_result` listener that reuses `error-detector.ts`'s `isLessonWorthy` + `extractResultText` (the latter newly exported) to set a per-turn `hadError` flag, folded into the existing `turn_end` drain so `hadCorrection || hadError → mw_fail`. (2) `supersedeMemory`'s two UPDATEs are wrapped atomically — SQLite via the existing `runExclusive` helper, SurrealDB via a single `BEGIN/COMMIT TRANSACTION` batch (the Surreal client already supports multi-statement batches). (3) `memory_supersede` gains an optional `sources[]` param threaded into `store.add({sources})` (already supported; `.md`-resident only — no DB column, consistent with the provenance architecture). (4) A shared contract test pins that a superseded graph **neighbor** (non-lexical, recalled via shared project) is hidden — the filter already exists; the test locks it with a mutation check.

**Tech Stack:** TypeScript, `bun test` (`node:test`/`assert` for handler/tool tests; `bun:test`/`expect` for the shared contract suite), on-disk tmpdir + real `SqliteBackend`/`SqliteMemoryRepository` fixtures (mirroring `worth-scoring.test.ts` and `memory-supersede-tool.test.ts`).

## Global Constraints

- **Safe default / never block the session:** every handler change stays fully try/catch-wrapped + best-effort (inherit correction-detector/worth-scoring's envelope). `worthScoring:false` → no bump but still drains.
- **Dual backend parity:** every read-side DB change applies to **both** `sqlite-memory-repo` and `surreal-memory-repo` and passes the shared `repository-contract.test.ts`. (Tasks 2 & 4 touch both backends; Tasks 1 & 3 are backend-agnostic — handler/tool layer.)
- **`.md` is source of truth; provenance/sources are `.md`-resident only** (no DB column — not read at query time). `sources[]` flows through `store.add({sources})`; `syncMemoryEntry` is unchanged (Task 3).
- **Reuse, don't duplicate:** `isLessonWorthy` (already exported from `error-detector.ts`), `extractResultText` (export it — Task 1), `runExclusive` (already in `sqlite-memory-repo.ts` — Task 2), `store.add({sources})` (already supported — Task 3).
- **Naming:** worth counters are `mwSuccess`/`mwFail` (DTO) ↔ `mw_success`/`mw_fail` (SQLite snake_case); `MemorySource = { kind: string; locator: string; capture: string }` (`types.ts`).
- Run tests via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test … )` — never top-level `cd`. Typecheck via `bunx tsc --noEmit` from the same dir.

## File Structure

- **Task 1:** `src/handlers/error-detector.ts` (export `extractResultText`), `src/handlers/worth-scoring.ts` (tool_result listener + `hadError`), `tests/handlers/worth-scoring.test.ts` (error→fail tests)
- **Task 2:** `src/store/sqlite/sqlite-memory-repo.ts` (`runExclusive` wrap), `src/store/surreal/surreal-memory-repo.ts` (`BEGIN/COMMIT` batch), `tests/store/sqlite-memory-repo.test.ts` (transaction spy test — create if absent)
- **Task 3:** `src/tools/memory-supersede-tool.ts` (`sources` param → `store.add`), `tests/tools/memory-supersede-tool.test.ts` (sources spy test)
- **Task 4:** `tests/store/repository-contract.test.ts` (graph-neighbor leak test — shared by both backends)

---

## Task 1: Worth error→fail trigger (5c)

**Files:**
- Modify: `src/handlers/error-detector.ts` (export `extractResultText`)
- Modify: `src/handlers/worth-scoring.ts` (add `tool_result` listener + `hadError` flag)
- Modify: `tests/handlers/worth-scoring.test.ts` (append error→fail tests)

**Interfaces:**
- Consumes: `isLessonWorthy(text: string): boolean` (already exported from `error-detector.ts`); `extractResultText(content: unknown): string` (exported in Step 3 — currently module-private).
- Produces: `setupWorthScoring` additionally registers a `tool_result` listener. No signature change. The `turn_end` outcome becomes `hadCorrection || hadError → mw_fail`, else `mw_success`.

- [ ] **Step 1: Write the failing tests** — append to `tests/handlers/worth-scoring.test.ts`, inside the first `describe("worth-scoring handler", …)` block (which already declares `tmpDir`, `backend`, `repo`, `handlers`, `recallSet`, `mockPi`, `setupWorthScoring`, and the `fire` helper — mirror those fixtures; the `tool_result` event shape is `{ isError: boolean; content: unknown; toolName?: string }`):

```typescript
  it("lesson-worthy tool error on a recalled memory: bumps mw_fail", async () => {
    const m = await repo.addMemory({ content: "use pnpm to add deps", target: "memory" });
    recallSet.record(m.id);
    // a tool_result that failed with a lesson-worthy error text
    await fire("tool_result", {
      isError: true,
      content: [{ type: "text", text: "Error: ENOENT: no such file or directory, open '/missing.cfg'" }],
      toolName: "read",
    });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwFail, 1);
    assert.strictEqual(got[0].mwSuccess, 0);
  });

  it("non-error tool_result: counts as success (not fail)", async () => {
    const m = await repo.addMemory({ content: "use bun test", target: "memory" });
    recallSet.record(m.id);
    await fire("tool_result", {
      isError: false,
      content: [{ type: "text", text: "ran fine" }],
      toolName: "bash",
    });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess, 1);
    assert.strictEqual(got[0].mwFail, 0);
  });

  it("error that is NOT lesson-worthy (noise-suppressed): does not bump mw_fail", async () => {
    const m = await repo.addMemory({ content: "run the linter", target: "memory" });
    recallSet.record(m.id);
    // isError:true BUT the text matches an ERROR_NOISE_PATTERN (`operation aborted`),
    // so isLessonWorthy() returns false → hadError stays false → clean turn → mw_success.
    await fire("tool_result", {
      isError: true,
      content: [{ type: "text", text: "operation aborted by the user" }],
      toolName: "bash",
    });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwFail ?? 0, 0);
    assert.strictEqual(got[0].mwSuccess, 1); // clean turn otherwise → success
  });
```
(These strings are verified against `src/constants.ts`: `LESSON_WORTHY_PATTERNS` includes `\b(ENOENT|...):` and `No such file or directory` (so the Step-1 ENOENT text is lesson-worthy); `ERROR_NOISE_PATTERNS` includes `/operation aborted/i` (so the noise test text is suppressed). No edit needed — the assertions encode the intent: lesson-worthy error → `mw_fail`; noise-suppressed error → not fail.)

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/worth-scoring.test.ts )`. Expected: the three new tests FAIL — the `tool_result` listener does not exist, so `hadError` is never set (error test sees `mwSuccess=1` instead of `mwFail=1`; the others may pass incidentally — the lesson-worthy-error case is the load-bearing RED).

- [ ] **Step 3: Export `extractResultText`** — in `src/handlers/error-detector.ts`, change:
```typescript
/** Extract all readable text from a tool_result event's content blocks. */
function extractResultText(content: unknown): string {
```
to:
```typescript
/** Extract all readable text from a tool_result event's content blocks. */
export function extractResultText(content: unknown): string {
```

- [ ] **Step 4: Add the `tool_result` listener + `hadError` to `setupWorthScoring`** — in `src/handlers/worth-scoring.ts`:
  - (a) Extend the import from `correction-detector.js` / add an `error-detector.js` import at the top (near the existing `isCorrection` import):
```typescript
import { isCorrection } from "./correction-detector.js";
import { isLessonWorthy, extractResultText } from "./error-detector.js";
```
  - (b) Add a `hadError` flag next to `hadCorrection` inside `setupWorthScoring`:
```typescript
  const enabled = config.worthScoring !== false;
  let hadCorrection = false;
  let hadError = false;
```
  - (c) Add the `tool_result` listener after the existing `message_end` listener:
```typescript
  pi.on("tool_result", async (event) => {
    try {
      if (!enabled) return;
      if (!event.isError) return;
      const text = extractResultText(event.content);
      if (isLessonWorthy(text)) hadError = true;
    } catch {
      // Best-effort — never block the session
    }
  });
```
  - (d) In the `turn_end` handler, fold `hadError` into the fail decision and reset both flags. Replace the existing `const successDelta = hadCorrection ? 0 : 1;` / `const failDelta = hadCorrection ? 1 : 0;` / `hadCorrection = false;` block with:
```typescript
      const failed = hadCorrection || hadError;
      const successDelta = failed ? 0 : 1;
      const failDelta = failed ? 1 : 0;
      hadCorrection = false;
      hadError = false;
```

- [ ] **Step 5: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/worth-scoring.test.ts )` then the full `tests/handlers/` suite + `bunx tsc --noEmit`. Expected: all tests PASS; tsc clean.

- [ ] **Step 6: Commit** — `git add src/handlers/error-detector.ts src/handlers/worth-scoring.ts tests/handlers/worth-scoring.test.ts && git commit -m "feat(hermes-memory): worth-scoring counts lesson-worthy tool errors as mw_fail (5c)"`.

---

## Task 2: Transactional supersedeMemory (atomic lineage flip)

**Files:**
- Modify: `src/store/sqlite/sqlite-memory-repo.ts` (wrap the two UPDATEs in `runExclusive`)
- Modify: `src/store/surreal/surreal-memory-repo.ts` (single `BEGIN/COMMIT TRANSACTION` batch)
- Create: `tests/store/sqlite-memory-repo.test.ts` (transaction spy test — only if the file does not already exist; if it exists, append the test to it)

**Interfaces:**
- Consumes: `runExclusive<T>(db: DatabaseLike, fn: () => T): T` (already defined in `sqlite-memory-repo.ts`, ~line 171). The Surreal client's `query()` supports multi-statement batches and throws on the first non-OK statement (`surreal-client.ts`).
- Produces: `supersedeMemory(priorId, newId)` remains signature-identical; behavior changes from "two independent UPDATEs" to "one atomic transaction" on both backends.

- [ ] **Step 1: Write the failing test (SQLite transaction spy)** — create or append to `tests/store/sqlite-memory-repo.test.ts`. This asserts the two UPDATEs run inside a single `BEGIN IMMEDIATE … COMMIT` envelope (the `runExclusive` helper's markers):

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";

describe("SqliteMemoryRepository.supersedeMemory atomicity", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supersede-tx-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
  });
  afterEach(() => { backend.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("runs both UPDATEs inside a single BEGIN IMMEDIATE … COMMIT transaction", async () => {
    const prior = await repo.addMemory({ content: "prior atomic content", target: "memory" });
    const next = await repo.addMemory({ content: "next atomic content", target: "memory" });

    // Spy on db.exec to capture transaction markers emitted by runExclusive.
    const db = backend.getDb();
    const execSqls: string[] = [];
    const origExec = db.exec.bind(db);
    (db as { exec: (sql: string) => void }).exec = (sql: string) => {
      execSqls.push(sql);
      return origExec(sql);
    };

    try {
      await repo.supersedeMemory(prior.id, next.id);
    } finally {
      (db as { exec: (sql: string) => void }).exec = origExec;
    }

    assert.ok(execSqls.some((s) => s.toUpperCase().includes("BEGIN IMMEDIATE")),
      `expected a BEGIN IMMEDIATE among exec() calls, got: ${JSON.stringify(execSqls)}`);
    assert.ok(execSqls.some((s) => s.toUpperCase() === "COMMIT"),
      `expected a COMMIT among exec() calls, got: ${JSON.stringify(execSqls)}`);
  });
});
```
(Confirm `SqliteBackend.getDb()` is publicly callable — read `sqlite-backend.ts`; if the method is named differently, adjust. The spy must wrap `db.exec`, which `runExclusive` calls for `BEGIN IMMEDIATE`/`COMMIT`.)

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`. Expected: FAIL — today `supersedeMemory` calls `this.db.prepare(...).run(...)` directly with no `BEGIN IMMEDIATE`/`COMMIT`, so the spy captures neither marker.

- [ ] **Step 3: Wrap SQLite `supersedeMemory` in `runExclusive`** — in `src/store/sqlite/sqlite-memory-repo.ts`, replace the existing body (~line 749):
```typescript
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newId, priorId);
      this.db.prepare("UPDATE memories SET supersedes = ?, parent_ids = ? WHERE id = ?").run(priorId, JSON.stringify([priorId]), newId);
    }));
  }
```
with:
```typescript
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() =>
      runExclusive(this.db, () => {
        this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newId, priorId);
        this.db.prepare("UPDATE memories SET supersedes = ?, parent_ids = ? WHERE id = ?").run(priorId, JSON.stringify([priorId]), newId);
      }),
    ));
  }
```

- [ ] **Step 4: Wrap Surreal `supersedeMemory` in a single transaction batch** — in `src/store/surreal/surreal-memory-repo.ts`, replace the existing body (~line 547):
```typescript
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    const p = Number(priorId), n = Number(newId);
    await this.c.query(`UPDATE memories SET status = 'superseded', supersededBy = $n WHERE seq = $p;`, { p, n });
    await this.c.query(`UPDATE memories SET supersedes = $p, parentIds = [$p] WHERE seq = $n;`, { p, n });
  }
```
with a single `BEGIN/COMMIT TRANSACTION` batch (the client folds `$p`/`$n` into `LET` binds and processes the batch atomically):
```typescript
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    const p = Number(priorId), n = Number(newId);
    await this.c.query(
      `BEGIN TRANSACTION;
       UPDATE memories SET status = 'superseded', supersededBy = $n WHERE seq = $p;
       UPDATE memories SET supersedes = $p, parentIds = [$p] WHERE seq = $n;
       COMMIT TRANSACTION;`,
      { p, n },
    );
  }
```

- [ ] **Step 5: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts tests/store/repository-contract.test.ts )` + `bunx tsc --noEmit`. Expected: the spy test PASSES (BEGIN/COMMIT captured); the shared contract suite still passes (round-trip + re-sync-stability unchanged in observable behavior). tsc clean. (The Surreal backend runs the same contract suite when its harness is up; if Surreal is not running in CI, the SQLite contract run is the gate.)

- [ ] **Step 6: Commit** — `git add src/store/sqlite/sqlite-memory-repo.ts src/store/surreal/surreal-memory-repo.ts tests/store/sqlite-memory-repo.test.ts && git commit -m "fix(hermes-memory): make supersedeMemory atomic (sqlite runExclusive + surreal transaction batch)"`.

---

## Task 3: Wire `sources[]` into the memory_supersede tool

**Files:**
- Modify: `src/tools/memory-supersede-tool.ts` (add `sources` param → `store.add({sources})`)
- Modify: `tests/tools/memory-supersede-tool.test.ts` (sources spy test)

**Interfaces:**
- Consumes: `MemorySource = { kind: string; locator: string; capture: string }` (`src/types.ts`); `MemoryStore.add(target, content, { sources?: MemorySource[] })` — already supported (the `add` options type already includes `sources`).
- Produces: the tool's `parameters` gains an optional `sources` array; when provided, it is threaded into `store.add` so the replacement's `.md` entry carries grounding sources. `syncMemoryEntry` is unchanged (sources are `.md`-resident only — no DB column).

- [ ] **Step 1: Write the failing test** — append to `tests/tools/memory-supersede-tool.test.ts`. Because the existing `mockStore()` discards `add`'s args, this test installs a spy store that captures the options passed to `add`:

```typescript
  it("threads optional sources[] into store.add (grounding the replacement)", async () => {
    const prior = await memoryRepo.addMemory({
      content: "stale grounding note alpha",
      target: "memory",
      project: null,
    });

    // Spy store: capture the options object handed to add().
    let capturedOptions: { sources?: unknown } | undefined;
    const spyStore = {
      add: (_target: string, _content: string, options?: { sources?: unknown }) => {
        capturedOptions = options;
        return { success: true, target: "memory", entries: ["replacement"], usage: "1%", entry_count: 1, message: "Entry added." };
      },
    } as unknown as MemoryStore;

    const { pi, def } = captureTool();
    registerMemorySupersedeTool(pi, memoryRepo, spyStore);

    const sources = [
      { kind: "quote", locator: "session-42#m7", capture: "no, the value is 3 not 2" },
      { kind: "doc", locator: "README.md#L120", capture: "VALUE = 3" },
    ];

    const result = await def().execute(
      "tc-src",
      { prior_id: prior.id, replacement: "the value is 3 grounding note alpha", target: "memory", sources },
      undefined as any, undefined as any, undefined as any,
    );

    assert.ok(result.details.ok);
    assert.ok(result.details.linked, "lineage still flipped");
    assert.ok(capturedOptions, "store.add was called");
    assert.deepStrictEqual(capturedOptions!.sources, sources, "sources[] passed through to store.add verbatim");
  });

  it("omitting sources still works (store.add called without sources)", async () => {
    const prior = await memoryRepo.addMemory({ content: "no sources prior content", target: "memory", project: null });
    let capturedOptions: { sources?: unknown } | undefined;
    const spyStore = {
      add: (_t: string, _c: string, options?: { sources?: unknown }) => {
        capturedOptions = options;
        return { success: true, target: "memory", entries: ["r"], usage: "1%", entry_count: 1, message: "ok" };
      },
    } as unknown as MemoryStore;

    const { pi, def } = captureTool();
    registerMemorySupersedeTool(pi, memoryRepo, spyStore);

    const result = await def().execute(
      "tc-nosrc",
      { prior_id: prior.id, replacement: "no sources replacement content", target: "memory" },
      undefined as any, undefined as any, undefined as any,
    );

    assert.ok(result.details.ok);
    assert.ok(result.details.linked);
    assert.ok((capturedOptions === undefined) || (capturedOptions && capturedOptions.sources === undefined),
      "no sources param → store.add gets no sources");
  });
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-supersede-tool.test.ts )`. Expected: the first test FAILS — today the tool calls `store.add(target, replacement, {})` with an empty options object, so `capturedOptions.sources` is `undefined`, not the array.

- [ ] **Step 3: Add the `sources` parameter and thread it into `store.add`** — in `src/tools/memory-supersede-tool.ts`:
  - (a) Add the `MemorySource` type import near the top (with the other `../types.js` / store imports):
```typescript
import type { MemorySource } from "../types.js";
```
  - (b) Add an optional `sources` property to the `parameters` schema (inside `Type.Object({ … })`, after `project`):
```typescript
      sources: Type.Optional(
        Type.Array(
          Type.Object({
            kind: Type.String({ description: "Source kind, e.g. \"quote\", \"doc\", \"url\"." }),
            locator: Type.String({ description: "Stable ref into the source (session id, url, line)." }),
            capture: Type.String({ description: "The verbatim text/anchor grounding the replacement." }),
          }),
          { description: "Optional grounding sources attached to the replacement (.md-resident only)." },
        ),
      ),
```
  - (c) Extend the `execute` args type with `sources?: MemorySource[]`:
```typescript
    async execute(
      _toolCallId: string,
      args: { prior_id: number; replacement: string; target: MemoryTarget; project?: string; sources?: MemorySource[] },
    ) {
      const { prior_id, replacement, target, project, sources } = args;
```
  - (d) Thread `sources` into the `store.add` options. Replace the existing `const addRes = await store.add(target, replacement, {});` with:
```typescript
      const addRes = await store.add(target, replacement, sources && sources.length > 0 ? { sources } : {});
```

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-supersede-tool.test.ts )` + `bunx tsc --noEmit`. Expected: both new tests PASS; the existing "expected shape" test still passes (the new `sources` param is optional, so the required-array assertion is unaffected); tsc clean.

- [ ] **Step 5: Commit** — `git add src/tools/memory-supersede-tool.ts tests/tools/memory-supersede-tool.test.ts && git commit -m "feat(hermes-memory): memory_supersede threads optional sources[] into the replacement"`.

---

## Task 4: Graph-neighbor leak contract test (lock the status filter)

**Files:**
- Modify: `tests/store/repository-contract.test.ts` (append a graph-neighbor leak test inside `runMemoryRepositoryContract`)

**Interfaces:**
- Consumes: `addMemory`, `supersedeMemory`, `searchMemories` (the repo interface). The graph-neighbor expansion path (`fetchGraphNeighbors`) already filters `status = 'active'` unless `includeSuperseded` is set — this test LOCKS that behavior so a future refactor cannot silently regress it.

- [ ] **Step 1: Write the test** — append inside `runMemoryRepositoryContract`'s `describe` block (after the existing `supersession: re-sync stability …` test, ~line 257). It seeds a lexical match `A` and a same-project neighbor `B`, supersedes `B`, and asserts `B` is NOT recalled via graph expansion by default but IS with `includeSuperseded`:

```typescript
    it("graph-neighbor leak: a superseded same-project neighbor is hidden from graph recall (and revealed via includeSuperseded)", async () => {
      const { repo, close } = await make();
      try {
        const nonce = "zxqwbu-graphleak-anchor";
        // A: lexical match for the nonce, project-scoped.
        await repo.addMemory({ content: `${nonce} lexical match wording`, target: "memory", project: "graphleak-proj" });
        // B: shares the project (graph edge) but has NO lexical overlap with the nonce — only reachable via graph expansion.
        const neighbor = await repo.addMemory({ content: "totally different wording neighbor graphleak", target: "memory", project: "graphleak-proj" });
        // C: the replacement that supersedes B.
        const replacement = await repo.addMemory({ content: "replacement wording neighbor graphleak fixed", target: "memory", project: "graphleak-proj" });

        // Baseline: B IS recalled as a graph neighbor before supersession.
        const before = await repo.searchMemories(nonce, { project: "graphleak-proj" });
        expect(before.some((m) => m.id === neighbor.id)).toBe(true);

        await repo.supersedeMemory(neighbor.id, replacement.id);

        // After supersession: B is hidden from default graph recall (status filter).
        const after = await repo.searchMemories(nonce, { project: "graphleak-proj" });
        expect(after.some((m) => m.id === neighbor.id)).toBe(false);
        // A is still recalled (lexical, active).
        expect(after.some((m) => m.content.includes(nonce))).toBe(true);

        // Opt-in: B reappears via includeSuperseded (proves the hide is the status filter, not absence).
        const included = await repo.searchMemories(nonce, { project: "graphleak-proj", includeSuperseded: true });
        expect(included.some((m) => m.id === neighbor.id)).toBe(true);
      } finally {
        await close();
      }
    });
```

- [ ] **Step 2: Run GREEN (it should pass — the filter already exists)** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )`. Expected: PASS. This is a regression/characterization test locking existing correct behavior, so it passes immediately.

- [ ] **Step 3: Mutation-verify the test bites** — temporarily comment out the status-filter block in `src/store/sqlite/sqlite-memory-repo.ts` `fetchGraphNeighbors` (the `if (!scope.includeSuperseded) { conditions.push("m.status = 'active'"); }` lines), re-run the test, confirm it FAILS (`neighbor.id` leaks into the default result), then **revert** the comment-out. This proves the test actually guards the filter. (No commit for the mutated state — revert fully before committing.)

- [ ] **Step 4: Commit** — `git add tests/store/repository-contract.test.ts && git commit -m "test(hermes-memory): lock graph-neighbor status filter (superseded neighbor hidden from recall)"`.

---

## Self-Review

1. **Spec coverage:** 5c (worth error→fail) = Task 1 (the deferred `tool_result` listener called out in `worth-trigger.md` line 13 + Self-Review §1 + Execution Handoff). Transactional `supersedeMemory` = Task 2 (minor hardening). Wire `evidence`/`sources` = Task 3 (the `memory-supersede-tool` "skeleton omits it" gap flagged in `supersession.md` Self-Review §1). Graph-leak test = Task 4 (minor hardening — the existing `fetchGraphNeighbors` status filter had no dedicated regression test). OUT (deferred, larger): 5b consolidation-lineage-preservation; 5d stable-id lineage; phase-2 semantic/vector recall (eval-gated).
2. **Placeholder scan:** every code step has real code. One flagged-for-verification spot, named not hand-waved: Task 2 Step 1 — confirm `SqliteBackend.getDb()` is the public method name (read `sqlite-backend.ts` first; adjust the spy target if named differently). Task 1's lesson-worthy/noise strings are already verified against `src/constants.ts` (`ENOENT`/`No such file or directory` ∈ `LESSON_WORTHY_PATTERNS`; `operation aborted` ∈ `ERROR_NOISE_PATTERNS`). No "TBD"/"add error handling"/"similar to Task N".
3. **Type consistency:** `extractResultText(content: unknown): string` matches the existing private signature (only `export` added). `MemorySource = { kind: string; locator: string; capture: string }` matches `types.ts`. The tool's `execute` args type adds `sources?: MemorySource[]`, threaded as `{ sources }` into `store.add` (whose options type already has `sources?: MemorySource[]`). `supersedeMemory(priorId: number, newId: number)` signature unchanged on both backends. Worth flags `hadCorrection`/`hadError` are module-local booleans, reset together at `turn_end`.
4. **Behavior change audit:** Task 1 — a turn with a lesson-worthy tool error AND a recalled memory now bumps `mw_fail` instead of `mw_success` (intended; `worthScoring:false` unchanged). Task 2 — observable success-path behavior identical; only atomicity added (a crash mid-flip can no longer leave the prior half-superseded). Task 3 — purely additive optional param; omitting `sources` is byte-identical to today. Task 4 — test-only, no production change. The `turn_end` flag-reset now clears both `hadCorrection` and `hadError`.
5. **Safety:** Task 1's `tool_result` listener is fully try/catch-wrapped + gated on `enabled`; the recall-set still always drains. Task 2's `runExclusive` rolls back on throw (existing helper semantics); the Surreal `BEGIN/COMMIT` batch throws on the first non-OK statement (client contract). Task 3's sources flow only through `store.add` (`.md` layer) — no DB mutation, no query-time read. Task 4 is read-only test code.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-30-hermes-memory-worth-error-fail-supersession-hardening.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task (Tier: implementer = `medium`), review between tasks, fast iteration. Tasks are independent — safe to run sequentially with a review gate each.
2. **Inline Execution** — Execute the four tasks in this session via executing-plans, batched with checkpoints for review.

**Which approach?**

This plan closes the **5c + minor hardening** backlog (the post-Tier-1 items with decisions already settled). Remaining larger backlog (NOT in this plan): **5b** consolidation-lineage-preservation (has open design — needs grilling/brainstorm first), **5d** stable-id lineage (optional, depends on 5b), and **phase-2** semantic/vector recall (eval-gated). Each task here is self-contained and independently committable; Task 4 is test-only and can land even if any earlier task is deferred.
