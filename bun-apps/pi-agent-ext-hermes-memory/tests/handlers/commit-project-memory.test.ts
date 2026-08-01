/**
 * Unit tests for the project-memory autocommit hook (autocommit-hook effort,
 * tickets 02–05). Two concerns, both injected-seam (no real git):
 *
 *  - runCommitCycle (slice 4): collects repo state via a MOCK GitOps, runs the
 *    pure classifier, then stages ONLY MEMORY.md + commits with the fixed
 *    message. Never-throws on git failure; honors every guard decision.
 *  - setupCommitProjectMemory (slice 5): message_end + ~20s trailing
 *    debounce — one commit per burst; a second burst re-arms. A complete
 *    no-op when the repo hasn't opted in.
 */

import { describe, it, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import {
  setupCommitProjectMemory,
  runCommitCycle,
  type CommitCycleDeps,
} from "../../src/handlers/commit-project-memory.js";
import type { GitOps, MemoryFileStatus } from "../../src/git-ops.js";
import {
  AUTOCOMMIT_COMMIT_MESSAGE,
  DEFAULT_AUTOCOMMIT_DEBOUNCE_MS,
  MEMORY_MERGE_DRIVER_NAME,
} from "../../src/constants.js";
import { buildMergeDriverCommand } from "../../src/git-ops.js";
import type { MemoryConfig } from "../../src/types.js";
import type { CommitDecision } from "../../src/commit-guards.js";

// ─── Mock GitOps ────────────────────────────────────────────────────────────

interface MockGitOverrides {
  gitDir?: string | undefined;
  branch?: string | null;
  midMerge?: boolean;
  indexLocked?: boolean;
  status?: Partial<MemoryFileStatus>;
  stageResult?: boolean;
  commitResult?: boolean;
  configValues?: Record<string, string | undefined>;
  /** make resolveGitDir throw (never-throws contract). */
  throwOnResolve?: boolean;
}

interface MockGitOps {
  ops: GitOps;
  calls: {
    stage: Array<[string, string]>;
    commit: Array<[string, string, string]>;
    getConfig: string[];
    setConfig: Array<[string, string]>;
  };
}

function createMockGitOps(o: MockGitOverrides = {}): MockGitOps {
  const calls = { stage: [] as Array<[string, string]>, commit: [] as Array<[string, string, string]>, getConfig: [] as string[], setConfig: [] as Array<[string, string]> };
  const status: MemoryFileStatus = {
    tracked: true,
    untracked: false,
    ignored: false,
    changedSinceHead: true,
    exists: true,
    ...o.status,
  };
  const ops: GitOps = {
    async resolveGitDir() { if (o.throwOnResolve) throw new Error("git boom"); return o.gitDir ?? "/fake/repo/.git"; },
    async currentBranch() { return o.branch === undefined ? "feature/durable-memory" : o.branch; },
    async isMidMerge() { return o.midMerge ?? false; },
    async isIndexLocked() { return o.indexLocked ?? false; },
    async collectMemoryStatus() { return { ...status }; },
    async stage(cwd, rel) { calls.stage.push([cwd, rel]); return o.stageResult ?? true; },
    async commit(cwd, msg, rel) { calls.commit.push([cwd, msg, rel]); return o.commitResult ?? true; },
    async getConfig(_cwd, key) { calls.getConfig.push(key); return o.configValues?.[key]; },
    async setConfig(_cwd, key, val) { calls.setConfig.push([key, val]); return true; },
  };
  return { ops, calls };
}

function baseDeps(overrides: Partial<CommitCycleDeps> = {}, git: MockGitOps = createMockGitOps()): CommitCycleDeps {
  return {
    gitOps: git.ops,
    cwd: "/fake/repo",
    relPath: ".agents/memory/MEMORY.md",
    optedIn: true,
    projectMemoryDirEnabled: true,
    consolidationInFlight: false,
    fileLockHeld: false,
    commitMessage: AUTOCOMMIT_COMMIT_MESSAGE,
    ...overrides,
  };
}

// ─── Mock pi + fake debounce timers ─────────────────────────────────────────

function createMockPi() {
  const handlers: Record<string, Function[]> = {};
  const pi = {
    on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
  };
  return { pi: pi as any, handlers };
}

interface FakeTimers {
  schedule: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  flush: () => void;
  pendingCount: () => number;
  lastDelay: () => number;
}

function createFakeTimers(): FakeTimers {
  let cb: (() => void) | null = null;
  let delay = -1;
  return {
    schedule: (fn, ms) => { cb = fn; delay = ms; return 1; },
    clear: () => { cb = null; },
    flush: () => { const f = cb; cb = null; if (f) f(); },
    pendingCount: () => (cb ? 1 : 0),
    lastDelay: () => delay,
  };
}

async function emit(handlers: Record<string, Function[]>, event: string, evt: any = {}, ctx: any = {}): Promise<void> {
  for (const h of (handlers[event] ?? [])) await h(evt, ctx);
}

function autocommitConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    memoryMode: "policy-only", memoryCharLimit: 5000, userCharLimit: 5000, projectCharLimit: 5000,
    nudgeInterval: 10, reviewEnabled: true, flushOnCompact: true, flushOnShutdown: true, flushMinTurns: 6,
    autoConsolidate: true, correctionDetection: true, failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7, failureInjectionMaxEntries: 5, nudgeToolCalls: 15,
    autoCommitProjectMemory: true,
    ...overrides,
  } as MemoryConfig;
}

