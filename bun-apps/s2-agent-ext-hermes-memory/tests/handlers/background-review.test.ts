import { describe, it, beforeEach } from "bun:test";
import assert from "node:assert";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "@repo/s2-agent-core-runtime";
import {
  buildDirectReviewUserPrompt,
  setupBackgroundReview,
} from "../../src/handlers/background-review.js";
import type { DirectReviewResult } from "../../src/handlers/review-memory-ops.js";

// ─── Mock infrastructure ───

/** Minimal memory-tool def threaded verbatim through `extensionTools`. */
const memoryToolDef: ToolDefinition = {
  name: "memory",
  label: "Memory",
  description: "test memory tool",
  parameters: {} as never,
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
} as ToolDefinition;

let handlers: Record<string, Function[]>;
let spawnCalls: SpawnSubagentOptions[];
let directCalls: any[];
let notifyCalls: any[];

interface FakeSpawnOverrides extends Partial<SpawnSubagentResult> {
  delayMs?: number;
  throwErr?: string;
}

/** Fake spawn that records opts and returns a synthesized result. */
function createFakeSpawn(overrides: FakeSpawnOverrides = {}) {
  const result: SpawnSubagentResult = {
    output: overrides.output ?? "Saved memory",
    ...(overrides.failure ? { failure: overrides.failure } : {}),
  };
  const spawn = async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
    spawnCalls.push(opts);
    if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs));
    if (overrides.throwErr) throw new Error(overrides.throwErr);
    return result;
  };
  return spawn as typeof import("@repo/s2-agent-core-runtime").spawnSubagent;
}

