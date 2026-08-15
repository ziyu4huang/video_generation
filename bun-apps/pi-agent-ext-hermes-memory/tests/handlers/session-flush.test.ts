/**
 * Unit tests for session flush — the compact/shutdown memory-save path.
 *
 * Flush dispatches through the shared `spawnSubagent` runner. `memoryToolDef` +
 * an injectable `spawn` are the seams: production omits `spawn` (→ real
 * spawnSubagent) and passes the parent memory tool def captured in src/index.ts;
 * tests pass a fake that records call opts and returns a synthesized result.
 */

import { describe, it, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "@repo/pi-agent-ext-subagent";
import { setupSessionFlush } from "../../src/handlers/session-flush.js";
import { FLUSH_PROMPT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Mock infrastructure ────────────────────────────────────────────────────

/** Minimal memory-tool def — only identity matters: it is threaded verbatim
 *  through `extensionTools` so we can assert reference equality. */
const memoryToolDef: ToolDefinition = {
  name: "memory",
  label: "Memory",
  description: "test memory tool",
  parameters: {} as never,
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
} as ToolDefinition;

interface FakeSpawnOverrides extends Partial<SpawnSubagentResult> {
  throwErr?: string;
}

function createFakeSpawn(overrides: FakeSpawnOverrides = {}) {
  const calls: SpawnSubagentOptions[] = [];
  const result: SpawnSubagentResult = {
    output: overrides.output ?? "",
    ...(overrides.failure ? { failure: overrides.failure } : {}),
  };
  const spawn = async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
    calls.push(opts);
    if (overrides.throwErr) throw new Error(overrides.throwErr);
    return result;
  };
  return { spawn: spawn as typeof import("@repo/pi-agent-ext-subagent").spawnSubagent, calls };
}

/** Event-name → handler[] registry built by mock pi.on() */
function createMockPi() {
  const handlers: Record<string, Function[]> = {};
  const pi = {
    on(event: string, handler: Function) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    registerTool() {},
    registerCommand() {},
  };
  return { pi: pi as any, handlers };
}

/** Build N messages alternating user/assistant */
function mockBranch(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "message",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `msg ${i}` }],
      timestamp: i,
    },
  }));
}

function defaultConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewRecentMessages: 0,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    flushRecentMessages: 0,
    autoConsolidate: true,
    correctionDetection: true,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    ...overrides,
  };
}

/** Emit message_end N times (simulates user turns) */
async function emitUserTurns(handlers: Record<string, Function[]>, count: number) {
  const hs = handlers["message_end"] || [];
  for (let i = 0; i < count; i++) {
    for (const h of hs) {
      await h({ message: { role: "user" } }, {});
    }
  }
}

/** Emit a single event with optional ctx */
async function emit(
  handlers: Record<string, Function[]>,
  event: string,
  eventObj: any = {},
  ctx: any = {},
) {
  const hs = handlers[event] || [];
  for (const h of hs) {
    await h(eventObj, ctx);
  }
}

