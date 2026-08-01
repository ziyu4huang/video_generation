import { test } from "bun:test";
import assert from "node:assert/strict";
import { DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_TASKS, MAX_CONCURRENCY } from "../src/config.js";
import { createSubagentsTool as fromIndex } from "../src/index.js";
import type { SpawnSubagentResult } from "../src/spawn-subagent.js";
import { SubagentInFlightRegistry } from "../src/subagent-in-flight.js";
import type { SubagentRunPersistence, SubagentRunRecord } from "../src/subagent-run-persistence.js";
import {
  clampConcurrency,
  createSubagentsTool,
  mergeReadOnlyExclusion,
  READ_ONLY_EXCLUDED,
  renderBatchResult,
} from "../src/subagents-tool.js";

test("createSubagentsTool has name 'subagents' + executionMode 'sequential'", () => {
  const tool = createSubagentsTool();
  assert.equal(tool.name, "subagents");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.parameters, "parameters schema defined");
});

test("clampConcurrency clamps to [1, MAX_CONCURRENCY] and defaults", () => {
  assert.equal(clampConcurrency(undefined), DEFAULT_BATCH_CONCURRENCY);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(3), 3);
  assert.equal(clampConcurrency(999), MAX_CONCURRENCY);
});

test("mergeReadOnlyExclusion always excludes edit/write/bash, even when caller allowlists them", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t", tools: ["bash", "read", "edit"], excludeTools: ["grep"] },
    { defaultCwd: "/repo", mainModel: "p/m" },
  );
  for (const forbidden of READ_ONLY_EXCLUDED) {
    assert.ok(opts.excludeTools?.includes(forbidden), `excludes ${forbidden}`);
  }
  // caller's own exclusions survive
  assert.ok(opts.excludeTools?.includes("grep"));
  // caller's allowlist survives (deny applies after, in the runner)
  assert.deepEqual(opts.tools, ["bash", "read", "edit"]);
  assert.equal(opts.task, "t");
  assert.equal(opts.cwd, "/repo");
  assert.equal(opts.mainModel, "p/m");
});

test("mergeReadOnlyExclusion defaults timeoutMs and carries per-child budgets", () => {
  const opts = mergeReadOnlyExclusion({ task: "t", tokenBudget: 1000, spendBudget: 0.5 }, { defaultCwd: "/repo" });
  assert.equal(opts.timeoutMs, 15 * 60 * 1000);
  assert.equal(opts.tokenBudget, 1000);
  assert.equal(opts.spendBudget, 0.5);
});

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

/** Injectable spawn: returns outputs by task index, records calls + their timing. */
function fakeSpawnByIndex(outputs: (SpawnSubagentResult | ((opts: { task: string }) => SpawnSubagentResult))[]) {
  const calls: { task: string; excludeTools?: string[]; at: number }[] = [];
  let t = 0;
  return {
    calls,
    spawn: async (opts: { task: string; excludeTools?: string[] }): Promise<SpawnSubagentResult> => {
      const at = t++;
      calls.push({ task: opts.task, excludeTools: opts.excludeTools, at });
      const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? at);
      const o = outputs[idx] ?? outputs[at];
      const resolved = typeof o === "function" ? (o as (o: { task: string }) => SpawnSubagentResult)(opts) : o;
      return resolved as SpawnSubagentResult;
    },
  };
}

test("execute fans out, returns positional results in input order", async () => {
  const f = fakeSpawnByIndex([
    { output: "A", exitCode: 0, stderr: "", timedOut: false },
    { output: "B", exitCode: 0, stderr: "", timedOut: false },
    { output: "C", exitCode: 0, stderr: "", timedOut: false },
  ]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn });
  const res = await tool.execute(
    "call-1",
    { tasks: [{ task: "#0" }, { task: "#1" }, { task: "#2" }], concurrency: 2 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.results.length, 3);
  assert.equal((res.details.results[0] as { output: string }).output, "A");
  assert.equal((res.details.results[2] as { output: string }).output, "C");
  assert.equal((res.details.results[0] as { status: string }).status, "done");
  assert.equal(res.details.dispatched, 3);
  assert.equal(res.details.skipped, 0);
});

test("a failed child becomes a null slot (partial-failure tolerant)", async () => {
  const f = fakeSpawnByIndex([
    { output: "ok", exitCode: 0, stderr: "", timedOut: false },
    { output: "", exitCode: 1, stderr: "boom", timedOut: false },
  ]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn });
  const res = await tool.execute("call-2", { tasks: [{ task: "#0" }, { task: "#1" }] }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.results[0] && (res.details.results[0] as { status: string }).status, "done");
  assert.equal(res.details.results[1], null);
});

test("execute rejects an empty tasks array with an actionable message", async () => {
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: async () => ({ output: "", exitCode: 0, stderr: "", timedOut: false }),
  });
  const res = await tool.execute("call-3", { tasks: [] }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(res.content[0].text, /tasks must be a non-empty array/i);
});

