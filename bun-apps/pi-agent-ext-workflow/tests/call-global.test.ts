import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";
import { buildCallGlobal, type CallDeps } from "../src/call-global.js";
import { HostFnRegistry } from "../src/host-fn-registry.js";
import type { JournalEntry } from "../src/workflow.js";

/** Build minimal injected deps for the factory. Returns the mutable state/shared/journal for assertions. */
function makeDeps(
  opts: { hostFns?: HostFnRegistry; maxAgents?: number; resumeJournal?: Map<number, JournalEntry> } = {},
): {
  deps: CallDeps;
  state: { callSeq: number; firstMiss: number; currentPhase?: string };
  shared: { agentCount: number };
  journal: JournalEntry[];
} {
  const state = { callSeq: 0, firstMiss: Number.POSITIVE_INFINITY, currentPhase: "P" };
  const shared = { agentCount: 0 };
  const journal: JournalEntry[] = [];
  const deps: CallDeps = {
    hostFns: opts.hostFns ?? new HostFnRegistry(),
    state,
    shared,
    maxAgents: opts.maxAgents ?? 1000,
    options: {
      resumeJournal: opts.resumeJournal,
      onAgentJournal: (e) => journal.push(e as JournalEntry),
    },
    runId: "r1",
    throwIfAborted: () => {},
  };
  return { deps, state, shared, journal };
}

describe("buildCallGlobal — core", () => {
  it("returns the fn result and journals it once", async () => {
    const r = new HostFnRegistry();
    r.set("t.echo", { fn: async (a: any) => ({ back: a.x }) });
    const { deps, journal } = makeDeps({ hostFns: r });
    const call = buildCallGlobal(deps);
    const out = await call("t.echo", { x: 7 });
    assert.deepEqual(out, { back: 7 });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].index, 0);
    assert.equal(typeof journal[0].hash, "string");
  });

  it("bad name → TypeError; unknown fn → HOST_FN_UNKNOWN", async () => {
    const { deps } = makeDeps();
    const call = buildCallGlobal(deps);
    await assert.rejects(() => call("nope" as any, {}), TypeError);
    await assert.rejects(
      () => call("t.missing", {}),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_UNKNOWN && e.recoverable === false,
    );
  });

  it("fn throw → HOST_FN_FAILED (hard error, NOT null)", async () => {
    const r = new HostFnRegistry();
    r.set("t.boom", {
      fn: async () => {
        throw new Error("boom");
      },
    });
    const { deps } = makeDeps({ hostFns: r });
    const call = buildCallGlobal(deps);
    await assert.rejects(
      () => call("t.boom", {}),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_FAILED && e.recoverable === false,
    );
  });
});

describe("buildCallGlobal — journal/accounting/limiter gates", () => {
  it("replays journaled result on resume (fn NOT re-invoked)", async () => {
    let calls = 0;
    const r = new HostFnRegistry();
    r.set("t.count", { fn: async () => ++calls });
    const run1 = makeDeps({ hostFns: r });
    await buildCallGlobal(run1.deps)("t.count", { q: "x" });
    assert.equal(calls, 1);
    const resume = new Map<number, JournalEntry>();
    for (const e of run1.journal) resume.set(e.index, e);
    const run2 = makeDeps({ hostFns: r, resumeJournal: resume });
    const out = await buildCallGlobal(run2.deps)("t.count", { q: "x" });
    assert.equal(calls, 1, "fn NOT re-invoked on resume");
    assert.equal(out, 1);
  });

  it("changed args invalidate the prefix → fn re-runs (firstMiss)", async () => {
    let calls = 0;
    const r = new HostFnRegistry();
    r.set("t.count", { fn: async () => ++calls });
    const run1 = makeDeps({ hostFns: r });
    await buildCallGlobal(run1.deps)("t.count", { q: "x" });
    const resume = new Map<number, JournalEntry>();
    for (const e of run1.journal) resume.set(e.index, e);
    const run2 = makeDeps({ hostFns: r, resumeJournal: resume });
    await buildCallGlobal(run2.deps)("t.count", { q: "CHANGED" });
    assert.equal(calls, 2, "fn re-ran because args changed (hash mismatch)");
  });

  it("counts against maxAgents (mirrors checkpoint)", async () => {
    const r = new HostFnRegistry();
    r.set("t.id", { fn: async () => 1 });
    const { deps } = makeDeps({ hostFns: r, maxAgents: 2 });
    const call = buildCallGlobal(deps);
    await call("t.id", {});
    await call("t.id", {});
    await assert.rejects(
      () => call("t.id", {}),
      (e: any) => e.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
    );
  });

  it("shares state.callSeq — callIndex is monotonic", async () => {
    const r = new HostFnRegistry();
    r.set("t.id", { fn: async () => 1 });
    const { deps, journal } = makeDeps({ hostFns: r });
    const call = buildCallGlobal(deps);
    await call("t.id", {});
    await call("t.id", {});
    assert.deepEqual(
      journal.map((e) => e.index),
      [0, 1],
    );
  });

  it("does NOT route through the concurrency limiter (spy asserts 0 calls)", async () => {
    const r = new HostFnRegistry();
    r.set("t.id", { fn: async () => 1 });
    let limiterCalls = 0;
    const { deps } = makeDeps({ hostFns: r });
    deps.limiter = async (fn) => {
      limiterCalls++;
      return fn();
    };
    await buildCallGlobal(deps)("t.id", {});
    assert.equal(limiterCalls, 0, "call() must not flow through the limiter");
  });
});