const mockStore = { getMemoryEntries: () => [], getUserEntries: () => [] } as any;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("setupSessionFlush", () => {
  let mockPi: ReturnType<typeof createMockPi>;
  let fake: ReturnType<typeof createFakeSpawn>;

  beforeEach(() => {
    mockPi = createMockPi();
    fake = createFakeSpawn();
  });

  // ── Compact flush ───────────────────────────────────────────────────

  it("session_before_compact triggers flush when flushOnCompact is true", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(fake.calls.length, 1, "spawn should be called once");
  });

  it("session_before_compact does NOT trigger when flushOnCompact is false", async () => {
    const config = defaultConfig({ flushOnCompact: false });
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(fake.calls.length, 0, "spawn should NOT be called");
  });

  // ── Shutdown flush ──────────────────────────────────────────────────

  it("session_shutdown triggers flush when flushOnShutdown is true", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_shutdown", {}, ctx);

    // Shutdown flush is fire-and-forget — wait for the microtask queue to settle
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.calls.length, 1, "spawn should be called once");
  });

  it("session_shutdown does NOT trigger when flushOnShutdown is false", async () => {
    const config = defaultConfig({ flushOnShutdown: false });
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_shutdown", {}, ctx);

    assert.equal(fake.calls.length, 0, "spawn should NOT be called");
  });

  // ── Minimum turns gate ──────────────────────────────────────────────

  it("Flush skips if userTurnCount < flushMinTurns", async () => {
    const config = defaultConfig({ flushMinTurns: 6 });
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    // Only 3 user turns — below threshold
    await emitUserTurns(mockPi.handlers, 3);

    const ctx = { sessionManager: { getBranch: () => mockBranch(3) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(fake.calls.length, 0, "spawn should NOT be called with too few turns");
  });

  // ── getBranch usage ─────────────────────────────────────────────────

  it("Flush builds conversation from sessionManager.getBranch()", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    let branchCalled = false;
    const ctx = {
      sessionManager: {
        getBranch: () => {
          branchCalled = true;
          return mockBranch(8);
        },
      },
    };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.ok(branchCalled, "getBranch should be called");
    assert.equal(fake.calls.length, 1);
  });

  // ── Spawn options verification ──────────────────────────────────────

  it("Flush dispatches via spawn with the memory tool bridged in", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const branch = mockBranch(4);
    const ctx = { sessionManager: { getBranch: () => branch } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(fake.calls.length, 1);
    const opts = fake.calls[0]!;
    assert.strictEqual(opts.tier, "small", "should run on the small tier");
    assert.strictEqual(opts.model, undefined, "should NOT set model when no override is present");
    assert.deepStrictEqual(opts.tools, ["memory"], "should allowlist only the memory tool");
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef], "should bridge the parent memory tool def");
    assert.strictEqual(opts.retryOnTransient, false, "shutdown/flush path should not retry");
    assert.strictEqual(opts.timeoutMs, 30000, "compact flush should use the 30s timeout");

    // The task is the flush message: FLUSH_PROMPT + conversation snapshot.
    const task = opts.task ?? "";
    assert.ok(task.includes(FLUSH_PROMPT), "task should contain FLUSH_PROMPT");
    assert.ok(task.includes("[USER]"), "task should contain [USER] prefix");
    assert.ok(task.includes("[ASSISTANT]"), "task should contain [ASSISTANT] prefix");
    assert.ok(task.includes("msg 0"), "task should contain conversation text");
    assert.match(opts.instructions ?? "", /save memories before context is lost/i);
  });

  it("honors llmModelOverride by passing model (and no tier) to spawn", async () => {
    const config = defaultConfig({ llmModelOverride: "anthropic/claude-opus-4" });
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const branch = mockBranch(4);
    const ctx = { sessionManager: { getBranch: () => branch } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(fake.calls.length, 1);
    const opts = fake.calls[0]!;
    assert.strictEqual(opts.model, "anthropic/claude-opus-4", "should thread the override as model");
    assert.strictEqual(opts.tier, undefined, "should NOT set tier when an override is present");
    // Everything else stays byte-identical to the unset path.
    assert.deepStrictEqual(opts.tools, ["memory"]);
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef]);
    assert.strictEqual(opts.retryOnTransient, false);
    assert.strictEqual(opts.timeoutMs, 30000);
  });

  it("shutdown flush uses the short 10s timeout", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_shutdown", {}, ctx);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0]!.timeoutMs, 10000, "shutdown flush should cap at 10s");
  });

  it("Flush includes the full conversation by default", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const task = fake.calls[0]!.task ?? "";
    assert.ok(task.includes("msg 0"), "default should include older messages");
    assert.ok(task.includes("msg 7"), "default should include latest messages");
  });

  it("Flush limits conversation to recent messages when configured", async () => {
    const config = defaultConfig({ flushRecentMessages: 3 });
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const task = fake.calls[0]!.task ?? "";
    assert.ok(!task.includes("msg 4"), "window should exclude older messages");
    assert.ok(task.includes("msg 5"));
    assert.ok(task.includes("msg 6"));
    assert.ok(task.includes("msg 7"));
  });

  it("Flush does not use the review recent-message limit", async () => {
    const config = defaultConfig({ reviewRecentMessages: 2 });
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const task = fake.calls[0]!.task ?? "";
    assert.ok(task.includes("msg 0"), "review limit must not affect flush");
  });

  // ── Error resilience ────────────────────────────────────────────────

  it("Flush failure does NOT prevent compaction", async () => {
    const failing = createFakeSpawn({ throwErr: "spawn failed" });
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, failing.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    // Should not throw — error is swallowed for best-effort flush
    await assert.doesNotReject(async () => {
      await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);
    });
  });

  it("Flush failure does NOT prevent shutdown", async () => {
    const failing = createFakeSpawn({ throwErr: "spawn failed" });
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, failing.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    await assert.doesNotReject(async () => {
      await emit(mockPi.handlers, "session_shutdown", {}, ctx);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it("Handles empty branch (no messages)", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => [] } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    // spawn is still called (flush task just has no conversation lines)
    assert.equal(fake.calls.length, 1);

    const task = fake.calls[0]!.task ?? "";
    assert.ok(task.includes(FLUSH_PROMPT));
    // No [USER]/[ASSISTANT] prefixes in empty conversation
    assert.ok(!task.includes("[USER]"), "empty branch should have no [USER]");
  });

  it("Concurrent compact + shutdown both flush", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    // Fire both events
    await Promise.all([
      emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx),
      emit(mockPi.handlers, "session_shutdown", {}, ctx),
    ]);

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.calls.length, 2, "both events should trigger flush");
  });

  it("Forwards the host signal from compact event as externalSignal", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config, memoryToolDef, fake.spawn);

    await emitUserTurns(mockPi.handlers, 8);

    const abortController = new AbortController();
    const signal = abortController.signal;
    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    await emit(mockPi.handlers, "session_before_compact", { signal }, ctx);

    assert.equal(fake.calls.length, 1);
    assert.strictEqual(
      fake.calls[0]!.externalSignal,
      signal,
      "compact signal should be forwarded as externalSignal",
    );
  });
});
