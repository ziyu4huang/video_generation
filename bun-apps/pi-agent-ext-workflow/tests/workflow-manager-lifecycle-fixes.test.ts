import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/**
 * Manager lifecycle regressions (2026-07 code review):
 *  1. A failed run must abort its in-flight sibling agents (they were left
 *     running to completion for a run that was already dead).
 *  2. ExecOptions (tokenBudget/maxAgents/...) must be persisted and rehydrated
 *     by resume() (they silently reset to manager defaults — a run paused for
 *     exhausting its budget resumed unbounded).
 *  3. After pause() → resume(), a late persist from the OLD executeRun teardown
 *     must not clobber the resumed run's newer persisted state.
 */

/** Run each test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-lifecycle-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "a non-recoverable agent failure aborts in-flight sibling agents",
  withTempCwd(async (cwd) => {
    let hangSawAbort = false;
    let hangResolve: ((v: unknown) => void) | undefined;
    const runner = {
      async run(prompt: string, options: { signal?: AbortSignal }) {
        if (prompt === "fail") {
          // Give the sibling a beat to start, then fail the run for good.
          await new Promise((r) => setTimeout(r, 20));
          throw new WorkflowError("boom", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
        }
        // "hang": stay in flight until the run-level controller aborts us.
        return new Promise((resolve) => {
          hangResolve = resolve;
          options.signal?.addEventListener(
            "abort",
            () => {
              hangSawAbort = true;
              resolve("aborted");
            },
            { once: true },
          );
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'sib', description: 'd' }
const results = await parallel([() => agent('hang', { label: 'hang' }), () => agent('fail', { label: 'fail' })])
return { results }`;

    await assert.rejects(manager.runSync(script, undefined, {}), (err: unknown) => {
      assert.ok(err instanceof WorkflowError);
      return true;
    });
    // The failing thunk killed the run — the hanging sibling must have been
    // aborted rather than left running for a dead run.
    assert.equal(hangSawAbort, true, "sibling agent's signal was never aborted after the run failed");
    hangResolve?.("cleanup");
  }),
);

test(
  "ExecOptions are persisted at start and survive pause → resume",
  withTempCwd(async (cwd) => {
    // Per-call deferreds: call 1 (original run) hangs; call 2 (resume) resolves.
    const resolvers: Array<(v: unknown) => void> = [];
    const runner = {
      run(_prompt: string, _options: unknown): Promise<unknown> {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'caps', description: 'd' }
const a = await agent('work', { label: 'a' })
return { a }`;

    const exec = { tokenBudget: 123456, maxAgents: 7, concurrency: 3, agentRetries: 2, agentTimeoutMs: null };
    const { runId, promise } = manager.startInBackground(script, undefined, exec);
    promise.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    // The caps must be on disk before any pause/crash, so resume can see them.
    assert.deepEqual(manager.getPersistedRun(runId)?.exec, exec, "exec caps not persisted at start");

    assert.equal(manager.pause(runId), true, "pause failed");
    assert.equal(manager.getPersistedRun(runId)?.status, "paused");

    assert.equal(await manager.resume(runId), true, "resume failed");
    await new Promise((r) => setTimeout(r, 20));
    // Resolve the resumed run's live agent (original call 1 stays hung).
    assert.ok(resolvers.length >= 2, `expected a second agent call on resume, saw ${resolvers.length}`);
    resolvers[resolvers.length - 1]?.("done");

    // Wait for the resumed run to complete.
    for (let i = 0; i < 100 && manager.getPersistedRun(runId)?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const final = manager.getPersistedRun(runId);
    assert.equal(final?.status, "completed", "resumed run did not complete");
    // The resumed executeRun re-captured and re-persisted the SAME caps —
    // proving resume() rehydrated them instead of resetting to defaults.
    assert.deepEqual(final?.exec, exec, "exec caps were dropped by resume()");
    // Unblock the original run's hung agent so its teardown finishes.
    resolvers[0]?.("late");
  }),
);

test(
  "late persist from a paused run's teardown cannot clobber the resumed run's state",
  withTempCwd(async (cwd) => {
    const resolvers: Array<(v: unknown) => void> = [];
    const runner = {
      run(_prompt: string, _options: unknown): Promise<unknown> {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'race', description: 'd' }
const a = await agent('work', { label: 'a' })
return { a }`;

    const { runId, promise: originalRun } = manager.startInBackground(script, undefined, {});
    const originalSettled = originalRun.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    // Pause, then resume before the old executeRun's teardown has persisted
    // (its in-flight agent — resolvers[0] — is still hanging, so the teardown
    // is blocked waiting on it).
    assert.equal(manager.pause(runId), true, "pause failed");
    assert.equal(await manager.resume(runId), true, "resume failed");
    await new Promise((r) => setTimeout(r, 20));

    // Let the RESUMED run finish first...
    assert.ok(resolvers.length >= 2, `expected a second agent call on resume, saw ${resolvers.length}`);
    resolvers[resolvers.length - 1]?.("done");
    for (let i = 0; i < 100 && manager.getPersistedRun(runId)?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(manager.getPersistedRun(runId)?.status, "completed", "resumed run did not complete");

    // ...THEN release the old run's hung agent, so its aborted teardown persists
    // last. The stale-write guard must drop that write.
    resolvers[0]?.("late");
    await originalSettled;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      manager.getPersistedRun(runId)?.status,
      "completed",
      "old teardown's stale 'paused' snapshot clobbered the resumed run's completed state",
    );
  }),
);