function createMockPi() {
  return {
    on: (event: string, handler: Function) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as any;
}

function makeBranch(numMessages: number) {
  return Array.from({ length: numMessages }, (_, i) => ({
    type: "message",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Message number ${i} with some real content here` }],
      timestamp: i,
    },
  }));
}

function makeCtx(branch: any[] = [], overrides: Record<string, any> = {}) {
  return {
    sessionManager: { getBranch: () => branch },
    signal: undefined as any,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
    ...overrides,
  };
}

const defaultConfig = {
  reviewEnabled: true,
  reviewTransport: "subprocess" as const,
  nudgeInterval: 10,
  reviewRecentMessages: 0,
  flushMinTurns: 6,
  flushRecentMessages: 0,
  flushOnCompact: true,
  flushOnShutdown: true,
  memoryCharLimit: 5000,
  userCharLimit: 5000,
  projectCharLimit: 5000,
  autoConsolidate: true,
  correctionDetection: true,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: 7,
  failureInjectionMaxEntries: 5,
  nudgeToolCalls: 15,
};

const mockStore = {
  getMemoryEntries: () => ["existing memory entry"],
  getUserEntries: () => ["existing user entry"],
} as any;

function fireMessageEnd(role: string) {
  const h = handlers["message_end"];
  if (!h) throw new Error("No message_end handler registered");
  for (const fn of h) {
    fn({ message: { role, content: [{ type: "text", text: "hi" }] } }, makeCtx());
  }
}

function fireTurnEnd(branch: any[] = makeBranch(10), ctxOverrides: Record<string, any> = {}) {
  const h = handlers["turn_end"];
  if (!h) throw new Error("No turn_end handler registered");
  const ctx = makeCtx(branch, ctxOverrides);
  // Extract the last assistant message from the branch to pass as event.message
  // (the handler reads tool calls from event.message, not from the branch)
  let assistantMessage = undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.message?.role === "assistant") {
      assistantMessage = branch[i].message;
      break;
    }
  }
  const event = assistantMessage ? { message: assistantMessage } : {};
  for (const fn of h) {
    fn(event, ctx);
  }
  return ctx;
}

// Allow async handlers to settle
async function settle(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/** The spawn task for the review at the given call index. */
function reviewTask(index = spawnCalls.length - 1): string {
  return spawnCalls[index]!.task ?? "";
}

// ─── Tests ───

describe("setupBackgroundReview", () => {
  beforeEach(() => {
    handlers = {};
    spawnCalls = [];
    directCalls = [];
    notifyCalls = [];
  });

  /** Subprocess-transport setup with the memory tool + a fake spawn bridged in. */
  function setupWithSpawn(
    pi: ReturnType<typeof createMockPi>,
    config = defaultConfig,
    spawn: ReturnType<typeof createFakeSpawn> = createFakeSpawn(),
  ) {
    setupBackgroundReview(pi, mockStore, null, config, {
      deps: { memoryToolDef, spawn },
    });
    return spawn;
  }

  function setupWithDirectDeps(
    pi: ReturnType<typeof createMockPi>,
    directResult: DirectReviewResult,
    config = { ...defaultConfig, reviewTransport: "direct" as const },
    spawn: ReturnType<typeof createFakeSpawn> = createFakeSpawn(),
  ) {
    setupBackgroundReview(pi, mockStore, null, config, {
      deps: {
        runDirectReview: async (...args: any[]) => {
          directCalls.push(args);
          return directResult;
        },
        memoryToolDef,
        spawn,
      },
    });
    return spawn;
  }

  it("increments user turn count on message_end for user messages", () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Verify by checking that 3 user turns is enough to allow review
    // (userTurnCount >= 3 check passes after 3 user message_end events)
    // Fire 10 turn_end events — should trigger review since userTurnCount is 3
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }

    // spawn should have been called since we have 3 user turns and 10 turn_end events
    assert.ok(spawnCalls.length > 0, "spawn should be called with 3 user turns and 10 turn_end events");
  });

  it("triggers review at nudgeInterval (10) turns", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    // Register 3 user messages first
    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 9 turn_end events — not enough
    for (let i = 0; i < 9; i++) {
      fireTurnEnd();
    }
    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called at 9 turns");

    // 10th turn_end triggers review
    fireTurnEnd();
    await settle();

    assert.strictEqual(spawnCalls.length, 1, "spawn should be called once at turn 10");
    // Verify the spawn dispatch contract for the fallback reviewer
    const opts = spawnCalls[0]!;
    assert.strictEqual(opts.tier, "small", "should run on the small tier");
    assert.deepStrictEqual(opts.tools, ["memory"], "should allowlist only the memory tool");
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef], "should bridge the parent memory tool def");
    assert.strictEqual(opts.timeoutMs, 120000);
    const task = opts.task ?? "";
    // The task carries COMBINED_REVIEW_PROMPT guidance (incl. the skill guard
    // and the "Nothing to save." convention) plus the conversation snapshot.
    assert.match(task, /Do NOT create or modify skills in this background review/i);
    assert.ok(task.includes("existing memory entry"), "task should include current memory context");
  });

  it("honors llmModelOverride by passing model (and no tier) to spawn", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi, {
      ...defaultConfig,
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      llmThinkingOverride: "minimal",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 1);
    const opts = spawnCalls[0]!;
    // llmModelOverride threads through as `model`; tier is omitted so the
    // runner uses the explicit model instead of a tier resolution.
    assert.strictEqual(opts.model, "openrouter/deepseek/deepseek-v4-flash");
    assert.strictEqual(opts.tier, undefined, "should NOT set tier when an override is present");
    assert.deepStrictEqual(opts.tools, ["memory"]);
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef]);
    assert.strictEqual(opts.retryOnTransient, true);
    // llmThinkingOverride has no spawnSubagent equivalent — it stays inert.
  });

  it("falls back to tier:'small' (and no model) when llmModelOverride is unset", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 1);
    const opts = spawnCalls[0]!;
    assert.strictEqual(opts.tier, "small");
    assert.strictEqual(opts.model, undefined, "should NOT set model when no override is present");
    assert.deepStrictEqual(opts.tools, ["memory"]);
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef]);
    assert.strictEqual(opts.retryOnTransient, true);
  });

  it("caps the fallback reviewer with the recon envelope (escape hatch honored)", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 1);
    const opts = spawnCalls[0]!;
    // roleAwareDefaults({}, "recon") threads the recon bounds into the spawn
    // opts (the fallback reviewer previously ran envelope-less).
    assert.strictEqual(opts.tokenBudget, 120_000, "recon tokenBudget cap");
    assert.strictEqual(opts.maxTurns, 12, "recon maxTurns cap");
    // The deliberate 120s wall-clock stays (tighter than the envelope's 5min).
    assert.strictEqual(opts.timeoutMs, 120000);

    // SUBAGENT_TOKEN_BUDGET_DISABLE=1 → envelope absent (env read at call time).
    // Reset shared harness state between scenarios (sibling tests do the same).
    handlers = {};
    spawnCalls = [];
    notifyCalls = [];
    const saved = process.env.SUBAGENT_TOKEN_BUDGET_DISABLE;
    process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
    try {
      const escapePi = createMockPi();
      setupWithSpawn(escapePi);

      fireMessageEnd("user");
      fireMessageEnd("user");
      fireMessageEnd("user");

      for (let i = 0; i < 10; i++) {
        fireTurnEnd();
      }
      await settle();

      assert.strictEqual(spawnCalls.length, 1);
      const escapeOpts = spawnCalls[0]!;
      assert.strictEqual(escapeOpts.tokenBudget, undefined, "escape hatch drops tokenBudget");
      assert.strictEqual(escapeOpts.maxTurns, undefined, "escape hatch drops maxTurns");
      assert.strictEqual(escapeOpts.timeoutMs, 120000, "wall-clock stays even under the escape hatch");
    } finally {
      if (saved === undefined) delete process.env.SUBAGENT_TOKEN_BUDGET_DISABLE;
      else process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = saved;
    }
  });

  it("does NOT trigger review when reviewEnabled is false", async () => {
    const config = { ...defaultConfig, reviewEnabled: false };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called when reviewEnabled is false");
  });

  it("does NOT trigger review with fewer than 3 user turns", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    // Only 2 user messages
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called with only 2 user turns");
  });

  it("reviewInProgress guard prevents double-trigger", async () => {
    // Use a slow spawn that never resolves to keep reviewInProgress true
    let resolveSpawn: () => void;
    const slowSpawn = async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
      spawnCalls.push(opts);
      await new Promise<void>((r) => { resolveSpawn = r; });
      return { output: "Saved" };
    };

    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, null, defaultConfig, {
      deps: { memoryToolDef, spawn: slowSpawn as typeof createFakeSpawn },
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 10 turn_end events — first triggers review (slow, won't resolve)
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle(5);

    assert.strictEqual(spawnCalls.length, 1, "spawn should be called once for first trigger");

    // Fire more turn_end events — should be blocked by reviewInProgress
    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle(5);

    assert.strictEqual(spawnCalls.length, 1, "spawn should still only be called once — reviewInProgress guard");

    // Resolve the pending spawn to clean up
    resolveSpawn!();
    await settle();
  });

  it("does NOT trigger for short conversations (< 4 message parts)", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with only 2 message entries (< 4 parts)
    const shortBranch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(shortBranch);
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called for short conversations");
  });

  it("uses the full conversation by default", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await settle();

    const task = reviewTask();
    assert.ok(task.includes("Message number 0"), "default should include older messages");
    assert.ok(task.includes("Message number 9"), "default should include latest messages");
  });

  it("includes captured subagent outputs in the review prompt", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // A real-ish branch: threshold filler + a subagent dispatch and its tool_result.
    const branch = [
      ...makeBranch(6),
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "sa1", name: "subagent", arguments: {} }] } },
      { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sa1", content: "The subagent surfaced a reusable pattern" }] } },
    ];

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branch);
    }
    await settle();

    const task = reviewTask();
    assert.ok(task.includes("The subagent surfaced a reusable pattern"), "review prompt must include the subagent output");
    assert.ok(task.includes("[SUBAGENT]"), "subagent output is labelled with its prefix");
  });

  it("limits background review to recent messages when configured", async () => {
    const config = { ...defaultConfig, reviewRecentMessages: 3 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await settle();

    const task = reviewTask();
    assert.ok(!task.includes("Message number 6"), "window should exclude older messages");
    assert.ok(task.includes("Message number 7"));
    assert.ok(task.includes("Message number 8"));
    assert.ok(task.includes("Message number 9"));
  });

  it("does not use the flush recent-message limit for background review", async () => {
    const config = { ...defaultConfig, flushRecentMessages: 2 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await settle();

    assert.ok(reviewTask().includes("Message number 0"), "flush limit must not affect review");
  });

  it("keeps the short conversation guard based on the full conversation", async () => {
    const config = { ...defaultConfig, reviewRecentMessages: 2 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(4));
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 1, "full conversation has enough parts to review");
    const task = reviewTask();
    assert.ok(!task.includes("Message number 0"));
    assert.ok(!task.includes("Message number 1"));
    assert.ok(task.includes("Message number 2"));
    assert.ok(task.includes("Message number 3"));
  });

  it("resets turn counter after review triggers", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 10 turns — triggers review
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 1, "first review triggered");

    // Fire 10 more turns — should trigger again (counter was reset)
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 2, "second review should trigger after counter reset");
  });

  it("shows notification only when review saves something", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi, defaultConfig, createFakeSpawn({ output: "Saved new memory about user preferences" }));

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    const reviewNotify = notifyCalls.find((n) => n.msg.includes("Memory auto-reviewed"));
    assert.ok(reviewNotify, "should have a 'Memory auto-reviewed' notification");

    // Reset and test "nothing to save" case
    handlers = {};
    spawnCalls = [];
    notifyCalls = [];

    const nothingPi = createMockPi();
    setupWithSpawn(nothingPi, defaultConfig, createFakeSpawn({ output: "Nothing to save." }));

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    const reviewNotify2 = notifyCalls.find((n) => n.msg.includes("Memory auto-reviewed"));
    assert.strictEqual(reviewNotify2, undefined, "no 'Memory auto-reviewed' notification for 'nothing to save'");
  });

  it("does NOT crash agent when spawn throws", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi, defaultConfig, createFakeSpawn({ throwErr: "spawn crashed" }));

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // This should NOT throw
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 1, "spawn was attempted");
    // If we get here without an unhandled rejection, the error was caught
    assert.ok(true, "background review failure was caught silently");
  });

  it("assistant message_end does NOT increment user turn count", async () => {
    const pi = createMockPi();
    setupWithSpawn(pi);

    // Only assistant messages — userTurnCount stays 0
    fireMessageEnd("assistant");
    fireMessageEnd("assistant");
    fireMessageEnd("assistant");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called — no user messages");
  });

  // ─── Tool-call-aware nudge tests (Epic 4) ───

  it("triggers on tool call count threshold even with low turn count", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 5 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with 5 toolCall blocks (meets tool call threshold)
    const branchWithToolCalls = [
      ...makeBranch(4),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
            { type: "toolCall", id: "tc3", name: "edit", arguments: {} },
            { type: "toolCall", id: "tc4", name: "read", arguments: {} },
            { type: "toolCall", id: "tc5", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    // Only 2 turn_end events (below turn threshold of 10)
    fireTurnEnd(branchWithToolCalls);
    fireTurnEnd(branchWithToolCalls);
    await settle();

    assert.ok(spawnCalls.length >= 1, "spawn should be called due to tool call threshold");
  });

  it("triggers when both thresholds are met", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 5 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branchWithToolCalls = [
      ...makeBranch(10),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    // Fire 10 turns (meets turn threshold) with tool calls (meets tool threshold)
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branchWithToolCalls);
    }
    await settle();

    assert.ok(spawnCalls.length >= 1, "spawn should be called when either threshold is met");
  });

  it("resets both counters after review", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branchWithToolCalls = [
      ...makeBranch(6),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
            { type: "toolCall", id: "tc3", name: "edit", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    // Trigger first review via tool calls
    fireTurnEnd(branchWithToolCalls);
    await settle();
    assert.strictEqual(spawnCalls.length, 1, "first review triggered");

    // Trigger second review via turn count
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await settle();
    assert.strictEqual(spawnCalls.length, 2, "second review should trigger after counter reset");
  });

  it("does not trigger when neither threshold is met", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 15 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Only 2 tool calls (below 15 threshold) and 5 turns (below 10 threshold)
    const branchWithFewToolCalls = [
      ...makeBranch(4),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    for (let i = 0; i < 5; i++) {
      fireTurnEnd(branchWithFewToolCalls);
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called when neither threshold met");
  });

  it("ignores text blocks when counting tool calls", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with text-only messages (no toolCall blocks)
    const branchWithTextOnly = [
      ...makeBranch(10),
    ];

    // Fire enough turns but no tool calls
    for (let i = 0; i < 5; i++) {
      fireTurnEnd(branchWithTextOnly);
    }
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called — no toolCall blocks, turn threshold not met");
  });

  it("uses direct review by default and does not call subprocess", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: true, appliedCount: 1 });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(directCalls.length, 1, "direct review should run once");
    assert.strictEqual(spawnCalls.length, 0, "subprocess should not run on successful direct review");
    const reviewNotify = notifyCalls.find((n) => n.msg.includes("Memory auto-reviewed"));
    assert.ok(reviewNotify, "should notify when direct review applies memory");
  });

  it("falls back to subprocess when direct review cannot run", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: false, appliedCount: 0, fallbackReason: "no_model" });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(directCalls.length, 1, "direct review should be attempted first");
    assert.strictEqual(spawnCalls.length, 1, "subprocess should run as fallback");
  });

  it("does not notify when direct review returns no operations", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: true, appliedCount: 0, fallbackReason: "empty" });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    const reviewNotify = notifyCalls.find((n) => n.msg.includes("Memory auto-reviewed"));
    assert.strictEqual(reviewNotify, undefined, "empty direct review should not notify");
    assert.strictEqual(spawnCalls.length, 0, "empty direct review should not fall back");
  });

  it("builds the spawn task from COMBINED_REVIEW_PROMPT + the shared context builder", () => {
    // buildSubprocessReviewPrompt was removed; the spawn task now combines
    // COMBINED_REVIEW_PROMPT with the same context sections buildDirectReviewUserPrompt
    // produces (Memory/User/Project/Conversation). Verify the direct builder is
    // still the shared context source and excludes the review guidance.
    const input = {
      parts: ["[USER] hello", "[ASSISTANT] hi"],
      currentMemory: "uses pnpm",
      currentUser: "likes TypeScript",
      currentProject: "monorepo layout",
    };

    const directPrompt = buildDirectReviewUserPrompt(input);

    assert.match(directPrompt, /Conversation to Review/);
    assert.doesNotMatch(directPrompt, /save using the memory tool/i);
    assert.ok(directPrompt.includes("uses pnpm"));
    assert.ok(directPrompt.includes("monorepo layout"));
  });

  it("falls back gracefully if getBranch throws", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setupWithSpawn(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // getBranch throws — should not crash
    const crashCtx = {
      sessionManager: { getBranch: () => { throw new Error("session expired"); } },
      signal: undefined as any,
      ui: { notify: () => {} },
    };

    const h = handlers["turn_end"];
    // Fire 10 turns with crashing getBranch
    for (let i = 0; i < 10; i++) {
      for (const fn of h) {
        fn({}, crashCtx);
      }
    }
    await settle();

    // Should not throw — we got here = test passed
    assert.ok(true, "no crash when getBranch throws");
  });
});
