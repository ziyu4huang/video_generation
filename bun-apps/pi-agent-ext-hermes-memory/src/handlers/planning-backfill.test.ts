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
