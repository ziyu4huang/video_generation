/**
 * Unit tests for correction detection — isCorrection() pattern matching
 * and handler behavior (rate limiting, spawn trigger).
 *
 * The correction-save dispatches through the shared `spawnSubagent` runner.
 * `memoryToolDef` + an injectable `spawn` are the seams threaded into
 * setupCorrectionDetector; tests pass a fake spawn that records call opts.
 */

import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "@repo/pi-agent-ext-subagent";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { createCardStore } from "../../src/store/card-store.js";
import type { CardStore } from "../../src/store/card-store.js";
import type { MemoryRepository } from "../../src/store/repository.js";
import { isCorrection, setupCorrectionDetector } from "../../src/handlers/correction-detector.js";

// ─── Pattern matching tests ───

describe("isCorrection", () => {
  // ── Strong patterns (always trigger) ──

  describe("strong patterns (always trigger)", () => {
    it("matches 'don't do that'", () => {
      assert.strictEqual(isCorrection("don't do that"), true);
    });

    it("matches 'not like that'", () => {
      assert.strictEqual(isCorrection("not like that"), true);
    });

    it("matches 'I said use yarn'", () => {
      assert.strictEqual(isCorrection("I said use yarn"), true);
    });

    it("matches 'I told you already'", () => {
      assert.strictEqual(isCorrection("I told you already"), true);
    });

    it("matches 'we already discussed this'", () => {
      assert.strictEqual(isCorrection("we already discussed this"), true);
    });

    it("matches 'please don't commit yet'", () => {
      assert.strictEqual(isCorrection("please don't commit yet"), true);
    });

    it("matches \"that's not what I asked for\"", () => {
      assert.strictEqual(isCorrection("that's not what I asked for"), true);
    });
  });

  // ── Weak patterns (need directive clause) ──

  describe("weak patterns (need directive clause)", () => {
    it("matches 'no, use yarn instead' (has directive 'use')", () => {
      assert.strictEqual(isCorrection("no, use yarn instead"), true);
    });

    it("matches 'wrong, the file is in src/' (has directive 'the')", () => {
      assert.strictEqual(isCorrection("wrong, the file is in src/"), true);
    });

    it("matches 'actually, don't use that' (has directive 'don't')", () => {
      assert.strictEqual(isCorrection("actually, don't use that"), true);
    });

    it("matches 'stop, fix the test first' (has directive 'fix')", () => {
      assert.strictEqual(isCorrection("stop, fix the test first"), true);
    });

    it("matches 'no! delete that file' (has directive 'delete')", () => {
      assert.strictEqual(isCorrection("no! delete that file"), true);
    });

    it("does NOT match 'no just kidding' (no directive clause)", () => {
      assert.strictEqual(isCorrection("no just kidding"), false);
    });
  });

  // ── Negative patterns (suppress even if positive matches) ──

  describe("negative patterns (suppress false positives)", () => {
    it("suppresses 'no worries, I'll handle it'", () => {
      assert.strictEqual(isCorrection("no worries, I'll handle it"), false);
    });

    it("suppresses 'no problem'", () => {
      assert.strictEqual(isCorrection("no problem"), false);
    });

    it("suppresses 'no thanks'", () => {
      assert.strictEqual(isCorrection("no thanks"), false);
    });

    it("suppresses 'no need to change that'", () => {
      assert.strictEqual(isCorrection("no need to change that"), false);
    });

    it("suppresses 'actually, that looks great'", () => {
      assert.strictEqual(isCorrection("actually, that looks great"), false);
    });

    it("suppresses 'actually, perfect'", () => {
      assert.strictEqual(isCorrection("actually, perfect"), false);
    });

    it("suppresses 'actually, that's correct'", () => {
      assert.strictEqual(isCorrection("actually, that's correct"), false);
    });

    it("suppresses 'stop there'", () => {
      assert.strictEqual(isCorrection("stop there"), false);
    });

    it("suppresses 'stop here'", () => {
      assert.strictEqual(isCorrection("stop here"), false);
    });

    it("suppresses 'stop for now'", () => {
      assert.strictEqual(isCorrection("stop for now"), false);
    });
  });

  // ── Non-corrections (should NOT trigger) ──

  describe("non-corrections (should NOT trigger)", () => {
    it("does NOT match 'yes, do that'", () => {
      assert.strictEqual(isCorrection("yes, do that"), false);
    });

    it("does NOT match 'looks good'", () => {
      assert.strictEqual(isCorrection("looks good"), false);
    });

    it("does NOT match 'can you also check the tests?'", () => {
      assert.strictEqual(isCorrection("can you also check the tests?"), false);
    });

    it("does NOT match empty string", () => {
      assert.strictEqual(isCorrection(""), false);
    });

    it("does NOT match 'thanks'", () => {
      assert.strictEqual(isCorrection("thanks"), false);
    });

    it("does NOT match 'great, that works'", () => {
      assert.strictEqual(isCorrection("great, that works"), false);
    });

    it("does NOT match 'please continue'", () => {
      assert.strictEqual(isCorrection("please continue"), false);
    });
  });

  // ── Case insensitivity ──

  describe("case insensitivity", () => {
    it("matches 'DON'T DO THAT' (uppercase)", () => {
      assert.strictEqual(isCorrection("DON'T DO THAT"), true);
    });

    it("matches 'I Told You Already' (mixed case)", () => {
      assert.strictEqual(isCorrection("I Told You Already"), true);
    });

    it("suppresses 'No Worries' (uppercase negative)", () => {
      assert.strictEqual(isCorrection("No Worries"), false);
    });
  });

  describe("custom pattern config", () => {
    it("matches custom strong patterns", () => {
      assert.strictEqual(
        isCorrection("custom correction", { correctionStrongPatterns: ["^custom correction$"] }),
        true,
      );
    });

    it("uses custom negative patterns to suppress matches", () => {
      assert.strictEqual(
        isCorrection("custom correction", {
          correctionStrongPatterns: ["^custom"],
          correctionNegativePatterns: ["^custom correction$"],
        }),
        false,
      );
    });

    it("uses custom directive words for weak patterns", () => {
      assert.strictEqual(
        isCorrection("no, shipit now", { correctionDirectiveWords: ["shipit"] }),
        true,
      );
      assert.strictEqual(
        isCorrection("no, use yarn", { correctionDirectiveWords: ["shipit"] }),
        false,
      );
    });

    it("ignores invalid custom regex entries and keeps valid entries", () => {
      assert.strictEqual(
        isCorrection("custom correction", { correctionStrongPatterns: ["bad(", "^custom"] }),
        true,
      );
    });

    it("treats explicit empty or all-invalid pattern arrays as empty", () => {
      assert.strictEqual(
        isCorrection("don't do that", { correctionStrongPatterns: [] }),
        false,
      );
      assert.strictEqual(
        isCorrection("don't do that", { correctionStrongPatterns: ["bad("] }),
        false,
      );
    });
  });
});

