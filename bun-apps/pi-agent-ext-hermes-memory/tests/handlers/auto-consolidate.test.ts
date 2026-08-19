/**
 * Unit tests for auto-consolidation — triggerConsolidation and /memory-consolidate command.
 *
 * Consolidation dispatches through the shared `spawnSubagent` runner. The
 * `spawn` arg on `triggerConsolidation` / `registerConsolidateCommand` is the
 * injection seam: production omits it (→ real spawnSubagent), tests pass a fake
 * that records the call opts and returns a synthesized `SpawnSubagentResult`.
 */

import { describe, it, test, expect, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "@repo/pi-agent-core-runtime";
import {
  fireProactiveIfReady,
  registerConsolidateCommand,
  resolveConsolidatorModelLabel,
  triggerConsolidation,
} from "../../src/handlers/auto-consolidate.js";

// ─── Mock infrastructure ───

/** A minimal memory-tool definition — only identity matters: it is the value
 *  threaded through `extensionTools` so we can assert reference equality. */
const memoryToolDef: ToolDefinition = {
  name: "memory",
  label: "Memory",
  description: "test memory tool",
  // typebox-free stand-in: triggerConsolidation never executes it (the fake
  // spawn short-circuits the run), only forwards it verbatim.
  parameters: {} as never,
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
} as ToolDefinition;

interface FakeSpawnOverrides extends Partial<SpawnSubagentResult> {
  /** Simulate a slow subagent run so the heartbeat window opens. */
  delayMs?: number;
  /** Throw from spawn instead of returning (models a runner crash). */
  throwErr?: string;
}

function createFakeSpawn(overrides: FakeSpawnOverrides = {}) {
  const calls: SpawnSubagentOptions[] = [];
  const result: SpawnSubagentResult = {
    output: overrides.output ?? "Consolidated",
    ...(overrides.failure ? { failure: overrides.failure } : {}),
    ...(overrides.usage ? { usage: overrides.usage } : {}),
  };
  const spawn = async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
    calls.push(opts);
    if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs));
    if (overrides.throwErr) throw new Error(overrides.throwErr);
    return result;
  };
  return { spawn: spawn as typeof import("@repo/pi-agent-core-runtime").spawnSubagent, calls, result };
}

const mockStore = {
  getMemoryEntries: () => ["old entry 1", "old entry 2"],
  getUserEntries: () => ["user fact 1"],
  getAllFailureEntries: () => ["failure lesson 1", "failure lesson 2"],
  loadFromDisk: async () => {},
} as never;

// ─── Tests ───