// ─── Slice 4: commit path (runCommitCycle) ──────────────────────────────────

describe("runCommitCycle (commit path, ticket 03/04)", () => {
  it("stages ONLY MEMORY.md and commits with the fixed message when all guards clear", async () => {
    const git = createMockGitOps();
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "commit");
    assert.deepStrictEqual(git.calls.stage, [["/fake/repo", ".agents/memory/MEMORY.md"]], "stages the explicit MEMORY.md path only");
    assert.deepStrictEqual(git.calls.commit, [["/fake/repo", AUTOCOMMIT_COMMIT_MESSAGE, ".agents/memory/MEMORY.md"]], "commits with the fixed message + pathspec");
  });

  it("does NOT stage or commit when not opted in", async () => {
    const git = createMockGitOps();
    const decision = await runCommitCycle(baseDeps({ optedIn: false }, git));
    assert.strictEqual(decision, "skip");
    assert.strictEqual(git.calls.stage.length, 0);
    assert.strictEqual(git.calls.commit.length, 0);
  });

  it("suppresses on a protected branch (no stage/commit)", async () => {
    const git = createMockGitOps({ branch: "main" });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "suppress");
    assert.strictEqual(git.calls.stage.length, 0);
    assert.strictEqual(git.calls.commit.length, 0);
  });

  it("skips mid merge (no stage/commit)", async () => {
    const git = createMockGitOps({ midMerge: true });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "skip");
    assert.strictEqual(git.calls.commit.length, 0);
  });

  it("defers when the git index is locked (re-arm next message_end)", async () => {
    const git = createMockGitOps({ indexLocked: true });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "defer");
    assert.strictEqual(git.calls.commit.length, 0);
  });

  it("defers while consolidation is in flight", async () => {
    const git = createMockGitOps();
    const decision = await runCommitCycle(baseDeps({ consolidationInFlight: true }, git));
    assert.strictEqual(decision, "defer");
  });

  it("skips when MEMORY.md is unchanged since HEAD (changed-gate)", async () => {
    const git = createMockGitOps({ status: { changedSinceHead: false } });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "skip");
    assert.strictEqual(git.calls.commit.length, 0);
  });

  it("skips a gitignored MEMORY.md (never force-adds an explicit exclude)", async () => {
    const git = createMockGitOps({ status: { tracked: false, untracked: true, ignored: true } });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "skip");
    assert.strictEqual(git.calls.stage.length, 0);
  });

  it("auto-tracks an untracked MEMORY.md (stage + commit)", async () => {
    const git = createMockGitOps({ status: { tracked: false, untracked: true, ignored: false, changedSinceHead: false } });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "commit", "untracked → auto-track → commit");
    assert.strictEqual(git.calls.stage.length, 1);
    assert.strictEqual(git.calls.commit.length, 1);
  });

  it("defers when staging fails (stage returns false)", async () => {
    const git = createMockGitOps({ stageResult: false });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "defer");
    assert.strictEqual(git.calls.commit.length, 0, "no commit when stage failed");
  });

  it("defers when the commit fails (commit returns false)", async () => {
    const git = createMockGitOps({ commitResult: false });
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "defer");
    assert.strictEqual(git.calls.stage.length, 1, "stage still attempted");
  });

  it("NEVER throws — a throwing GitOps resolves to defer", async () => {
    const git = createMockGitOps({ throwOnResolve: true });
    // runCommitCycle must not reject even when git ops throw.
    const decision = await runCommitCycle(baseDeps({}, git));
    assert.strictEqual(decision, "defer");
  });

  it("self-configures the §-union merge driver on commit (idempotent when already set)", async () => {
    // Already configured with the EXACT expected command → no setConfig writes.
    const configured = createMockGitOps({
      configValues: { [`merge.${MEMORY_MERGE_DRIVER_NAME}.driver`]: buildMergeDriverCommand() },
    });
    await runCommitCycle(baseDeps({}, configured));
    assert.strictEqual(configured.calls.setConfig.length, 0, "do not rewrite an already-configured driver");

    // Not configured → sets name + driver.
    const fresh = createMockGitOps({ configValues: {} });
    await runCommitCycle(baseDeps({}, fresh));
    const keys = fresh.calls.setConfig.map(([k]) => k);
    assert.ok(keys.includes(`merge.${MEMORY_MERGE_DRIVER_NAME}.name`), "sets the driver name");
    assert.ok(keys.includes(`merge.${MEMORY_MERGE_DRIVER_NAME}.driver`), "sets the driver command");
    const driverCmd = fresh.calls.setConfig.find(([k]) => k === `merge.${MEMORY_MERGE_DRIVER_NAME}.driver`)?.[1] ?? "";
    assert.match(driverCmd, /pi-memory-merge/, "driver command points at the merge script");
    assert.ok(driverCmd.includes("%O") && driverCmd.includes("%A") && driverCmd.includes("%B"), "passes git's %O %A %B placeholders");
  });
});