describe("buildCallGlobal — ctx.ask (host-fn → human, threaded from confirm)", () => {
  it("threads deps.options.ask into ctx.ask and resolves via the callback", async () => {
    const r = new HostFnRegistry();
    let capturedPrompt = "";
    let capturedChoices: string[] | undefined;
    r.set("t.asker", {
      fn: async (_a: any, ctx: any) => {
        if (!ctx.ask) throw new Error("ask missing in a UI-bearing run");
        const reply = await ctx.ask("pick one", { kind: "select", choices: ["A", "B"], default: "A" });
        return { chose: reply };
      },
    });
    const { deps } = makeDeps({ hostFns: r });
    // Simulate the UI-bearing confirm() callback threaded from the main session
    // (the same one checkpoint() uses). Sourced from deps.options.ask.
    (deps.options as any).ask = async (promptText: string, options: any) => {
      capturedPrompt = promptText;
      capturedChoices = options?.choices;
      return "B";
    };
    const out = await buildCallGlobal(deps)("t.asker", {});
    assert.equal(capturedPrompt, "pick one");
    assert.deepEqual(capturedChoices, ["A", "B"]);
    assert.deepEqual(out, { chose: "B" });
  });

  it("ctx.ask is undefined when no callback threaded (headless) → host-fn falls back", async () => {
    const r = new HostFnRegistry();
    r.set("t.asker", {
      fn: async (_a: any, ctx: any) => {
        // Headless run: ctx.ask is undefined → the host-fn supplies its own default.
        if (ctx.ask) return { chose: await ctx.ask("q") };
        return { chose: "default" };
      },
    });
    const { deps } = makeDeps({ hostFns: r });
    // NO deps.options.ask → headless (mirrors checkpoint when confirm is absent)
    const out = await buildCallGlobal(deps)("t.asker", {});
    assert.deepEqual(out, { chose: "default" });
  });

  it("ctx.ask result shapes the journaled result; resume replays WITHOUT re-asking", async () => {
    const r = new HostFnRegistry();
    let askCount = 0;
    r.set("t.asker", {
      fn: async (_a: any, ctx: any) => {
        const reply = ctx.ask ? await (ctx.ask("q") as Promise<unknown>) : "default";
        askCount++;
        return { chose: reply };
      },
    });
    const run1 = makeDeps({ hostFns: r });
    (run1.deps.options as any).ask = async () => "live-answer";
    const out1 = await buildCallGlobal(run1.deps)("t.asker", {});
    assert.deepEqual(out1, { chose: "live-answer" });
    assert.equal(askCount, 1);

    // Resume from journal: fn (and thus ask) must NOT be re-invoked.
    const resume = new Map<number, JournalEntry>();
    for (const e of run1.journal) resume.set(e.index, e);
    const run2 = makeDeps({ hostFns: r, resumeJournal: resume });
    let confirmCalled = false;
    (run2.deps.options as any).ask = async () => {
      confirmCalled = true;
      return "should-not-happen";
    };
    const out2 = await buildCallGlobal(run2.deps)("t.asker", {});
    assert.deepEqual(out2, { chose: "live-answer" }, "replayed the journaled answer-shaped result");
    assert.equal(askCount, 1, "host-fn body NOT re-run on resume");
    assert.equal(confirmCalled, false, "ask NOT re-invoked on resume");
  });
});
