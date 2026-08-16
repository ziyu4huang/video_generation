/**
 * Task 06 (cc-subagent-tui): ctrl+b dispatch — global (oldest foreground) +
 * in-viewer (focused run) both route through the SAME detach lever
 * (`convertToBackground` via `makeProdDetachDeps`). These tests pin the
 * dispatch LOGIC table-driven, no real terminal.
 *  - `dispatchCtrlB` detaches the OLDEST live foreground run;
 *  - no foreground run → no-op (never throws, convert never called);
 *  - terminal foreground entries are not detach targets (refusal is the
 *    capability's own contract, not the dispatcher's).
 * The post-detach notify line (Task 02 foreground-flip rule) is covered by
 * ext-task's notify.test.ts dispatch integration test.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import { dispatchCtrlB, foregroundRunIds } from "../src/ctrl-b.js";

function startRun(
  registry: SubagentInFlightRegistry,
  id: string,
  over: { foreground?: boolean; startedAt?: number; status?: "running" | "done" } = {},
) {
  registry.start({
    id,
    agent: "implementer",
    task: `task ${id}`,
    taskPreview: `task ${id}`,
    model: "provider/model",
    startedAt: over.startedAt ?? Date.now(),
    status: over.status ?? "running",
    foreground: over.foreground ?? true,
  });
}

describe("foregroundRunIds", () => {
  test("lists live foreground runs oldest startedAt first", () => {
    const registry = new SubagentInFlightRegistry();
    const t0 = Date.now();
    startRun(registry, "newer", { startedAt: t0 + 10_000 });
    startRun(registry, "older", { startedAt: t0 });
    startRun(registry, "bg", { foreground: false, startedAt: t0 - 5_000 });
    assert.deepEqual(foregroundRunIds(registry), ["older", "newer"]);
  });

  test("excludes terminal entries (not live detach targets)", () => {
    const registry = new SubagentInFlightRegistry();
    const t0 = Date.now();
    startRun(registry, "done-but-foreground", { startedAt: t0, status: "done" });
    startRun(registry, "live", { startedAt: t0 + 1_000 });
    assert.deepEqual(foregroundRunIds(registry), ["live"]);
  });
});

describe("dispatchCtrlB (global ctrl+b)", () => {
  test("detaches the oldest foreground run", () => {
    const registry = new SubagentInFlightRegistry();
    const t0 = Date.now();
    startRun(registry, "young", { startedAt: t0 + 10_000 });
    startRun(registry, "old", { startedAt: t0 });
    const calls: string[] = [];
    const outcome = dispatchCtrlB(registry, (id) => {
      calls.push(id);
      return { ok: true, runId: id };
    });
    assert.deepEqual(calls, ["old"], "the OLDEST foreground run is the default target");
    assert.deepEqual(outcome, { ok: true, runId: "old" });
  });

  test("no foreground run is a no-op (no throw, convert never called)", () => {
    const registry = new SubagentInFlightRegistry();
    startRun(registry, "only-bg", { foreground: false });
    const calls: string[] = [];
    const outcome = dispatchCtrlB(registry, (id) => {
      calls.push(id);
      return { ok: true, runId: id };
    });
    assert.deepEqual(calls, []);
    assert.equal(outcome, undefined);
  });
});