// ─── Handler behavior tests ───

describe("setupCorrectionDetector handler", () => {
  let handlers: Record<string, Function[]>;
  let spawnCalls: SpawnSubagentOptions[];
  let notifyCalls: any[];
  let tmpDir: string;
  let backend: SqliteBackend;
  let memoryRepo: SqliteMemoryRepository;
  let cardStore: CardStore;

  /** Minimal memory-tool def threaded verbatim through `extensionTools`. */
  const memoryToolDef: ToolDefinition = {
    name: "memory",
    label: "Memory",
    description: "test memory tool",
    parameters: {} as never,
    execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
  } as ToolDefinition;

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

  /** Fake spawn that records opts and returns a synthesized result. */
  function makeSpawn(overrides: Partial<SpawnSubagentResult> & { throwErr?: string } = {}) {
    const result: SpawnSubagentResult = {
      output: overrides.output ?? "Saved correction",
      ...(overrides.failure ? { failure: overrides.failure } : {}),
    };
    const spawn = async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
      spawnCalls.push(opts);
      if (overrides.throwErr) throw new Error(overrides.throwErr);
      return result;
    };
    return spawn as typeof import("@repo/pi-agent-ext-subagent").spawnSubagent;
  }

  const mockStore = {
    getMemoryEntries: () => ["existing entry"],
    getUserEntries: () => [],
  } as any;

  const config = {
    correctionDetection: true,
    nudgeInterval: 10,
    reviewEnabled: false,
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    nudgeToolCalls: 15,
  };

  function makeCtx(branch: any[] = []) {
    return {
      sessionManager: { getBranch: () => branch },
      signal: undefined as any,
      ui: {
        notify: (msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        },
      },
    };
  }

  function fireMessageEnd(role: string, text: string) {
    const h = handlers["message_end"];
    if (!h) throw new Error("No message_end handler registered");
    for (const fn of h) {
      fn({ message: { role, content: [{ type: "text", text }] } }, makeCtx());
    }
  }

  function fireTurnEnd(branch: any[] = []) {
    const h = handlers["turn_end"];
    if (!h) throw new Error("No turn_end handler registered");
    const ctx = makeCtx(branch);
    for (const fn of h) {
      fn({}, ctx);
    }
    return ctx;
  }

  async function settle(ms = 10) {
    await new Promise((r) => setTimeout(r, ms));
  }

  beforeEach(() => {
    handlers = {};
    spawnCalls = [];
    notifyCalls = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-detector-test-"));
    backend = new SqliteBackend(tmpDir);
    memoryRepo = new SqliteMemoryRepository(backend);
  });

  /** Real card store joined on the shared backend (deferred; cardStore mirror
   *  tests opt in — kp13 Wave B: the failure mirror targets the card store). */
  async function makeCardStore(): Promise<CardStore> {
    cardStore = await createCardStore({ memoryDir: tmpDir, sqliteBackend: backend });
    return cardStore;
  }

  afterEach(async () => {
    if (cardStore) await cardStore.close();
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("triggers spawn when correction detected", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config, null, undefined, memoryToolDef, makeSpawn());

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    fireTurnEnd(branch);
    await settle();

    assert.ok(spawnCalls.length >= 1, "spawn should be called on correction");
  });

  it("dispatches the correction save via spawn with the memory tool bridged in", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config, null, undefined, memoryToolDef, makeSpawn());

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    fireTurnEnd(branch);
    await settle();

    assert.strictEqual(spawnCalls.length, 1);
    const opts = spawnCalls[0]!;
    assert.strictEqual(opts.tier, "small", "should run on the small tier");
    assert.strictEqual(opts.model, undefined, "should NOT set model when no override is present");
    assert.deepStrictEqual(opts.tools, ["memory"], "should allowlist only the memory tool");
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef], "should bridge the parent memory tool def");
    assert.strictEqual(opts.timeoutMs, 30000);
    assert.strictEqual(opts.retryOnTransient, true, "correction save should request a transient retry");
    assert.ok(opts.task?.includes("don't do that"), "task should include the correction conversation");
    assert.match(opts.instructions ?? "", /save the correction/i);
  });

  it("honors llmModelOverride by passing model (and no tier) to spawn", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(
      pi,
      mockStore,
      null,
      { ...config, llmModelOverride: "anthropic/claude-opus-4" },
      null,
      undefined,
      memoryToolDef,
      makeSpawn(),
    );

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    fireTurnEnd(branch);
    await settle();

    assert.strictEqual(spawnCalls.length, 1);
    const opts = spawnCalls[0]!;
    assert.strictEqual(opts.model, "anthropic/claude-opus-4", "should thread the override as model");
    assert.strictEqual(opts.tier, undefined, "should NOT set tier when an override is present");
    // Everything else stays byte-identical to the unset path.
    assert.deepStrictEqual(opts.tools, ["memory"]);
    assert.deepStrictEqual(opts.extensionTools, [memoryToolDef]);
    assert.strictEqual(opts.timeoutMs, 30000);
    assert.strictEqual(opts.retryOnTransient, true);
  });

  it("does NOT trigger on normal messages", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config, null, undefined, memoryToolDef, makeSpawn());

    fireMessageEnd("user", "looks good");
    fireTurnEnd([]);
    await settle();

    assert.strictEqual(spawnCalls.length, 0, "spawn should NOT be called for normal messages");
  });

  it("rate limits: does not trigger on consecutive corrections within 3 turns", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config, null, undefined, memoryToolDef, makeSpawn());

    // First correction
    fireMessageEnd("user", "don't do that");
    fireTurnEnd([]);
    await settle();

    const firstCallCount = spawnCalls.length;
    assert.ok(firstCallCount >= 1, "first correction should trigger");

    // Second correction within 3 turns — should be rate-limited
    fireMessageEnd("user", "not like that");
    fireTurnEnd([]);
    await settle();

    assert.strictEqual(spawnCalls.length, firstCallCount, "second correction should be rate-limited");
  });

  it("defers (does not drop) a correction that arrives inside the rate-limit window", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config, null, undefined, memoryToolDef, makeSpawn());

    // First correction fires and resets the rate-limit window.
    fireMessageEnd("user", "don't do that");
    fireTurnEnd([]);
    await settle();
    const firstCount = spawnCalls.length;
    assert.ok(firstCount >= 1, "first correction should trigger");

    // Second correction is detected but arrives inside the 3-turn window.
    fireMessageEnd("user", "not like that");
    fireTurnEnd([]); // window turn 1
    fireTurnEnd([]); // window turn 2
    fireTurnEnd([]); // window turn 3
    await settle();
    assert.strictEqual(spawnCalls.length, firstCount, "still rate-limited inside the window");

    // Once the window opens, the deferred correction fires instead of being lost.
    fireTurnEnd([]);
    await settle();
    assert.ok(spawnCalls.length > firstCount, "deferred correction fires after the window opens");
  });

  it("mirrors direct correction saves into the card store (md_id-keyed)", async () => {
    const pi = createMockPi();
    const correctionStore = {
      ...mockStore,
      addFailure: async () => ({ success: true, target: 'failure', entry_count: 1, message: 'Failure memory saved: correction', added_md_id: 'md-correction-1' }),
    } as any;

    setupCorrectionDetector(pi, correctionStore, null, config, memoryRepo, undefined, memoryToolDef, makeSpawn(), undefined, await makeCardStore());

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm instead");
    fireTurnEnd(branch);
    await settle();

    // kp13 Wave B: the failure mirror is an md_id-keyed card row (category
    // rides the formatted content, not a column).
    const cards = await cardStore.getCardsByKind("failure");
    assert.strictEqual(cards.length, 1);
    assert.match(cards[0].content, /use pnpm instead/);
    assert.match(cards[0].content, /\[correction\]/);
    assert.strictEqual(cards[0].id, 'md-correction-1');
  });

  it("mirrors project correction saves into the card store (project rides the content)", async () => {
    const pi = createMockPi();
    const correctionStore = {
      ...mockStore,
      addFailure: async () => ({ success: true, target: 'failure', entry_count: 1, message: 'Failure memory saved: correction', added_md_id: 'md-correction-2' }),
    } as any;
    const projectStore = {
      getMemoryEntries: () => [],
    } as any;

    setupCorrectionDetector(pi, correctionStore, projectStore, config, memoryRepo, 'project-a', memoryToolDef, makeSpawn(), undefined, await makeCardStore());

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm in this repo" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm in this repo");
    fireTurnEnd(branch);
    await settle();

    // The card envelope is project-agnostic; the project scope rides the
    // formatted content segment (Project: project-a).
    const cards = await cardStore.getCardsByKind("failure");
    assert.strictEqual(cards.length, 1);
    assert.match(cards[0].content, /use pnpm in this repo/);
    assert.match(cards[0].content, /Project: project-a/);
    assert.strictEqual(cards[0].id, 'md-correction-2');
  });

  it("does not break correction handling when SQLite sync fails", async () => {
    const pi = createMockPi();
    let addFailureCalls = 0;
    const correctionStore = {
      ...mockStore,
      addFailure: async () => {
        addFailureCalls++;
        return { success: true, target: 'failure', entry_count: 1, message: 'Failure memory saved: correction' };
      },
    } as any;

    const failingMemoryRepo = {
      syncMemoryEntry: async () => { throw new Error('sqlite unavailable'); },
    } as unknown as MemoryRepository;

    setupCorrectionDetector(pi, correctionStore, null, config, failingMemoryRepo, undefined, memoryToolDef, makeSpawn());

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use yarn instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use yarn instead");
    fireTurnEnd(branch);
    await settle();

    assert.ok(spawnCalls.length >= 1, 'correction review should still run');
    assert.strictEqual(addFailureCalls, 1, 'Markdown correction save should still happen');
  });

  it("does not register handlers when correctionDetection is false", () => {
    const pi = createMockPi();
    const disabledConfig = { ...config, correctionDetection: false };
    setupCorrectionDetector(pi, mockStore, null, disabledConfig);

    assert.strictEqual(Object.keys(handlers).length, 0, "no handlers should be registered when disabled");
  });

  // ─── Auto-supersede (Plan 5a — judge-gated, opt-in via autoSupersede) ───
  //
  // The 9th param `runJudge` is the testability seam: tests inject a FAKE
  // judge (no LLM/model-registry needed). The directive extracted from
  // "no, delete that file" is "delete that file" (tokens: delete, that,
  // file). The seeded prior "keep that file, never delete" is a genuine
  // contradiction (keep vs delete) AND contains all three directive tokens,
  // so the STRICT FTS5 AND query in searchMemories surfaces it directly —
  // verified empirically. (The naive pairing of "no, use pnpm instead" with
  // a "use yarn" prior does NOT work: once the failure-memory row is synced,
  // its content contains the full directive, the AND query matches it, and
  // the OR-fallback never runs — so a prior sharing only one token is never
  // surfaced. See task-2-report.md.)

  /** Inline correction store with a mocked addFailure (success path; F1
   *  threads the birth md_id like the real store). */
  function makeCorrectionStore(addedMdId = "md-correction-auto") {
    return {
      ...mockStore,
      addFailure: async () => ({ success: true, target: "failure", entry_count: 1, message: "Failure memory saved: correction", added_md_id: addedMdId }),
    } as any;
  }

  it("auto-supersede (opt-in): judge contradicts → prior flipped to superseded", async () => {
    const pi = createMockPi();
    // Seed an active prior the correction contradicts. Its content carries
    // every directive token so searchMemories(directive) surfaces it even
    // alongside the freshly-synced failure memory.
    const prior = await memoryRepo.addMemory({ content: "keep that file, never delete", target: "memory" });
    // Fake judge that says the prior is the contradicted candidate.
    const fakeJudge = async () => ({ contradictedId: prior.id });
    setupCorrectionDetector(
      pi, makeCorrectionStore(), null, { ...config, autoSupersede: true } as any,
      memoryRepo, undefined, memoryToolDef, makeSpawn(), fakeJudge as any, await makeCardStore(),
    );

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, delete that file" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, delete that file");
    fireTurnEnd(branch);
    await settle();

    const got = await memoryRepo.getMemories({ target: "memory" });
    const p = got.find((m) => m.id === prior.id)!;
    assert.ok(p, "prior should still exist");
    assert.strictEqual(p.status, "superseded", "prior should be flipped to superseded");
    assert.ok(p.supersededBy && p.supersededBy > 0, "supersededBy should point at the correction entry id");
  });

  it("auto-supersede: judge returns null → no supersede", async () => {
    const pi = createMockPi();
    const prior = await memoryRepo.addMemory({ content: "keep that file, never delete", target: "memory" });
    const fakeJudge = async () => ({ contradictedId: null });
    setupCorrectionDetector(
      pi, makeCorrectionStore(), null, { ...config, autoSupersede: true } as any,
      memoryRepo, undefined, memoryToolDef, makeSpawn(), fakeJudge as any,
    );

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, delete that file" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, delete that file");
    fireTurnEnd(branch);
    await settle();

    const p = (await memoryRepo.getMemories({ target: "memory" })).find((m) => m.id === prior.id)!;
    assert.notStrictEqual(p.status, "superseded", "prior should be untouched when judge finds no contradiction");
  });

  it("autoSupersede off (default): no judge call, no supersede", async () => {
    const pi = createMockPi();
    let judgeCalled = false;
    const fakeJudge = async () => { judgeCalled = true; return { contradictedId: null }; };
    const prior = await memoryRepo.addMemory({ content: "keep that file, never delete", target: "memory" });
    setupCorrectionDetector(
      pi, makeCorrectionStore(), null, { ...config /* autoSupersede unset → false */ } as any,
      memoryRepo, undefined, memoryToolDef, makeSpawn(), fakeJudge as any,
    );

    fireMessageEnd("user", "no, delete that file");
    fireTurnEnd([]);
    await settle();

    assert.strictEqual(judgeCalled, false, "judge must not run when autoSupersede is off");
    const p = (await memoryRepo.getMemories({ target: "memory" })).find((m) => m.id === prior.id)!;
    assert.notStrictEqual(p.status, "superseded");
  });

  it("auto-supersede: judge throws → no supersede (best-effort)", async () => {
    const pi = createMockPi();
    const prior = await memoryRepo.addMemory({ content: "keep that file, never delete", target: "memory" });
    const fakeJudge = async () => { throw new Error("boom"); };
    setupCorrectionDetector(
      pi, makeCorrectionStore(), null, { ...config, autoSupersede: true } as any,
      memoryRepo, undefined, memoryToolDef, makeSpawn(), fakeJudge as any,
    );

    fireMessageEnd("user", "no, delete that file");
    fireTurnEnd([]);
    await settle();

    const p = (await memoryRepo.getMemories({ target: "memory" })).find((m) => m.id === prior.id)!;
    assert.notStrictEqual(p.status, "superseded", "judge throw must not crash the session or supersede");
  });

  it("auto-supersede: adversarial judge (returns correction entry id) → no self-supersede", async () => {
    const pi = createMockPi();
    // Since self is filtered from the candidate pool BEFORE judging,
    // we cannot directly return the correction entry's id (it's not in the pool).
    // This test verifies the structural guarantee: even with a candidate pool
    // and judge execution, no row self-supersedes (supersededBy === id).
    const prior = await memoryRepo.addMemory({ content: "keep that file, never delete", target: "memory" });
    const fakeJudge = async (_ctx: any, opts: any) => ({ contradictedId: opts.candidates[0]?.id ?? null });
    setupCorrectionDetector(
      pi, makeCorrectionStore(), null, { ...config, autoSupersede: true } as any,
      memoryRepo, undefined, memoryToolDef, makeSpawn(), fakeJudge as any,
    );

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, delete that file" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, delete that file");
    fireTurnEnd(branch);
    await settle();

    // Structural guarantee: no memory row is its own parent (self-supersede).
    const allMemories = await memoryRepo.getMemories();
    for (const row of allMemories) {
      assert.notStrictEqual(
        row.supersededBy,
        row.id,
        `Memory #${row.id} must not self-supersede (supersededBy === id)`,
      );
    }
  });
});
