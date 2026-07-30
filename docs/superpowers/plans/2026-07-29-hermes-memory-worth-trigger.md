# Hermes Memory-Worth Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Activate Plan 2's worth-scoring: a `turn_end` trigger that increments `mw_success`/`mw_fail` on the memories recalled this turn (correction → `mw_fail`, else → `mw_success`), plus closing the no-neighbor fast-path so the worth multiplier actually applies to single-match searches. This is the behavioral layer that makes Plan 2's data + scoring do something.

**Architecture:** The only recall signal is `touchMemory` in `memory-search-tool.ts` (prompt-context injection reads `.md` directly). So: a shared `RecallSet` records each touched id at the `touchMemory` site; a new `setupWorthScoring` registers a `message_end` listener (flags `hadCorrection` via the exported `isCorrection` pure predicate) + a `turn_end` handler (drains the recall-set, bumps worth — `fail` if `hadCorrection` else `success` — best-effort, never blocks). **DB-authoritative** (per the Plan 3 design decision): `bumpMemoryWorth` is DB-only, no `.md` write-through (matches the `last_referenced` precedent; worth is re-learnable, clone is rare). Worth does NOT survive a fresh clone — acceptable, same as `last_referenced`. The fast-path closure routes single-match searches through `rankMemoryEntries` so the multiplier (Plan 2) applies.

