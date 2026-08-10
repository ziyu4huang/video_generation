// src/handlers/planning-backfill.test.ts — T6 background backfill tests.
// Mirrors the session-backfill test discipline: an injected inline `setTimeout`
// drives the deferred task synchronously so the test can await the (already
// resolved) state.promise without real timers.
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulePlanningBackfill, planningBackfillState, PLANNING_BACKFILL_MAX_FILES } from "./planning-backfill.js";
// NOTE: brief authored the import as "../src/store/card-store.js" but this file
// lives at src/handlers/, so the correct relative path is ../store/...
import { createCardStore } from "../store/card-store.js";
import { getStaleCards } from "../store/planning-staleness.js"; // 10-impl T5 — sweep flags-stale probe

function flushedState() {
  return { inProgress: false, promise: null as Promise<void> | null };
}

describe("schedulePlanningBackfill", () => {
  it("re-mirrors a changed planning md within bounds (fake timers via injected setTimeout)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pbf-"));
    const mem = mkdtempSync(join(tmpdir(), "pbf-mem-"));
    const state = flushedState();
    let fired = false;
    const flush = (cb: () => void) => { fired = true; cb(); }; // run inline
    try {
      const effort = "backfill-eff";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nBackfilled.\n");
      schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
      // The injected setTimeout ran inline; await the (already-resolved) promise.
      await state.promise;
      assert.ok(fired);
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /Backfilled\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("skips when a backfill is already in progress (run-state guard)", () => {
    const state = { inProgress: true, promise: Promise.resolve() };
    let called = false;
    const scheduled = schedulePlanningBackfill("/nonexistent", "/nonexistent", {
      state,
      setTimeoutFn: (() => { called = true; }) as never,
    });
    assert.equal(scheduled, false);
    assert.equal(called, false);
  });

  it("exports a MAX_FILES bound (parity with session backfill)", () => {
    assert.ok(PLANNING_BACKFILL_MAX_FILES > 0);
    assert.ok(planningBackfillState !== undefined);
  });
});

// 10-impl T5 — the staleness sweep is folded INTO schedulePlanningBackfill's
// deferred block (runs AFTER walkAndIngest mirrors the ticket rows). It is
// COMPARE-ONLY: computeStaleness SEEDS the dep baseline on first touch + FLAGS
// stale thereafter; it MUST NOT re-baseline (decision ζ — a re-baselining sweep
// would wipe stale state every session_start, contradicting γ). Re-baselining is
// the explicit refreshStaleness op. Mirrors the backfill test discipline: an
// injected inline `flush` setTimeout drives the deferred task synchronously.
describe("schedulePlanningBackfill — staleness sweep (10-impl T5)", () => {
  it("sweep seeds baselines + flags a card stale after its dep changes (compare-only, no rebaseline)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pbf-stale-"));
    const mem = mkdtempSync(join(tmpdir(), "pbf-stale-mem-"));
    const state = { inProgress: false, promise: null as Promise<void> | null };
    const flush = (cb: () => void) => cb();
    try {
      const effort = "sweep-eff";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "dep.ts"), "v1");
      writeFileSync(
        join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\ndepends_on: src/dep.ts\n---\n# 01 — x\n\n## Resolution\n\nDepends on src/dep.ts.\n",
      );
      // 1st sweep: mirror the ticket + seed the dep baseline @ v1.
      schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
      await state.promise;
      // Confirm the baseline was seeded (first-touch) and the card is NOT stale yet.
      const pre = await createCardStore({ memoryDir: mem });
      try {
        assert.ok(await pre.getCardDepHash(`planning-ticket:${effort}:01`), "1st sweep seeded the dep baseline");
        assert.deepEqual(await getStaleCards(pre, effort, root), []);
      } finally {
        await pre.close();
      }
      // Change the dep AFTER the baseline is seeded.
      writeFileSync(join(root, "src", "dep.ts"), "v2-EDITED");
      // 2nd sweep: flags stale (compare-only; NO rebaseline).
      state.inProgress = false;
      state.promise = null;
      schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
      await state.promise;
      const store = await createCardStore({ memoryDir: mem });
      try {
        const stale = await getStaleCards(store, effort, root);
        assert.ok(
          stale.some((s) => s.cardId === `planning-ticket:${effort}:01`),
          "edited dep must flag the card stale (sweep did NOT rebaseline)",
        );
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("no planning cards -> sweep is a no-op (no throw, resolves)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pbf-empty-"));
    const mem = mkdtempSync(join(tmpdir(), "pbf-empty-mem-"));
    const state = { inProgress: false, promise: null as Promise<void> | null };
    const flush = (cb: () => void) => cb();
    try {
      // No .planning/ at all -> collectPlanningMdFiles returns [] -> backfill
      // early-returns AND the sweep's getCardsByKind is empty. Must NOT throw.
      schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
      await state.promise;
      const store = await createCardStore({ memoryDir: mem });
      try {
        assert.deepEqual(await store.getCardsByKind("planning-ticket"), []);
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
