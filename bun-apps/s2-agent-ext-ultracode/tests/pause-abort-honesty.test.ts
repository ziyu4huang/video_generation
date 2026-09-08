/**
 * self-arc-14 t03 — pause-abort notification honesty.
 *
 * The arc-11 finding: the FIRST background promise of a paused-then-resumed
 * workflow run delivered "✗ … failed: Subagent was aborted" — a lie about a
 * run that is parked and resumable. The fix classifies at throw time:
 * executeRun's catch no longer emits "error" for a MANUAL pause (pause()
 * already announced it with reason "paused"), and the delivery layer answers
 * reason "paused" with a superseded-by-resume notification.
 *
 * (a) paused background run → NO "error" emit, "paused" carries its reason,
 *     the delivered text says paused/superseded and never "failed";
 * (b) user stop → the failed delivery is PRESERVED (a kill is a kill);
 * (c) normal completion → unchanged (covered by the existing suites).
 */
import { beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type TaskPanelModule = {
  installResultDelivery: (pi: ExtensionAPI, manager: unknown) => void;
};

let mod: TaskPanelModule;
beforeAll(async () => {
  mod = (await import("../src/task-panel.js")) as TaskPanelModule;
});

function createMockPi(): ExtensionAPI & { _calls: { content: string }[] } {
  const calls: { content: string }[] = [];
  const obj = {
    sendMessage(msg: unknown) {
      calls.push({ content: (msg as { content?: string }).content ?? "" });
    },
    registerTool: () => {},
    on: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    reload: () => Promise.resolve(),
    _calls: calls,
  };
  return obj as unknown as ExtensionAPI & { _calls: { content: string }[] };
}

function createMockManager(run: unknown) {
  const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
    getRun: () => unknown;
    markDelivered: () => void;
  };
  manager.getRun = () => run;
  manager.markDelivered = () => {};
  return manager;
}

describe("delivery layer: reason 'paused' (manual pause of a background run)", () => {
  it("(a) delivers superseded-by-resume, never 'failed'", () => {
    const pi = createMockPi();
    const manager = createMockManager({ background: true });
    mod.installResultDelivery(pi, manager);

    manager.emit("paused", { runId: "wf-1", reason: "paused" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1, "exactly one notification");
    assert.ok(calls[0].content.includes("paused"), "says paused");
    assert.ok(calls[0].content.includes("superseded by resume"), "names the honest semantics");
    assert.ok(calls[0].content.includes("/workflows resume wf-1"), "names the resume command");
    assert.ok(!/failed/.test(calls[0].content), "never says failed");
  });

  it("a no-reason paused emit stays silent (legacy shape ignored)", () => {
    const pi = createMockPi();
    const manager = createMockManager({ background: true });
    mod.installResultDelivery(pi, manager);
    manager.emit("paused", { runId: "wf-1" });
    assert.equal((pi as unknown as { _calls: unknown[] })._calls.length, 0);
  });

  it("(b) user-kill error delivery is PRESERVED", () => {
    const pi = createMockPi();
    const manager = createMockManager({ background: true });
    mod.installResultDelivery(pi, manager);

    manager.emit("error", { runId: "wf-1", error: { message: "Workflow was aborted" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("failed"), "a kill is still a failure");
  });
});

describe("manager: manual pause unwinds without the error event", () => {
  const oneAgentScript = `export const meta = { name: 'pause_honesty', description: 'one agent' }
phase('Work')
await agent('do it', { label: 'a' })
return { ok: true }`;

  function withTempCwd(fn: (cwd: string) => Promise<void>) {
    return async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-pause-honesty-"));
      const fakeHome = mkdtempSync(join(tmpdir(), "pi-pause-honesty-home-"));
      try {
        await withFakeHomeAsync(fakeHome, () => fn(cwd));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(fakeHome, { recursive: true, force: true });
      }
    };
  }

  /**
   * An abort-HONORING fake: the real child session rejects shortly after its
   * signal fires (that rejection is exactly what used to trigger the "✗ …
   * failed" delivery on pause). A never-settling fake would hang — with no
   * timeout configured, the runtime passes the parent signal through without
   * racing it (workflow-timeout.ts: default path).
   */
  function abortHonoringAgent() {
    return {
      async run(_prompt: string) {
        await new Promise((_, reject) => setTimeout(() => reject(new Error("Subagent was aborted")), 50));
      },
    };
  }

  it(
    "(a) pause() of a running background run: paused event carries reason, error never fires",
    withTempCwd(async (cwd) => {
      const manager = new WorkflowManager({ cwd, agent: abortHonoringAgent() });
      const events: Array<{ type: string; reason?: string }> = [];
      manager.on("error", () => events.push({ type: "error" }));
      manager.on("paused", (e: { reason?: string }) => events.push({ type: "paused", reason: e.reason }));

      const { runId, promise } = manager.startInBackground(oneAgentScript);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(manager.pause(runId), true, "pause accepted while running");
      // The first background promise unwinds with the abort — but the EVENT
      // stream must announce a pause, not an error.
      await assert.rejects(promise);
      assert.ok(
        events.some((e) => e.type === "paused" && e.reason === "paused"),
        "manual pause emits paused with its reason",
      );
      assert.ok(!events.some((e) => e.type === "error"), "no error event for a parked, resumable run");
    }),
  );

  it(
    "(b) stop() of a running background run still emits error (a kill is a kill)",
    withTempCwd(async (cwd) => {
      const manager = new WorkflowManager({ cwd, agent: abortHonoringAgent() });
      let errored = false;
      manager.on("error", () => {
        errored = true;
      });

      const { runId, promise } = manager.startInBackground(oneAgentScript);
      await new Promise((r) => setTimeout(r, 30));
      manager.stop(runId);
      await assert.rejects(promise);
      assert.ok(errored, "user kill keeps the error event (failed delivery preserved)");
    }),
  );
});