test("execute rejects an over-limit tasks array (MAX_BATCH_TASKS + 1) with an actionable message", async () => {
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: async () => ({ output: "", exitCode: 0, stderr: "", timedOut: false }),
  });
  const tasks = Array.from({ length: MAX_BATCH_TASKS + 1 }, (_v, i) => ({ task: `#${i}` }));
  const res = await tool.execute("call-cap", { tasks }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(res.content[0].text, /too large/);
  assert.equal(res.details.dispatched, 0);
  assert.equal(res.details.skipped, 0);
});

function fakeSpawnWithUsage(usages: { total: number; cost: number }[], delayMs = 0) {
  let i = 0;
  return async (): Promise<SpawnSubagentResult> => {
    const idx = i++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = usages[idx] ?? { total: 0, cost: 0 };
    return {
      output: `out${idx}`,
      exitCode: 0,
      stderr: "",
      timedOut: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.total, cost: u.cost },
    };
  };
}

test("batch token budget soft gate skips remaining slots without aborting in-flight children", async () => {
  // 4 tasks, concurrency 1 (deterministic order). Child 0 burns 40k of a 50k budget;
  // child 1 (30k) pushes cumulative to 70k > 50k AFTER it finishes → gate trips →
  // children 2,3 are never dispatched and become budget slots.
  const f = fakeSpawnWithUsage([
    { total: 40000, cost: 0 },
    { total: 30000, cost: 0 },
    { total: 0, cost: 0 },
    { total: 0, cost: 0 },
  ]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f });
  const res = await tool.execute(
    "call-gate",
    { tasks: [{ task: "#0" }, { task: "#1" }, { task: "#2" }, { task: "#3" }], concurrency: 1, tokenBudget: 50000 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const d = res.details;
  assert.equal(d.dispatched, 2, "two children ran before the gate tripped");
  assert.equal(d.skipped, 2, "two slots skipped by the gate");
  assert.ok(d.budgetExhaustion, "top-level exhaustion set");
  assert.equal(d.budgetExhaustion!.kind, "tokens");
  // skipped slots are budget slots, not null
  assert.equal((d.results[2] as { status: string }).status, "budget");
  assert.equal((d.results[3] as { status: string }).status, "budget");
  // the two that ran completed normally (in-flight never aborted)
  assert.equal((d.results[0] as { status: string }).status, "done");
  assert.equal((d.results[1] as { status: string }).status, "done");
});

/** In-memory persistence capturing every saved record. */
function memPersistence(): SubagentRunPersistence & { saved: SubagentRunRecord[] } {
  const saved: SubagentRunRecord[] = [];
  return {
    saved,
    save: (rec: SubagentRunRecord) => {
      saved.push(rec);
    },
    list: () => saved,
    load: () => null,
  } as unknown as SubagentRunPersistence & { saved: SubagentRunRecord[] };
}

test("each dispatched child registers in-flight while running and persists once on completion", async () => {
  const inFlight = new SubagentInFlightRegistry();
  let seenDuringRun = 0;
  const f = fakeSpawnByIndex([
    () => {
      seenDuringRun = inFlight.list().length;
      return { output: "A", exitCode: 0, stderr: "", timedOut: false };
    },
    () => {
      seenDuringRun = Math.max(seenDuringRun, inFlight.list().length);
      return { output: "B", exitCode: 0, stderr: "", timedOut: false };
    },
  ]);
  const persistence = memPersistence();
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, inFlight, persistence });
  await tool.execute(
    "call-obs",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 2 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  // registry is empty after the batch completes (all children ended)
  assert.equal(inFlight.list().length, 0);
  // while running, both children were registered
  assert.ok(seenDuringRun >= 1, "at least one child was in-flight during the run");
  // one persistence record per dispatched child
  assert.equal(persistence.saved.length, 2);
  assert.equal(persistence.saved[0].task, "#0");
  assert.equal(persistence.saved[0].status, "done");
});

test("a failed child is not persisted; a gate-skipped child is not persisted", async () => {
  const f = fakeSpawnByIndex([
    { output: "", exitCode: 1, stderr: "x", timedOut: false }, // failed
    { output: "ok", exitCode: 0, stderr: "", timedOut: false }, // done, trips gate
    { output: "ok", exitCode: 0, stderr: "", timedOut: false }, // skipped by gate
  ]);
  const persistence = memPersistence();
  // give the done child heavy usage so the gate trips after it
  // (re-use the usage fake by wrapping)
  const wrappedSpawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const r = await f.spawn(opts);
    if (r.exitCode === 0)
      return { ...r, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 60000, cost: 0 } };
    return r;
  };
  const tool2 = createSubagentsTool({ cwd: "/repo", spawn: wrappedSpawn, persistence });
  await tool2.execute(
    "call-np",
    { tasks: [{ task: "#0" }, { task: "#1" }, { task: "#2" }], concurrency: 1, tokenBudget: 50000 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  // only the one done child persists (failed + skipped do not)
  assert.equal(persistence.saved.length, 1);
  assert.equal(persistence.saved[0].status, "done");
});