// ─── Slice 5: debounce / re-arm (setupCommitProjectMemory) ───────────────────

describe("setupCommitProjectMemory (debounce, ticket 02)", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("is a COMPLETE no-op when the repo hasn't opted in (no message_end handler registered)", () => {
    setupCommitProjectMemory(mockPi.pi, autocommitConfig({ autoCommitProjectMemory: false }), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
    });
    // No message_end handler → the feature is invisible to non-opted-in repos.
    assert.strictEqual((mockPi.handlers["message_end"] ?? []).length, 0);
  });

  it("is a no-op when projectMemoryDir===null (memory is global; nothing to commit)", () => {
    setupCommitProjectMemory(mockPi.pi, autocommitConfig({ projectMemoryDir: null }), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
    });
    assert.strictEqual((mockPi.handlers["message_end"] ?? []).length, 0);
  });

  it("coalesces a burst of message_end into ONE commit (~20s trailing debounce)", async () => {
    const timers = createFakeTimers();
    let cycleCalls = 0;
    setupCommitProjectMemory(mockPi.pi, autocommitConfig(), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      runCycle: async () => { cycleCalls++; return "commit"; },
    });

    // A burst of 5 message_ends re-arms the same timer; only one is pending.
    for (let i = 0; i < 5; i++) await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    assert.strictEqual(timers.pendingCount(), 1, "one pending timer after a burst");
    assert.strictEqual(cycleCalls, 0, "commit NOT fired mid-burst");

    timers.flush();
    assert.strictEqual(cycleCalls, 1, "exactly one commit when the debounce fires");
    assert.strictEqual(timers.pendingCount(), 0);
  });

  it("uses the default ~20s debounce window", async () => {
    const timers = createFakeTimers();
    setupCommitProjectMemory(mockPi.pi, autocommitConfig(), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      runCycle: async () => "commit",
    });
    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    assert.strictEqual(timers.lastDelay(), DEFAULT_AUTOCOMMIT_DEBOUNCE_MS);
  });

  it("a second burst re-arms the debounce (fires again)", async () => {
    const timers = createFakeTimers();
    let cycleCalls = 0;
    setupCommitProjectMemory(mockPi.pi, autocommitConfig(), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      runCycle: async () => { cycleCalls++; return "commit"; },
    });

    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    timers.flush();
    assert.strictEqual(cycleCalls, 1);

    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    assert.strictEqual(timers.pendingCount(), 1, "second burst re-arms");
    timers.flush();
    assert.strictEqual(cycleCalls, 2, "second commit fires");
  });

  it("re-arming clears the previous pending timer (debounce, not accumulator)", async () => {
    const timers = createFakeTimers();
    let clears = 0;
    const wrappedClear = (h: unknown) => { clears++; timers.clear(h); };
    setupCommitProjectMemory(mockPi.pi, autocommitConfig(), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
      scheduleTimer: timers.schedule,
      clearTimer: wrappedClear,
      runCycle: async () => "commit",
    });

    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    assert.ok(clears >= 2, "each re-arm clears the prior timer");
    assert.strictEqual(timers.pendingCount(), 1);
  });

  it("a defer decision re-arms the debounce (transient contention retries next cycle)", async () => {
    const timers = createFakeTimers();
    const decisions: CommitDecision[] = ["defer", "commit"];
    let i = 0;
    setupCommitProjectMemory(mockPi.pi, autocommitConfig(), {
      cwd: "/fake/repo",
      memoryFilePath: "/fake/repo/.agents/memory/MEMORY.md",
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      runCycle: async () => decisions[i++] ?? "commit",
    });

    await emit(mockPi.handlers, "message_end", { message: { role: "assistant" } });
    timers.flush();
    // The defer re-arm lands in the runCycle().then() microtask — let it settle.
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(timers.pendingCount(), 1, "a defer re-arms one more debounce tick");
  });
});