**Tech Stack:** TypeScript, `bun test` (`node:test` + `node:assert/strict` for handler tests; `bun:test` `expect/it` for repo/tool tests — match each file's convention), on-disk tmpdir fixtures.

**Spec reconciliation / design decisions:**
- **DB-authoritative, NO `.md` write-through** (revises Plan 2's handoff note). Per-turn `.md` rewrites for the recall-set are too costly; `.md` has no id (would need content-lookup per bump); `last_referenced` is already DB-authoritative. Plan 2's `.md`-residence capability (Tasks 1–2) stays dormant-but-harmless (future-proofing). Worth is re-learned per environment.
- **v1 classifier: correction → `mw_fail`, else → `mw_success`.** Lesson-worthy-error → `mw_fail` is DEFERRED (`event.toolResults` at `turn_end` is `ToolResultMessage[]`, not `isLessonWorthy`-shaped; a separate `tool_result` listener is more machinery than v1 needs). Correction is the canonical "the recalled guidance was wrong" signal; error-fail attribution is fuzzier and can land later.
- **Recall-set scope: per-turn** (drained each `turn_end`). Simplest coherent attribution.
- **Fast-path closure is a ranking behavior change** (single-match searches now use recency-normalized + worth-weighted order instead of raw `last_referenced DESC`). It's the step that makes worth affect top-level search — Plan 2 deferred it here. Existing order-asserting search tests must be checked/updated.

## Global Constraints

- **Never block the session** — the `turn_end` handler wraps everything in try/catch; per-id bumps are best-effort (mirror `touchMemory`/correction-detector).
- **Recall-set is always drained at `turn_end`** (even when worth-scoring is disabled) so it can't grow unbounded — `touchMemory` is ungated and always records.
- `bumpMemoryWorth` is DB-only (Plan 2) — do NOT add `.md` writes in this plan.
- `isCorrection` is an EXPORTED pure predicate from `correction-detector.ts` — reuse it; do NOT duplicate correction detection.
- Dual-backend: the fast-path closure edits BOTH `sqlite-memory-repo.ts` and `surreal-memory-repo.ts` symmetrically.
- Run tests via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test … )` — never top-level `cd`.

## File Structure

- **Create:** `src/handlers/worth-scoring.ts` (`RecallSet` class + `setupWorthScoring`), `tests/handlers/worth-scoring.test.ts`
- **Modify:** `src/tools/memory-search-tool.ts` (`registerMemorySearchTool` gains optional `recallSet?`; record in the touch loop)
- **Modify:** `src/index.ts` (instantiate `recallSet`; pass to `registerMemorySearchTool`; call `setupWorthScoring`)
- **Modify:** `src/types.ts` + `src/config.ts` (`worthScoring?: boolean`, default `true`)
- **Modify:** `src/store/sqlite/sqlite-memory-repo.ts` + `src/store/surreal/surreal-memory-repo.ts` (close the no-neighbor fast-path)
- **Modify:** `tests/tools/memory-search-tool.test.ts` (recall-set feed)

---

## Task 1: RecallSet + setupWorthScoring + worthScoring config

**Files:**
- Create: `src/handlers/worth-scoring.ts`, `tests/handlers/worth-scoring.test.ts`
- Modify: `src/types.ts` (MemoryConfig), `src/config.ts` (DEFAULT_CONFIG + loadConfig)

**Interfaces:**
- Produces: `RecallSet` (`record(id)`, `drain(): number[]`); `setupWorthScoring(pi, memoryRepo, recallSet, config)` registering a `message_end` flag + a `turn_end` drain-and-bump; `MemoryConfig.worthScoring?: boolean`.

- [ ] **Step 1: Write the failing test** — create `tests/handlers/worth-scoring.test.ts` (`node:test` + `node:assert/strict`, mirroring `tests/handlers/correction-detector.test.ts`'s mock-pi + real `SqliteBackend`/`SqliteMemoryRepository` scaffold):

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { RecallSet, setupWorthScoring } from "../../src/handlers/worth-scoring.js";

describe("worth-scoring handler", () => {
  let tmpDir: string; let backend: SqliteBackend; let repo: SqliteMemoryRepository;
  let handlers: Record<string, Array<(e: any, ctx?: any) => Promise<void> | void>>;
  let recallSet: RecallSet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worth-scoring-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    handlers = {};
    recallSet = new RecallSet();
    const mockPi = { on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); }, registerTool() {}, registerCommand() {} } as any;
    setupWorthScoring(mockPi, repo, recallSet, { worthScoring: true, correctionStrongPatterns: [], correctionWeakPatterns: [], correctionNegativePatterns: [], correctionDirectiveWords: [] } as any);
  });
  afterEach(() => { backend.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const fire = async (ev: string, e: any, ctx?: any) => { for (const h of handlers[ev] ?? []) await h(e, ctx); };

  it("clean turn: bumps mw_success on the recalled set", async () => {
    const m = await repo.addMemory({ content: "use bun", target: "memory" });
    recallSet.record(m.id);
    await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "thanks, that worked" }] } });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess, 1);
    assert.strictEqual(got[0].mwFail, 0);
  });

  it("correction turn: bumps mw_fail on the recalled set", async () => {
    const m = await repo.addMemory({ content: "use npm", target: "memory" });
    recallSet.record(m.id);
    await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "no, use pnpm instead" }] } });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwFail, 1);
    assert.strictEqual(got[0].mwSuccess, 0);
  });

  it("empty recall-set: turn_end is a no-op (but drains)", async () => {
    await repo.addMemory({ content: "x", target: "memory" });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess ?? 0, 0);
  });

  it("worthScoring disabled: no bump, but recall-set still drains", async () => {
    // re-setup with worthScoring:false
    handlers = {}; recallSet = new RecallSet();
    const mockPi = { on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); }, registerTool() {}, registerCommand() {} } as any;
    setupWorthScoring(mockPi, repo, recallSet, { worthScoring: false } as any);
    const m = await repo.addMemory({ content: "y", target: "memory" });
    recallSet.record(m.id);
    await fire("turn_end", {}, {});
    assert.strictEqual(recallSet.drain().length, 0); // drained, not grown
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess ?? 0, 0);
  });
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/worth-scoring.test.ts )`. Expected: FAIL (module not found).

- [ ] **Step 3: Add the config flag** — in `src/types.ts` `MemoryConfig` (near `errorCapture?`): `/** Increment memory-worth counters on session outcome (correction→fail, else→success). Default: true */ worthScoring?: boolean;`. In `src/config.ts` `DEFAULT_CONFIG` (near `errorCapture: true`): add `worthScoring: true,`. In `loadConfig` (near the `errorCapture` boolean read): `if (typeof parsed.worthScoring === "boolean") config.worthScoring = parsed.worthScoring;`.

- [ ] **Step 4: Create `src/handlers/worth-scoring.ts`** — read `src/handlers/correction-detector.ts`'s imports first to get the exact `isCorrection` + `getMessageText` import paths + the `ExtensionAPI`/`MemoryConfig` types. Then:

```typescript
import type { ExtensionAPI } from "../index.js"; // match correction-detector's ExtensionAPI import
import type { MemoryRepository } from "../store/repository.js";
import type { MemoryConfig } from "../types.js";
import { isCorrection } from "./correction-detector.js";
import { getMessageText } from "./message-parts.js"; // match correction-detector's actual import path

/** Per-turn set of memory ids recalled via memory_search (the touchMemory path). */
export class RecallSet {
  private readonly ids = new Set<number>();
  record(id: number): void { this.ids.add(id); }
  drain(): number[] { const out = [...this.ids]; this.ids.clear(); return out; }
}

/**
 * Bump memory-worth counters on session outcome. Records a `message_end` flag
 * (correction detected via isCorrection) and, at `turn_end`, drains the recall-set
 * and bumps each recalled memory: mw_fail++ if the turn had a correction, else
 * mw_success++. Best-effort, never blocks. DB-authoritative (no .md write-through).
 */
export function setupWorthScoring(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository | null,
  recallSet: RecallSet,
  config: MemoryConfig,
): void {
  const enabled = config.worthScoring !== false;
  let hadCorrection = false;

  pi.on("message_end", async (event) => {
    if (!enabled) return;
    if (event.message.role !== "user") return;
    const text = getMessageText(event.message);
    if (text && isCorrection(text, config)) hadCorrection = true;
  });

  pi.on("turn_end", async () => {
    try {
      const ids = recallSet.drain(); // always drain (bounds the set even when disabled)
      if (!enabled || !memoryRepo || ids.length === 0) { hadCorrection = false; return; }
      const successDelta = hadCorrection ? 0 : 1;
      const failDelta = hadCorrection ? 1 : 0;
      hadCorrection = false;
      for (const id of ids) {
        try { await memoryRepo.bumpMemoryWorth(id, successDelta, failDelta); } catch { /* best-effort */ }
      }
    } catch { /* never block the session */ }
  });
}
```
(If `getMessageText` is imported from a different module in correction-detector, use that exact path. Match correction-detector's `ExtensionAPI` import.)

- [ ] **Step 5: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/worth-scoring.test.ts )`. Expected: PASS (all 4).

- [ ] **Step 6: Commit** — `git add src/handlers/worth-scoring.ts src/handlers/worth-scoring.test.ts src/types.ts src/config.ts && git commit -m "feat(hermes-memory): worth-scoring trigger (RecallSet + setupWorthScoring + config)"`.

---

## Task 2: Feed the recall-set from memory_search + wire in index.ts

**Files:**
- Modify: `src/tools/memory-search-tool.ts` (`registerMemorySearchTool` signature + touch loop)
- Modify: `src/index.ts` (instantiate `recallSet`; pass to `registerMemorySearchTool`; call `setupWorthScoring`)
- Modify: `tests/tools/memory-search-tool.test.ts`

**Interfaces:**
- Produces: `registerMemorySearchTool(pi, memoryRepo, recallSet?)` — the optional 3rd param; the touch loop calls `recallSet?.record(entry.id)`.

- [ ] **Step 1: Write the failing test** — append to `tests/tools/memory-search-tool.test.ts` (match its `bun:test` convention):

```typescript
import { RecallSet } from "../../src/handlers/worth-scoring.js";

it("memory_search records recalled ids into the recall-set", async () => {
  const memoryRepo = makeRepo();
  await memoryRepo.addMemory({ content: "user's name is Naruto", target: "user" });
  const recallSet = new RecallSet();
  let captured: any;
  const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
  registerMemorySearchTool(mockPi, memoryRepo, recallSet);
  await captured.execute("tc-1", { query: "name identity Naruto", target: "user" });
  expect(recallSet.drain().length).toBeGreaterThan(0); // at least the recalled entry was recorded
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-search-tool.test.ts )`. Expected: FAIL (recall-set not populated).

- [ ] **Step 3: Add the recall-set param + record** — in `src/tools/memory-search-tool.ts`, change the signature to `export function registerMemorySearchTool(pi: ExtensionAPI, memoryRepo: MemoryRepository, recallSet?: { record(id: number): void }): void {` and in the touch loop (the `for (const entry of results)` block at ~:55) add `recallSet?.record(entry.id);` before the `touchMemory` call.

- [ ] **Step 4: Wire index.ts** — in `src/index.ts`: (a) import `RecallSet` + `setupWorthScoring`; (b) BEFORE the `setupCorrectionDetector` call (~:354), instantiate `const recallSet = new RecallSet();` (after `memoryRepo` exists at ~:154); (c) change the `registerMemorySearchTool` call (~:378) to pass it: `registerMemorySearchTool(pi, memoryRepo, recallSet);`; (d) immediately after `setupErrorDetector(...)` (~:357) add `setupWorthScoring(pi, memoryRepo, recallSet, config);`.

- [ ] **Step 5: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-search-tool.test.ts )` then the full `tests/store/` + `tests/handlers/` suites (no regression). Verify `bunx tsc --noEmit` stays green.

- [ ] **Step 6: Commit** — `git add src/tools/memory-search-tool.ts src/index.ts tests/tools/memory-search-tool.test.ts && git commit -m "feat(hermes-memory): feed recall-set from memory_search + wire setupWorthScoring"`.

---

## Task 3: Close the no-neighbor fast-path (both backends)

**Files:**
- Modify: `src/store/sqlite/sqlite-memory-repo.ts` (~:498-503), `src/store/surreal/surreal-memory-repo.ts` (~:323-325)
- Modify: a search-ranking test (e.g. `tests/store/repository-contract.test.ts` or `sqlite-memory-repo.test.ts`)

**Interfaces:**
- Produces: single-match / no-neighbor searches route through `rankMemoryEntries` (so the worth multiplier applies), instead of the raw `last_referenced DESC` slice.

- [ ] **Step 1: Write the failing test** — in `tests/store/sqlite-memory-repo.test.ts` (bun:test), add:

```typescript
it("no-neighbor search applies the worth multiplier (fast-path closed)", async () => {
  // Two query-matching entries in DIFFERENT projects (no shared graph neighbor) → fast path.
  const high = await repo.addMemory({ content: "deploy via bun x", target: "memory", project: "p-high" });
  const low = await repo.addMemory({ content: "deploy via bun y", target: "memory", project: "p-low" });
  await repo.bumpMemoryWorth(high.id, 8, 0); // boost high
  await repo.bumpMemoryWorth(low.id, 0, 8);  // sink low
  const hits = await repo.searchMemories("deploy bun", { limit: 10 });
  const highIdx = hits.findIndex((h) => h.id === high.id);
  const lowIdx = hits.findIndex((h) => h.id === low.id);
  expect(highIdx).toBeGreaterThanOrEqual(0);
  expect(lowIdx).toBeGreaterThanOrEqual(0);
  expect(highIdx).toBeLessThan(lowIdx); // high-worth ranks above low-worth on the fast path
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`. Expected: FAIL (fast-path returns raw `last_referenced DESC`; the two entries tie on recency → id order, not worth order).

- [ ] **Step 3: Close the fast path** — in `src/store/sqlite/sqlite-memory-repo.ts`, replace `if (neighbors.length === 0) { return lexicalResults.slice(0, limit); }` with:

```typescript
      if (neighbors.length === 0) {
        return rankMemoryEntries({
          candidates: lexicalResults,
          lexicalMatchIds: new Set(lexicalResults.map((m) => m.id)),
          limit,
        });
      }
```
Make the IDENTICAL edit in `src/store/surreal/surreal-memory-repo.ts` (`if (neighbors.length === 0) return lexicalResults.slice(0, limit);` → the same `rankMemoryEntries({ candidates: lexicalResults, … })` call). Confirm `rankMemoryEntries` is already imported in both files (it is — they call it in the non-fast path).

- [ ] **Step 4: Run GREEN + audit existing order tests** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/ )`. This is a ranking behavior change (single-match order is now recency-normalized + worth-weighted, not raw `last_referenced DESC`). If any existing test asserts single-match/no-neighbor search ORDER and now fails, update it to the new (correct, worth-aware) order — do NOT revert the closure. Report any such updates.

- [ ] **Step 5: Commit** — `git add src/store/sqlite/sqlite-memory-repo.ts src/store/surreal/surreal-memory-repo.ts tests/store/sqlite-memory-repo.test.ts && git commit -m "feat(hermes-memory): close no-neighbor fast-path so worth applies to single-match search"`.

---

## Task 4: End-to-end wiring test (recall → correct → bump)

**Files:**
- Modify: `tests/handlers/worth-scoring.test.ts` (add an integration-style test wiring the real components)

**Interfaces:**
- Consumes: Tasks 1–3 (recall-set feed + handler + fast-path).

- [ ] **Step 1: Write the test** — append to `tests/handlers/worth-scoring.test.ts`:

```typescript
import { registerMemorySearchTool } from "../../src/tools/memory-search-tool.js";

describe("worth-scoring end-to-end (search → correction turn → bump)", () => {
  let tmpDir: string; let backend: SqliteBackend; let repo: SqliteMemoryRepository;
  let handlers: Record<string, Array<(e: any, ctx?: any) => Promise<void> | void>>;
  let tools: Record<string, any>; let recallSet: RecallSet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worth-e2e-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    handlers = {}; tools = {}; recallSet = new RecallSet();
    const pi: any = {
      on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); },
      registerTool: (def: any) => { tools[def.name] = def; },
      registerCommand() {},
    };
    setupWorthScoring(pi, repo, recallSet, { worthScoring: true, correctionStrongPatterns: [], correctionWeakPatterns: [], correctionNegativePatterns: [], correctionDirectiveWords: [] } as any);
    registerMemorySearchTool(pi, repo, recallSet);
  });
  afterEach(() => { backend.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const fire = async (ev: string, e: any, ctx?: any) => { for (const h of handlers[ev] ?? []) await h(e, ctx); };

  it("a search that recalls a memory, followed by a correction turn, bumps mw_fail", async () => {
    const m = await repo.addMemory({ content: "always commit on the main branch", target: "memory" });
    // recall it via the wired memory_search tool
    await tools.memory_search.execute("tc", { query: "commit branch", target: "memory" });
    expect(recallSet.drain().length).toBe(0); // drain() consumed by... no — tool recorded, turn_end not fired yet
    // NOTE: the tool recorded into recallSet; re-record assertion: the set is non-empty right after search
    // (re-add by re-running search since drain() above cleared it)
    await tools.memory_search.execute("tc2", { query: "commit branch", target: "memory" });
    // correction turn
    await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "no, never commit on main" }] } });
    await fire("turn_end", {}, {});
    const got = (await repo.getMemories({ target: "memory" })).find((x) => x.id === m.id)!;
    assert.strictEqual(got.mwFail, 1);
    assert.strictEqual(got.mwSuccess, 0);
  });
});
```
(Clean up the double-search artifact: the test needs the recall-set populated AT turn_end. The cleanest version: run the search once (populates recallSet), then immediately fire message_end + turn_end (which drains + bumps) — remove the stray `drain()` assertion line. Finalize the test so it runs the search, then the correction turn, then asserts mw_fail=1.)

- [ ] **Step 2: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/worth-scoring.test.ts )` then the full `tests/store/` + `tests/handlers/` suites.

