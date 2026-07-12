import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { HostFnRegistry } from "../src/host-fn-registry.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

describe("call() integration with runWorkflow", () => {
  it("a script can call() a registered host fn end-to-end", async () => {
    const r = new HostFnRegistry();
    r.set("t.echo", { fn: async (a: any) => ({ got: a.x }) });
    const script = `export const meta = { name: 'c', description: 'call' }
const r = await call('t.echo', { x: 5 })
return r`;
    const res = await runWorkflow<{ got: number }>(script, { agent: noopAgent, hostFns: r, persistLogs: false });
    assert.deepEqual(res.result, { got: 5 });
  });

  it("call() spends zero tokens but still counts toward agentCount", async () => {
    const r = new HostFnRegistry();
    r.set("t.id", { fn: async () => 1 });
    const script = `export const meta = { name: 'c', description: 'call' }
await call('t.id', {})
await call('t.id', {})
return 1`;
    const res = await runWorkflow(script, { agent: noopAgent, hostFns: r, persistLogs: false });
    assert.equal(res.tokenUsage.total, 0);
    assert.equal(res.agentCount, 2);
  });

  it("call() replays from resumeJournal on the second run (fn runs once total)", async () => {
    let calls = 0;
    const r = new HostFnRegistry();
    r.set("t.count", { fn: async () => ++calls });
    const script = `export const meta = { name: 'c', description: 'call' }
return await call('t.count', { q: 'z' })`;
    const journal = new Map<number, JournalEntry>();
    await runWorkflow(script, {
      agent: noopAgent,
      hostFns: r,
      persistLogs: false,
      onAgentJournal: (e) => journal.set(e.index, e),
    });
    const res = await runWorkflow<number>(script, {
      agent: noopAgent,
      hostFns: r,
      persistLogs: false,
      resumeJournal: journal,
    });
    assert.equal(calls, 1, "fn ran once total (second run replayed)");
    assert.equal(res.result, 1);
  });

  it("call() and agent() share one ordered journal sequence", async () => {
    const r = new HostFnRegistry();
    r.set("t.id", { fn: async () => "C" });
    const script = `export const meta = { name: 'c', description: 'call' }
const a = await call('t.id', {})
const b = await agent('hi')
return { a, b }`;
    const journal: JournalEntry[] = [];
    await runWorkflow(script, {
      agent: noopAgent,
      hostFns: r,
      persistLogs: false,
      onAgentJournal: (e) => journal.push(e),
    });
    assert.deepEqual(
      journal.map((e) => e.index),
      [0, 1],
      "call() and agent() share one ordered journal",
    );
  });

  it("unknown host fn → HOST_FN_UNKNOWN aborts the run", async () => {
    const script = `export const meta = { name: 'c', description: 'call' }
return await call('t.missing', {})`;
    await assert.rejects(
      () => runWorkflow(script, { agent: noopAgent, hostFns: new HostFnRegistry(), persistLogs: false }),
      /not registered|HOST_FN_UNKNOWN/i,
    );
  });
});

describe("kcard-converge-loop migration (T11)", () => {
  it("convergeRound uses call('zk.health'/'zk.ingest'), not an LLM agent relay", async () => {
    const src = await Bun.file("samples/kcard-converge-loop.js").text();
    assert.ok(/call\(['"]zk\.health['"]/.test(src), "uses call('zk.health')");
    assert.ok(/call\(['"]zk\.ingest['"]/.test(src), "uses call('zk.ingest')");
    assert.ok(!/return its stdout VERBATIM/i.test(src), "the LLM-relay instruction is gone");
    assert.ok(!/kcard-loop\s+\$\{sourceTokens\}/.test(src), "the kcard-loop CLI relay command is gone");
  });
});
