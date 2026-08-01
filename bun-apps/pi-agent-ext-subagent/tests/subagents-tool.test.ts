import { test } from "bun:test";
import assert from "node:assert/strict";
import { DEFAULT_BATCH_CONCURRENCY, MAX_CONCURRENCY } from "../src/config.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import {
  clampConcurrency,
  createSubagentsTool,
  mergeReadOnlyExclusion,
  READ_ONLY_EXCLUDED,
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
