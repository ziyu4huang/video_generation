import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildCallGlobal, type CallDeps } from "../src/call-global.js";
import { HostFnRegistry } from "../src/host-fn-registry.js";
import { WorkflowErrorCode } from "../src/errors.js";
import type { JournalEntry } from "../src/workflow.js";

/** Build minimal injected deps for the factory. Returns the mutable state/shared/journal for assertions. */
function makeDeps(opts: { hostFns?: HostFnRegistry; maxAgents?: number; resumeJournal?: Map<number, JournalEntry> } = {}): {
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
    await assert.rejects(() => call("t.missing", {}), (e: any) => e.code === WorkflowErrorCode.HOST_FN_UNKNOWN && e.recoverable === false);
  });

  it("fn throw → HOST_FN_FAILED (hard error, NOT null)", async () => {
    const r = new HostFnRegistry();
    r.set("t.boom", { fn: async () => { throw new Error("boom"); } });
    const { deps } = makeDeps({ hostFns: r });
    const call = buildCallGlobal(deps);
    await assert.rejects(
      () => call("t.boom", {}),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_FAILED && e.recoverable === false,
    );
  });
});
