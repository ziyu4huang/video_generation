import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowManager } from "../src/workflow-manager.js";

/**
 * Self-arc-24 t04 — the steering plumbing seam, unit-tested end-to-end with a
 * fake steer-capable session: runtime emit (onAgentSession) → manager registry
 * → steerWorkflowAgent. Command/UI surfaces are charted, not landed.
 */

const SCRIPT = "export const meta = { name: 't', description: 'd', phases: [{ title: 'P' }] };\nawait agent('x');\n";

/** Agent that exposes a steer-capable session and STAYS LIVE until released. */
function sessionExposingAgent() {
  const steered: string[] = [];
  let release: (() => void) | null = null;
  const live = new Promise<void>((r) => {
    release = r;
  });
  return {
    steered,
    release: () => release?.(),
    runner: {
      async run(
        _prompt: string,
        options: {
          onSession?: (session: { steer: (text: string) => Promise<unknown> }) => void;
          onUsage?: (u: unknown) => void;
        },
      ) {
        options.onSession?.({
          steer: async (text: string) => {
            steered.push(text);
          },
        });
        await live;
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      },
    },
  };
}

describe("steerWorkflowAgent seam", () => {
  test("delivers guidance to a LIVE agent via the registry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-steer-"));
    const { runner, steered, release } = sessionExposingAgent();
    const manager = new WorkflowManager({ cwd, agent: runner as never });
    const { runId, promise } = manager.startInBackground(SCRIPT, {}, {});

    // Wait for the runtime to assemble the session (onAgentSession → registry).
    await Bun.sleep(50);
    const registered = await manager.steerWorkflowAgent(runId, 0, "focus on the auth module");
    expect(registered).toEqual({ steered: true });
    expect(steered).toEqual(["focus on the auth module"]);

    // After settle the handle is evicted — steering is an honest no-op.
    release();
    await promise;
    expect(await manager.steerWorkflowAgent(runId, 0, "too late")).toEqual({
      steered: false,
      reason: "agent-not-live",
    });
  }, 10000);

  test("steering an unknown run is an honest no-op", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-steer-"));
    const manager = new WorkflowManager({ cwd, agent: sessionExposingAgent().runner as never });
    const result = await manager.steerWorkflowAgent("no-such-run", 0, "hello");
    expect(result).toEqual({ steered: false, reason: "agent-not-live" });
  });
});