- [ ] **Step 3: Commit** — `git add tests/handlers/worth-scoring.test.ts && git commit -m "test(hermes-memory): worth-scoring end-to-end (search → correction turn → bump)"`.

---

## Self-Review

1. **Spec coverage:** Plan 3 activates worth-scoring — recall-set feed (T2), turn_end trigger correction→fail/else→success (T1), fast-path closure so worth affects single-match search (T3), e2e proof (T4). The TRIGGER's error→fail path is DEFERRED (v1 = correction only) — documented. The `.md` write-through is DEFERRED (DB-authoritative) — documented.
2. **Placeholder scan:** every code step has real code; where an import path is uncertain ("match correction-detector's actual import path"), the implementer reads correction-detector first — named, not hand-waved. The T4 test has a cleanup note (remove the stray drain line) — the implementer finalizes it.
3. **Type consistency:** `RecallSet.record(number)` / `drain(): number[]`; `registerMemorySearchTool`'s 3rd param typed `{ record(id: number): void }` (structural — accepts `RecallSet`); `bumpMemoryWorth(id, successDelta?, failDelta?)` from Plan 2.
4. **Behavior change audit:** T3 (fast-path closure) changes single-match search ordering. The plan explicitly audits existing order tests and updates them to the worth-aware order (no revert). T1/T2 are additive (new handler + new optional param — backward compatible: `registerMemorySearchTool` without recallSet still works).
5. **Safety:** the `turn_end` handler is fully try/catch-wrapped + per-id best-effort + always drains (no unbounded growth). Disabled (`worthScoring:false`) → no bump but still drains.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-hermes-memory-worth-trigger.md`.

**Two execution options:**
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between.
2. **Inline Execution** — execute in this session via executing-plans.

**Which approach?**

This is **Plan 3** — it **activates** Plan 2's worth-scoring (recall → outcome → bump → rank). With it, the worth feature is live in production (counters increment on real sessions; ranking reflects worth). **Deferred follow-ups:** error→fail classification (a `tool_result` listener reusing `isLessonWorthy`); `.md` write-through for worth (if clone-survival ever matters). **Plan 4** = supersession (the largest remaining Tier-1 piece).