describe("triggerConsolidation", () => {
  it("honors llmModelOverride by passing model (and no tier) to spawn", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(
      mockStore,
      "memory",
      memoryToolDef,
      undefined,
      60000,
      "memory",
      { llmModelOverride: "anthropic/claude-opus-4" },
      spawn,
    );

    assert.strictEqual(calls.length, 1, "should call spawn once");
    const opts = calls[0]!;
    assert.strictEqual(opts.model, "anthropic/claude-opus-4", "should thread the override as model");
    assert.strictEqual(opts.tier, undefined, "should NOT set tier when an override is present");
    // Everything else stays byte-identical to the unset path.
    assert.deepStrictEqual(opts.tools, ["memory"]);
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef]);
    assert.strictEqual(opts.retryOnTransient, false);
  });

  it("falls back to tier:'small' (and no model) when llmModelOverride is unset", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(calls.length, 1);
    const opts = calls[0]!;
    assert.strictEqual(opts.tier, "small", "should run on the small tier");
    assert.strictEqual(opts.model, undefined, "should NOT set model when no override is present");
  });

  it("dispatches consolidation via spawnSubagent with the memory tool bridged in", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(calls.length, 1, "should call spawn once");
    const opts = calls[0]!;
    assert.strictEqual(opts.tier, "small", "should run on the small tier");
    assert.deepStrictEqual(opts.tools, ["memory"], "should allowlist only the memory tool");
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef], "should bridge the parent memory tool def");
    assert.strictEqual(opts.timeoutMs, 60000);
    assert.strictEqual(opts.retryOnTransient, false, "consolidation holds the cross-process fileLock — must NOT retry on transient/timeout");
    assert.ok(opts.task?.includes("old entry 1"), "task should include current memory entries");
    assert.ok(opts.task?.includes("Target: 'memory'"), "task should tell the child which target to use");
    assert.match(opts.instructions ?? "", /memory consolidator/i, "instructions should frame the consolidator role");
  });

  it("caps the consolidator with the writer envelope (escape hatch honored)", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(calls.length, 1);
    const opts = calls[0]!;
    // roleAwareDefaults({}, "writer") threads the writer bounds into the spawn
    // opts (the consolidator previously ran envelope-less — direct calls
    // bypass the tool-seam role bounds).
    assert.strictEqual(opts.tokenBudget, 400_000, "writer tokenBudget cap");
    assert.strictEqual(opts.maxTurns, 28, "writer maxTurns cap");
    // The timeoutMs param default (60000) stays verbatim.
    assert.strictEqual(opts.timeoutMs, 60000);

    // SUBAGENT_TOKEN_BUDGET_DISABLE=1 → envelope absent (env read at call time).
    const saved = process.env.SUBAGENT_TOKEN_BUDGET_DISABLE;
    process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
    try {
      const escape = createFakeSpawn();
      await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, escape.spawn);

      assert.strictEqual(escape.calls.length, 1);
      const escapeOpts = escape.calls[0]!;
      assert.strictEqual(escapeOpts.tokenBudget, undefined, "escape hatch drops tokenBudget");
      assert.strictEqual(escapeOpts.maxTurns, undefined, "escape hatch drops maxTurns");
      assert.strictEqual(escapeOpts.timeoutMs, 60000, "wall-clock stays even under the escape hatch");
    } finally {
      if (saved === undefined) delete process.env.SUBAGENT_TOKEN_BUDGET_DISABLE;
      else process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = saved;
    }
  });

  it("passes retryOnTransient:false — consolidation holds the cross-process fileLock, so a timed-out run must NOT be retried", async () => {
    // Regression guard for the 120s lock-contention bug (perf.jsonl):
    // auto-consolidation runs WHILE the parent holds the cross-process
    // `withFileLock` on the target (so its in-process child, which bypasses
    // the lock, is the sole writer). The in-process spawnSubagent classifies a
    // timeout (signal abort) as `transient` and RETRIES it — re-running the
    // consolidator for another full timeout while STILL holding the lock. A
    // timed-out merge is best-effort (it falls through to the vault-offload
    // floor), so retrying only re-holds the lock and re-fails, starving every
    // concurrent sibling-agent writer for ~2× the timeout (observed 120s =
    // 60s + 60s, with 144s / 998s outliers). Consolidation must opt OUT of
    // transient retry (mirrors the shutdown/flush path's retryOnTransient:false).
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0]!.retryOnTransient,
      false,
      "consolidation must not retry on transient/timeout: it holds the cross-process fileLock for the full run",
    );
  });

  it("threads the host signal and timeoutMs into spawn", async () => {
    const { spawn, calls } = createFakeSpawn();
    const ac = new AbortController();
    await triggerConsolidation(mockStore, "memory", memoryToolDef, ac.signal, 12345, "memory", {}, spawn);

    assert.strictEqual(calls[0]!.timeoutMs, 12345);
    assert.strictEqual(calls[0]!.externalSignal, ac.signal);
  });

  it("returns { consolidated: true } when the spawn reports no failure", async () => {
    const { spawn } = createFakeSpawn({ output: "Done" });
    const result = await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.error, undefined);
  });

  it("reloads the store from disk after a successful consolidation", async () => {
    let reloaded = false;
    const store = {
      ...mockStore,
      loadFromDisk: async () => {
        reloaded = true;
      },
    } as never;
    const { spawn } = createFakeSpawn({});

    await triggerConsolidation(store, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.ok(reloaded, "store should reload from disk after success");
  });

  it("returns { consolidated: false } when the spawn reports a failure", async () => {
    const { spawn } = createFakeSpawn({ failure: { kind: "failed", message: "some error" } });
    const result = await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error, "should have an error message");
    assert.ok(result.error!.includes("some error"), "error should carry the failure message");
  });

  it("surfaces the runner failure message on failure", async () => {
    const { spawn } = createFakeSpawn({ failure: { kind: "failed", message: "model not found" } });
    const result = await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error!.includes("model not found"), "should surface the failure message verbatim");
  });

  it("surfaces timeout when the spawn failure is a timeout", async () => {
    const { spawn } = createFakeSpawn({ failure: { kind: "timedout", message: "timed out" } });
    const result = await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(result.consolidated, false);
    assert.match(result.error!, /terminated/i);
    assert.match(result.error!, /60000ms/);
  });

  it("returns { consolidated: false } when spawn throws", async () => {
    const { spawn } = createFakeSpawn({ throwErr: "network failure" });
    const result = await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error!.includes("Consolidation failed"), "should mention failure");
    assert.ok(result.error!.includes("network failure"), "should include original error");
  });

  it("includes user profile entries when target is 'user'", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "user", memoryToolDef, undefined, 60000, "user", {}, spawn);

    assert.ok(calls[0]!.task.includes("user fact 1"), "task should include user entries");
    assert.ok(calls[0]!.task.includes("User Profile"), "task should reference user profile");
  });

  it("includes failure entries when target is 'failure'", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "failure", memoryToolDef, undefined, 60000, "failure", {}, spawn);

    assert.ok(calls[0]!.task.includes("failure lesson 1"), "task should include failure entries");
    assert.ok(calls[0]!.task.includes("Failure Memory"), "task should reference failure memory");
    assert.ok(calls[0]!.task.includes("Target: 'failure'"), "task should tell the child to use target='failure'");
  });

  it("can consolidate project memory using the project tool target", async () => {
    const { spawn, calls } = createFakeSpawn();
    await triggerConsolidation(mockStore, "memory", memoryToolDef, undefined, 60000, "project", {}, spawn);

    assert.ok(calls[0]!.task.includes("old entry 1"), "task should include project memory entries");
    assert.ok(calls[0]!.task.includes("Project Memory"), "task should label project memory");
    assert.ok(calls[0]!.task.includes("Target: 'project'"), "task should tell the child to use target='project'");
  });

  it("handles empty entries gracefully", async () => {
    const { spawn, calls } = createFakeSpawn();
    const emptyStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
      loadFromDisk: async () => {},
    } as never;

    await triggerConsolidation(emptyStore, "memory", memoryToolDef, undefined, 60000, "memory", {}, spawn);

    assert.ok(calls[0]!.task.includes("(empty)"), "task should show (empty) for empty entries");
  });
});