test("createSubagentsTool is re-exported from the package index", () => {
  assert.equal(fromIndex, createSubagentsTool);
  assert.equal(fromIndex().name, "subagents");
});

test("renderBatchResult renders ok/failed/skipped sections", () => {
  const text = renderBatchResult({
    results: [
      { output: "hello", status: "done", index: 0, id: "a" },
      null,
      { status: "budget", source: "batch", exhaustion: { kind: "tokens", limit: 50000, actual: 70000 }, index: 2 },
    ],
    dispatched: 1,
    skipped: 1,
    elapsedMs: 1500,
    budgetExhaustion: { kind: "tokens", limit: 50000, actual: 70000 },
  });
  assert.match(text, /1 ok · 1 failed · 1 skipped/);
  assert.match(text, /\(a\) done/);
  assert.match(text, /skipped — batch budget: tokens 70000 > 50000/);
});

test("batch children get batchId + forwarded onModelResolved/onHistory update the registry", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const captured: { id: string; batchId?: string; resolved?: string; historyLen: number }[] = [];
  const spawn = async (opts: {
    task: string;
    onModelResolved?: (id: string) => void;
    onHistory?: (h: { kind: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onModelResolved?.("google/gemma-4-12b-qat");
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    const entry = inFlight.get(`batch-call:${idx}`);
    captured.push({
      id: `batch-call:${idx}`,
      batchId: entry?.batchId,
      resolved: entry?.resolvedModel,
      historyLen: entry?.history?.length ?? 0,
    });
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute(
    "batch-call",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(captured.length, 2, "both children ran");
  for (const c of captured) {
    assert.equal(c.batchId, "batch-call", "child registered with the batch toolCallId as batchId");
    assert.equal(c.resolved, "google/gemma-4-12b-qat", "onModelResolved forwarded → resolvedModel set");
    assert.equal(c.historyLen, 1, "onHistory forwarded → history stored");
  }
  assert.equal(inFlight.list().length, 0, "registry empty after the batch completes");
});

test("a child hitting its own per-child budget renders as 'child budget' (source: child)", async () => {
  const spawn = async (): Promise<SpawnSubagentResult> => ({
    output: "out",
    exitCode: 0,
    stderr: "",
    timedOut: false,
    budget: { kind: "tokens", limit: 100, actual: 200 },
  });
  const tool = createSubagentsTool({ cwd: "/repo", spawn });
  const res = await tool.execute("call-child-budget", { tasks: [{ task: "#0" }] }, NO_SIGNAL, undefined, NO_CTX);
  const slot = res.details.results[0];
  assert.equal((slot as { status: string }).status, "budget");
  assert.equal((slot as { source: string }).source, "child");
  assert.match(res.content[0].text, /child budget: tokens 200 > 100/);
});

test("batch keeps a completed child (status=completed) mid-run; evicts the whole batch on return", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const seen: { id: string; status?: string; present: boolean }[] = [];
  const spawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    // child #0 finishes first (concurrency 1 → strict order): by the time #1 runs,
    // #0 must still be present in the registry, marked completed (NOT evicted).
    if (idx === 1) {
      const c0 = inFlight.get("batch-call:0");
      seen.push({ id: "batch-call:0", status: c0?.status, present: !!c0 });
    }
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute(
    "batch-call",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(seen.length, 1, "child #1 observed #0");
  assert.equal(seen[0].present, true, "#0 still in registry when #1 runs (kept, not evicted)");
  assert.equal(seen[0].status, "completed", "#0 marked completed (not running, not gone)");
  assert.equal(inFlight.list().length, 0, "registry empty after the batch returns (whole-batch eviction)");
});

test("onUpdate emits a single-line 'k/N running · latest' as children progress", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const updates: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    updates.push(u.content.map((c) => c.text).join(""));
  };
  const spawn = async (opts: {
    task: string;
    onHistory?: (h: { kind: string; toolName?: string; text?: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "r" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    // mark each child completed to mirror the real finally-block
    inFlight.markCompleted(`batch-call:${idx}`);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute(
    "batch-call",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    onUpdate as never,
    NO_CTX,
  );
  assert.ok(updates.length >= 2, "at least one update per child history tick");
  const first = updates[0];
  assert.match(first, /subagents/, "single-line batch summary");
  assert.match(first, /\/2/, "shows /N total");
  assert.match(first, /latest/, "includes the latest action");
  assert.match(updates[1], /1\/2/, "running stays 1 as sibling #0 completes (not 2)");
});