describe("registerConsolidateCommand", () => {
  it("includes project memory when a project store is available", async () => {
    let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const notifications: string[] = [];
    let projectReloaded = false;

    const projectStore = {
      getMemoryEntries: () => ["project fact"],
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
      loadFromDisk: async () => {
        projectReloaded = true;
      },
    } as never;

    const { spawn, calls } = createFakeSpawn({});

    const pi = {
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as never;

    registerConsolidateCommand(pi, mockStore, memoryToolDef, 60000, projectStore, "demo-project", {}, 15000, spawn);
    await handler!({}, {
      signal: undefined,
      ui: { notify: (message: string) => notifications.push(message) },
    });

    assert.strictEqual(calls.length, 4, "should consolidate memory, user, failure, and project stores");
    const failureTask = calls[2]!.task;
    assert.ok(failureTask.includes("Failure Memory"), "failure task should be labeled");
    assert.ok(failureTask.includes("failure lesson 1"), "failure task should include failure entries");
    assert.ok(failureTask.includes("Target: 'failure'"), "failure task should use target='failure'");
    const projectTask = calls[3]!.task;
    assert.ok(projectTask.includes("Project Memory"), "project task should be labeled");
    assert.ok(projectTask.includes("project fact"), "project task should include project entries");
    assert.ok(projectTask.includes("Target: 'project'"), "project task should use target='project'");
    assert.ok(projectReloaded, "project store should reload after consolidation");
    assert.ok(notifications.some((m) => m.includes("Starting memory consolidation")), "should show an initial progress notification");
    assert.ok(notifications.some((m) => m.includes("⏳ Consolidating memory")), "should show per-target progress");
    const finalNotification = notifications[notifications.length - 1] ?? "";
    assert.ok(finalNotification.includes("failure: ✅ consolidated"), "final notification should include failure result");
    assert.ok(finalNotification.includes("project:demo-project: ✅ consolidated"), "final notification should include project result");
  });

  it("uses a longer timeout floor for the manual consolidate command", async () => {
    let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const calls: SpawnSubagentOptions[] = [];
    const { spawn } = createFakeSpawn({});

    const pi = {
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as never;

    registerConsolidateCommand(pi, mockStore, memoryToolDef, 60000, null, undefined, {}, 15000, spawn);
    await handler!({}, { signal: undefined, ui: { notify: () => {} } });

    for (const call of calls) {
      assert.strictEqual(call.timeoutMs, 180000, "manual consolidate should floor the timeout at 180s");
    }
  });

  it("emits an elapsed-time heartbeat while a consolidation target is in flight", async () => {
    let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const notifications: string[] = [];
    const { spawn } = createFakeSpawn({ delayMs: 60 }); // slow run → heartbeat window

    const pi = {
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as never;

    registerConsolidateCommand(pi, mockStore, memoryToolDef, 60000, null, undefined, {}, 15, spawn); // heartbeatMs=15
    await handler!({}, {
      signal: undefined,
      ui: { notify: (m: string) => notifications.push(m) },
    });

    const beats = notifications.filter((m) => /elapsed/.test(m));
    assert.ok(beats.length >= 1, `expected ≥1 elapsed heartbeat; got ${beats.length} among ${notifications.length} notifies`);
    assert.match(beats[beats.length - 1]!, /\d+s elapsed/);

    // Progress format: target ratio (processed/total) + entry-count magnitude,
    // not just elapsed time. Per-note streaming is infeasible (single opaque
    // subagent run per target), so the feasible signal is which target we're on
    // plus how many notes it holds. mockStore → memory(2), user(1), failure(2).
    assert.ok(beats.some((m) => /\(\d+\/\d+\)/.test(m)), "heartbeat should include target progress ratio");
    assert.ok(beats.some((m) => /notes?\b/.test(m)), "heartbeat should include entry count");
    assert.ok(
      beats.some((m) => /\(1\/3\) · 2 notes/.test(m)),
      "first-target heartbeat should read '(1/3) · 2 notes'",
    );
    const expectedModelLabel = resolveConsolidatorModelLabel({});
    assert.ok(
      beats.some((m) => m.includes(expectedModelLabel)),
      `heartbeat should include resolved model label '${expectedModelLabel}'`,
    );
  });

  it("does not throw if the command ctx becomes stale before the final summary notify", async () => {
    let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const { spawn } = createFakeSpawn({});

    const pi = {
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as never;

    registerConsolidateCommand(pi, mockStore, memoryToolDef, 60000, null, undefined, {}, 15000, spawn);

    await assert.doesNotReject(async () => {
      await handler!({}, {
        signal: undefined,
        ui: {
          notify: () => {
            throw new Error("This extension ctx is stale after session replacement or reload.");
          },
        },
      });
    });
  });
});

describe("resolveConsolidatorModelLabel", () => {
  const savedModel = process.env.PI_MODEL;
  const savedProvider = process.env.PI_PROVIDER;

  afterAll(() => {
    if (savedModel === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = savedModel;
    if (savedProvider === undefined) delete process.env.PI_PROVIDER;
    else process.env.PI_PROVIDER = savedProvider;
  });

  it("returns the llmModelOverride verbatim when set (priority over env)", () => {
    assert.strictEqual(
      resolveConsolidatorModelLabel({ llmModelOverride: "anthropic/claude-opus-4" }),
      "anthropic/claude-opus-4",
    );
    // surrounding whitespace is trimmed
    assert.strictEqual(
      resolveConsolidatorModelLabel({ llmModelOverride: "  glm-5.2  " }),
      "glm-5.2",
    );
  });

  it("falls back to PI_PROVIDER/PI_MODEL env when no override is set", () => {
    process.env.PI_MODEL = "glm-5.2";
    process.env.PI_PROVIDER = "zai";
    assert.strictEqual(resolveConsolidatorModelLabel({}), "zai/glm-5.2");
  });

  it("falls back to PI_MODEL alone when PI_PROVIDER is absent", () => {
    delete process.env.PI_PROVIDER;
    process.env.PI_MODEL = "glm-5.2";
    assert.strictEqual(resolveConsolidatorModelLabel({}), "glm-5.2");
  });

  it("returns 'default' when neither override nor PI_MODEL is set", () => {
    delete process.env.PI_MODEL;
    delete process.env.PI_PROVIDER;
    assert.strictEqual(resolveConsolidatorModelLabel({}), "default");
  });
});

describe("MemoryStore auto-consolidation integration", () => {
  let MEMORY_DIR = "";

  beforeAll(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-test-"));
  });

  afterAll(async () => {
    try { await fs.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("add() triggers consolidation when over limit with consolidator", async () => {
    let consolidatorCalled = false;
    let consolidatorTarget: string | undefined;

    const { MemoryStore } = await import("../../src/store/memory-store.js");
    const store = new MemoryStore({
      memoryCharLimit: 120,
      userCharLimit: 120,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    // Mock consolidator that actually frees space (2-phase: returns a drop-all
    // MergePlan; the store applies it in step 3).
    store.setConsolidator(async (snapshot) => {
      consolidatorCalled = true;
      consolidatorTarget = snapshot.target;
      return {
        plan: {
          snapshotBaseHash: snapshot.snapshotBaseHash,
          ops: snapshot.entries.map((e) => ({ op: "drop" as const, key: e.key })),
        },
      };
    });

    await store.loadFromDisk();

    // Fill up memory to near limit (each entry gets ~44 chars of metadata)
    const smallEntry = "a".repeat(60);
    await store.add("memory", smallEntry);

    // This add should exceed limit and trigger consolidation
    const result = await store.add("memory", "b".repeat(20));

    assert.ok(consolidatorCalled, "consolidator should have been called");
    assert.strictEqual(consolidatorTarget, "memory");
    // After consolidation removes entries, the new entry should fit
    assert.ok(result.success, "add should succeed after consolidation");
  });

  it("add() skips consolidation when autoConsolidate is false", async () => {
    let consolidatorCalled = false;
    const { MemoryStore } = await import("../../src/store/memory-store.js");

    const store = new MemoryStore({
      memoryCharLimit: 50,
      userCharLimit: 50,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    store.setConsolidator(async (snapshot) => {
      consolidatorCalled = true;
      return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
    });

    await store.loadFromDisk();

    const result = await store.add("memory", "x".repeat(60));
    assert.ok(!consolidatorCalled, "consolidator should NOT be called when autoConsolidate is false");
    assert.ok(!result.success, "should return error");
    assert.ok(result.error!.includes("exceed"), "should mention exceeding limit");
  });

  it("add() skips consolidation when no consolidator set", async () => {
    const { MemoryStore } = await import("../../src/store/memory-store.js");

    const store = new MemoryStore({
      memoryCharLimit: 50,
      userCharLimit: 50,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    // Intentionally NOT calling setConsolidator
    await store.loadFromDisk();

    const result = await store.add("memory", "x".repeat(60));
    assert.ok(!result.success, "should return error");
    assert.ok(result.error!.includes("exceed"), "should mention exceeding limit");
  });
});

// ─── Task 4: fireProactiveIfReady guard helper ───────────────────────────────
//
// UPSP §1 — fires-after-write trigger. The helper owns ONLY the enable +
// in-flight gate; the store's maybeProactiveConsolidate owns cooldown + pressure
// + candidate selection (the store stays DB-free / commit-guards-free). Two
// load-bearing contracts under test:
//   1. fire-and-forget — the helper returns synchronously; the maybe-* call
//      runs on its own microtask and its rejection is swallowed so a proactive
//      failure NEVER breaks the write path.
//   2. in-flight reuse — when disabled OR when consolidation is already in
//      flight, the helper is a no-op (it never even schedules the maybe-* call).

describe("fireProactiveIfReady", () => {
  /** Settle the fire-and-forget microtask (Task 4 brief's settle helper). */
  const microtick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test("fires fire-and-forget when enabled + not in-flight", async () => {
    let called = 0;
    const store = { maybeProactiveConsolidate: async () => { called++; return null; } };
    fireProactiveIfReady(store as any, "memory", { enabled: true, inFlight: () => false });
    await microtick(); // settle the fire-and-forget microtask
    expect(called).toBe(1);
  });

  test("is a no-op when disabled or in-flight", async () => {
    let called = 0;
    const store = { maybeProactiveConsolidate: async () => { called++; return null; } };
    fireProactiveIfReady(store as any, "memory", { enabled: false, inFlight: () => false });
    fireProactiveIfReady(store as any, "memory", { enabled: true, inFlight: () => true });
    await microtick();
    expect(called).toBe(0);
  });

  test("swallows a rejecting maybeProactiveConsolidate (write path never breaks)", async () => {
    const store = { maybeProactiveConsolidate: async () => { throw new Error("boom"); } };
    expect(() => fireProactiveIfReady(store as any, "memory", { enabled: true, inFlight: () => false })).not.toThrow();
    await microtick(); // the rejected promise is swallowed, no unhandled rejection
  });
});
