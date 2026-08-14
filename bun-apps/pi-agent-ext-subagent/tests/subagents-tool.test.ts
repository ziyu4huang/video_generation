import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentUsage, InFlightSubagent } from "@repo/pi-agent-ext-core-runtime";
import {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_TASKS,
  MAX_CONCURRENCY,
  SubagentInFlightRegistry,
} from "@repo/pi-agent-ext-core-runtime";
import { createSubagentsTool as fromIndex } from "../src/index.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import type { SubagentRunPersistence, SubagentRunRecord } from "../src/subagent-run-persistence.js";
import type { SubagentsToolDetails } from "../src/subagents-tool.js";
import {
  buildLiveTable,
  childDispatchIndex,
  clampConcurrency,
  createSubagentsTool,
  formatModelSeg,
  formatSlotMeta,
  formatUsage,
  mergeReadOnlyExclusion,
  READ_ONLY_EXCLUDED,
  renderBatchResult,
  renderSubagentsCall,
  renderSubagentsResult,
  sumUsage,
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

test("#01 plural mirror: per-child tier default applied when tokenBudget omitted", async () => {
  const calls: SpawnSubagentOptions[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  await tool.execute(
    "batch-bud",
    {
      tasks: [
        { task: "research", tier: "small" },
        { task: "big synth", tier: "big", tokenBudget: 999 },
      ],
    } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  assert.equal(calls[0]?.tokenBudget, 500_000, "tier:small child → 500k default");
  assert.equal(calls[1]?.tokenBudget, 999, "explicit per-child tokenBudget wins");
});

test("#1336 plural mirror: per-child task.maxTurns forwarded; omitted → undefined (no default)", async () => {
  const calls: SpawnSubagentOptions[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  await tool.execute(
    "batch-maxturns",
    {
      tasks: [{ task: "capped", maxTurns: 4 }, { task: "uncapped" }],
    } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  assert.equal(calls[0]?.maxTurns, 4, "explicit per-child maxTurns forwarded");
  assert.equal(calls[1]?.maxTurns, undefined, "omitted maxTurns stays undefined (omit = unlimited turns)");
});

test("#1336: per-child turn-cap abort maps to a 'turns' slot (counted as skipped, no batch gate)", async () => {
  // Mirrors the per-child hard-budget test: child 1 returns its OWN turns
  // exhaustion, which must map to a status:"turns" slot, count in `skipped`,
  // NOT set batchExhaustion, and render with the max-turns-exceeded label.
  let i = 0;
  const spawn = async (): Promise<SpawnSubagentResult> => {
    const idx = i++;
    if (idx === 1) {
      return {
        output: "",
        exitCode: 124,
        stderr: "max turns exceeded (5)",
        timedOut: false,
        turns: { maxTurns: 5, turnsUsed: 5 },
      };
    }
    return { output: `out${idx}`, exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn });
  const res = await tool.execute(
    "call-childturns",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const d = res.details;
  assert.equal(d.dispatched, 2, "both children ran");
  assert.equal(d.skipped, 1, "the turn-cap abort counts as a skipped turns slot");
  assert.equal(d.budgetExhaustion, undefined, "a turn cap does NOT set the batch-level budget exhaustion");
  assert.equal((d.results[0] as { status: string }).status, "done");
  const slot1 = d.results[1] as { status: string; turns?: { maxTurns: number; turnsUsed: number } };
  assert.equal(slot1.status, "turns");
  assert.deepEqual(slot1.turns, { maxTurns: 5, turnsUsed: 5 });
  assert.match(renderBatchResult(d), /max turns exceeded: 5\/5 turns/, "rendering labels the turn-cap abort");
});

// ── optimization #1: default to the parent's gated active tool set ──
// (see .planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/ ticket 01)
// A read-only batch child must NOT re-inherit the full ~55-tool definition universe;
// when a task omits `tools`, it defaults to the parent's CURRENT active set so the
// child re-pays only the ~10k gated schema baseline. An explicit per-task `tools`
// always overrides.

test("mergeReadOnlyExclusion defaults a no-tools task to ctx.activeTools", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t" },
    { defaultCwd: "/repo", activeTools: ["read", "grep", "find", "ls"] },
  );
  assert.deepEqual(opts.tools, ["read", "grep", "find", "ls"], "no-tools task inherits the parent's gated set");
});

test("mergeReadOnlyExclusion: explicit per-task tools override ctx.activeTools", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t", tools: ["read"] },
    { defaultCwd: "/repo", activeTools: ["read", "grep", "find", "ls"] },
  );
  assert.deepEqual(opts.tools, ["read"], "explicit per-task tools win over the active-set default");
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

// ── optimization #1: default to the parent's gated active tool set (execute path) ──
// A read-only batch child must NOT re-inherit the full ~55-tool definition universe;
// a no-tools task narrows to the parent's CURRENT active set (getActiveTools). An
// explicit per-task `tools` always overrides. (ticket 01)

/** Injectable spawn that captures the FULL opts (incl. `tools`) per call. */
function fakeSpawnCapture() {
  const calls: Array<SpawnSubagentOptions> = [];
  return {
    calls,
    spawn: async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
      calls.push(opts);
      return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
    },
  };
}

test("a no-tools batch child defaults to the parent's gated active set", async () => {
  const f = fakeSpawnCapture();
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: f.spawn,
    getActiveTools: () => ["read", "grep", "find", "ls", "subagent"],
  });
  await tool.execute("call-active", { tasks: [{ task: "t" }] }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(
    f.calls[0]?.tools,
    ["read", "grep", "find", "ls", "subagent"],
    "a no-tools child narrows to the parent's gated active set, not the full universe",
  );
});

test("an explicit per-task `tools` override wins over the active-set default", async () => {
  const f = fakeSpawnCapture();
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: f.spawn,
    getActiveTools: () => ["read", "grep", "find", "ls", "subagent"],
  });
  await tool.execute(
    "call-override",
    { tasks: [{ task: "t", tools: ["read", "grep"] }] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.deepEqual(
    f.calls[0]?.tools,
    ["read", "grep"],
    "explicit per-task tools still narrow to EXACTLY the requested set",
  );
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

test("each completed slot carries task/model/elapsedMs; renderBatchResult is unchanged", async () => {
  // Generic output independent of the task text, so we can prove the task label
  // and model do NOT leak into the model-facing rendered text.
  const spawn = async (_opts: { task: string }) => ({
    output: "child-output",
    exitCode: 0,
    stderr: "",
    timedOut: false,
    usage: { total: 100, cost: 0.001 },
  });
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: spawn as never,
    getMainModel: () => "provider/flash",
  });
  const res = await tool.execute(
    "call-enrich",
    { tasks: [{ task: "secret-task-label", id: "a" }, { task: "also-secret" }] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const r = res.details.results;
  const s0 = r[0] as { task: string; model: string; elapsedMs: number; status: string; output: string };
  assert.ok(s0.task.includes("secret-task-label"), "slot.task carries the task preview");
  assert.equal(s0.model, "provider/flash");
  assert.ok(s0.elapsedMs >= 0);

  // renderBatchResult selects output/status/id only — task + model must not appear.
  const rendered = renderBatchResult(res.details);
  assert.ok(!rendered.includes("provider/flash"), "model must not leak into rendered text");
  assert.ok(!rendered.includes("secret-task-label"), "task must not leak into rendered text");
  assert.match(rendered, /child-output/);
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
  assert.equal(d.budgetExhaustion?.kind, "tokens");
  // skipped slots are budget slots, not null
  assert.equal((d.results[2] as { status: string }).status, "budget");
  assert.equal((d.results[3] as { status: string }).status, "budget");
  // the two that ran completed normally (in-flight never aborted)
  assert.equal((d.results[0] as { status: string }).status, "done");
  assert.equal((d.results[1] as { status: string }).status, "done");
});

test("per-child hard-budget abort maps to a source:'child' budget slot (counted as skipped, no batch gate)", async () => {
  // No batch-level budget → the batch soft gate never trips. Child 1 returns its
  // OWN budget exhaustion (the child runner hit its per-run ceiling), which must
  // map to a budget slot with source:"child", be counted in `skipped`, NOT set the
  // top-level batchExhaustion, and render with the "child budget" label — distinct
  // from batch-gate skips (source:"batch"). This was the untested branch at the
  // `result.budget` slot-mapping in execute().
  let i = 0;
  const spawn = async (): Promise<SpawnSubagentResult> => {
    const idx = i++;
    if (idx === 1) {
      return {
        output: "",
        exitCode: 0,
        stderr: "",
        timedOut: false,
        budget: { kind: "tokens", limit: 1000, actual: 1500 },
      };
    }
    return { output: `out${idx}`, exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn });
  const res = await tool.execute(
    "call-childbudget",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const d = res.details;
  assert.equal(d.dispatched, 2, "both children ran (no batch gate tripped)");
  assert.equal(d.skipped, 1, "the per-child-budget abort counts as a skipped budget slot");
  assert.equal(d.budgetExhaustion, undefined, "per-child budget does NOT set the batch-level exhaustion");
  assert.equal((d.results[0] as { status: string }).status, "done");
  const slot1 = d.results[1] as { status: string; source?: string };
  assert.equal(slot1.status, "budget");
  assert.equal(slot1.source, "child", "slot source distinguishes a per-child abort from a batch-gate skip");
  assert.match(renderBatchResult(d), /child budget/, "rendering labels the per-child abort distinctly");
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
  assert.equal(seen[0].status, "done", "#0 marked terminal-done (not running, not gone)");
  assert.equal(inFlight.list().length, 0, "registry empty after the batch returns (whole-batch eviction)");
});

test("mid-batch throw: siblings drained, registry cleaned, no zombie children, execute fails loudly (P1)", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const dispatched: number[] = [];
  const spawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    dispatched.push(idx);
    if (idx === 1) throw new Error("boom");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await assert.rejects(
    tool.execute(
      "batch-mid",
      { tasks: [{ task: "#0" }, { task: "#1" }, { task: "#2" }], concurrency: 1 },
      NO_SIGNAL,
      undefined,
      NO_CTX,
    ),
    /boom/,
  );
  // The child AFTER the throwing one is never dispatched (batch aborted) —
  // pre-fix it spawned and its registry entry leaked (endBatch ran before the
  // orphan resolved → zombie child + leak).
  assert.deepEqual(dispatched, [0, 1], "children after the throwing child are not dispatched");
  // endBatch ran in the finally despite the throw — the registry is clean.
  assert.equal(inFlight.list().length, 0, "registry cleaned despite the mid-batch throw");
});

test("mid-batch throw at higher concurrency: in-flight sibling still settles; workers never orphan it (P1)", async () => {
  const inFlight = new SubagentInFlightRegistry();
  let spawn0Release: (() => void) | undefined;
  let spawn0Done: Promise<void> | undefined;
  const spawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    if (idx === 0) {
      // long-running child #0 stays in flight across child #1's throw — it
      // must still SETTLE (drained by allSettled) before execute() rejects.
      let resolve!: () => void;
      spawn0Done = new Promise<void>((r) => {
        resolve = r;
      });
      spawn0Release = resolve;
      await spawn0Done;
      return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
    }
    throw new Error("boom-1");
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  const executing = tool.execute(
    "batch-parallel",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 2 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  // Give #1 a chance to throw while #0 is still in flight.
  await new Promise((r) => setTimeout(r, 10));
  spawn0Release?.();
  await assert.rejects(executing, /boom-1/);
  assert.equal(inFlight.list().length, 0, "both children evicted (in-flight sibling drained, not orphaned)");
});

test("onUpdate emits a multi-line header + live table: `subagents · k/N running · Σtok · $Σ` then one row per child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const updates: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    updates.push(u.content.map((c) => c.text).join(""));
  };
  const spawn = async (opts: {
    task: string;
    onUsage?: (u: AgentUsage) => void;
    onHistory?: (h: { kind: string; toolName?: string; text?: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onUsage?.(U(500, 0.05));
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "r" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
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
  const firstHeader = first.split("\n")[0] ?? "";
  assert.match(firstHeader, /^subagents · \d+\/2 running/, "header shows `subagents · k/N running`");
  // child #0 already reported usage (500 tok) before this tick → aggregate present
  assert.match(firstHeader, /500 tok · \$0\.050/, "header carries the Σtok · $Σ aggregate (tokens first)");
  assert.ok(!firstHeader.includes("latest:"), "the old `latest:` label is gone from the header");
  assert.ok(first.includes("[0]"), "the live table row for child #0 is present (multi-line)");
});

test("runningUsage map is fed by onUsage and drives the live-header Σ across children", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const headers: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    headers.push(
      u.content
        .map((c) => c.text)
        .join("")
        .split("\n")[0] ?? "",
    );
  };
  let i = 0;
  const usages = [U(1000, 0.1), U(2000, 0.2)];
  const spawn = async (opts: {
    task: string;
    onUsage?: (u: AgentUsage) => void;
    onHistory?: (h: { kind: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    const idx = i++;
    opts.onUsage?.(usages[idx] ?? U(0, 0));
    // Fire onHistory so the live-header onUpdate actually emits — the live
    // header only renders via the onHistory→onUpdate path, so without a tick
    // `headers` stays empty and the Σ assertion has nothing to match.
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute(
    "batch-sig",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    onUpdate as never,
    NO_CTX,
  );
  const lastHeader = headers[headers.length - 1] ?? "";
  assert.match(lastHeader, /3000 tok · \$0\.300/, "Σ accumulates across both children's onUsage");
});

test("onUpdate is try/caught: a throwing buildLiveTable path never fails the child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  // Sabotage list() to throw mid-onUpdate; the child must still complete.
  const badList = () => {
    throw new Error("boom");
  };
  inFlight.list = badList as never;
  let completed = false;
  const spawn = async (opts: {
    task: string;
    onHistory?: (h: { kind: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  const res = await tool.execute("batch-throw", { tasks: [{ task: "#0" }] }, NO_SIGNAL, undefined, NO_CTX);
  completed = (res.details.results[0] as { status: string }).status === "done";
  assert.equal(completed, true, "child completed despite a throwing inFlight.list() during onUpdate");
});

// ── per-child mid-flight abort (Frontier A, Task 2) ──

/** Flush the event loop until `fn()` returns a truthy value (or throw after tries). */
async function waitFor<T>(fn: () => T | undefined | null, tries = 200): Promise<NonNullable<T>> {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor timed out");
}

/** Spawn that resolves on externalSignal abort for indexes in `blocking`; others
 *  return `normal` on the next tick. Mirrors spawnSubagent's abort return shape. */
function spawnBlockingOnAbort(blocking: Set<number>, normal: SpawnSubagentResult) {
  const calls: Array<{ task: string; externalSignal?: AbortSignal }> = [];
  const spawn = (opts: { task: string; externalSignal?: AbortSignal }): Promise<SpawnSubagentResult> =>
    new Promise((resolve) => {
      calls.push(opts);
      const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? calls.length - 1);
      if (!blocking.has(idx)) {
        setTimeout(() => resolve(normal), 0);
        return;
      }
      const sig = opts.externalSignal;
      if (!sig) {
        resolve(normal);
        return;
      }
      if (sig.aborted) {
        resolve({ output: "", exitCode: 124, stderr: "Subagent was aborted", timedOut: true });
        return;
      }
      sig.addEventListener(
        "abort",
        () => resolve({ output: "", exitCode: 124, stderr: "Subagent was aborted", timedOut: true }),
        { once: true },
      );
    });
  return { calls, spawn };
}

test("user per-child abort mid-batch → aborted slot; sibling unaffected; parent turn intact", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const f = spawnBlockingOnAbort(new Set([0]), { output: "sibling-ok", exitCode: 0, stderr: "", timedOut: false });
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn as never, inFlight, getMainModel: () => "p/m" });
  const parent = new AbortController(); // live turn, not aborted
  const p = tool.execute(
    "batch-abort",
    { tasks: [{ task: "#0 secret" }, { task: "#1" }], concurrency: 1 },
    parent.signal,
    undefined,
    NO_CTX,
  );
  // wait until child #0 is registered + blocking, then abort JUST it
  await waitFor(() => inFlight.get("batch-abort:0"));
  assert.equal(typeof inFlight.get("batch-abort:0")?.abort, "function", "abort lever wired on the child entry");
  inFlight.abort("batch-abort:0");
  const res = await p;
  const r = res.details.results;
  assert.equal((r[0] as { status: string }).status, "aborted");
  assert.ok((r[0] as { task: string }).task.includes("secret"), "aborted slot carries task preview");
  assert.equal((r[0] as { model: string }).model, "p/m");
  assert.ok((r[0] as { elapsedMs: number }).elapsedMs >= 0);
  assert.equal((r[1] as { status: string }).status, "done", "sibling kept running and completed");
  assert.equal(parent.signal.aborted, false, "parent turn NOT aborted (per-child isolation)");
});

test("fan-in: aborting the parent signal aborts all in-flight batch children (new — they used to ignore it)", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const f = spawnBlockingOnAbort(new Set([0, 1]), { output: "x", exitCode: 0, stderr: "", timedOut: false });
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn as never, inFlight });
  const parent = new AbortController();
  const p = tool.execute(
    "batch-fanin",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 2 },
    parent.signal,
    undefined,
    NO_CTX,
  );
  await waitFor(() => inFlight.list().length >= 1);
  parent.abort(); // whole-turn Esc
  const res = await p; // resolves — does NOT hang (children now see the signal)
  for (const slot of res.details.results) {
    assert.equal((slot as { status: string }).status, "timedout", "whole-turn abort → timedout, not aborted");
  }
});

test("renderBatchResult renders an aborted section; header counts aborted only when present (byte-stable)", () => {
  const withAborted = renderBatchResult({
    results: [
      { output: "hello", status: "done", index: 0, id: "a", task: "t", model: "m", elapsedMs: 10 },
      { output: "", status: "aborted", index: 1, id: "b", task: "u", model: "m", elapsedMs: 5 },
      null,
    ],
    dispatched: 2,
    skipped: 0,
    elapsedMs: 1500,
  });
  assert.match(withAborted, /1 ok · 1 aborted · 1 failed/, "header counts aborted distinctly");
  assert.match(withAborted, /\(b\) aborted[\s\S]*user-aborted mid-flight/, "aborted body line carries provenance");

  // byte-stability: no aborted slots → header is byte-identical (no aborted segment)
  const noAborted = renderBatchResult({
    results: [{ output: "hello", status: "done", index: 0, id: "a", task: "t", model: "m", elapsedMs: 10 }, null],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1500,
  });
  assert.match(noAborted, /^## subagents batch \(1 ok · 1 failed · 0 skipped\)/);
  assert.doesNotMatch(noAborted, /aborted/);
});

// ── renderSubagentsCall / renderSubagentsResult (pure helpers, themed strings) ──
// Identity theme so assertions see plain text.
const THEME = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as never;

test("renderSubagentsCall shows subagents ▸ N tasks · concurrency C ▸ first task preview", () => {
  const out = renderSubagentsCall(
    { tasks: [{ task: "audit the codebase" }, { task: "review PR" }], concurrency: 2 },
    THEME,
  );
  assert.ok(out.includes("subagents"));
  assert.ok(out.includes("2 tasks"));
  assert.ok(out.includes("concurrency 2"));
  assert.ok(out.includes("audit the codebase"));
});

test("renderSubagentsCall omits concurrency when undefined and task when empty", () => {
  const out = renderSubagentsCall({ tasks: [] }, THEME);
  assert.ok(out.includes("subagents"));
  assert.ok(out.includes("0 tasks"));
  assert.ok(!out.includes("concurrency"));
  // No task preview when empty
  assert.ok(!out.includes('"'));
});

test("renderSubagentsResult collapsed: header + per-child one-liners with badges, counts, task preview", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "hello",
        status: "done",
        id: "a",
        index: 0,
        task: "audit the security layer thoroughly",
        model: "x/flash",
        elapsedMs: 3500,
      },
      {
        output: "",
        status: "aborted",
        id: "b",
        index: 1,
        task: "review the PR for style issues",
        model: "x/flash",
        elapsedMs: 1200,
      },
      null as never,
      {
        status: "budget",
        source: "batch" as const,
        exhaustion: { kind: "tokens" as const, limit: 50000, actual: 70000 },
        id: "c",
        index: 3,
        task: "run the benchmarks on main",
        model: "x/flash",
        elapsedMs: 0,
      },
      { output: "ok", status: "timedout", index: 4, task: "generate docs", model: "y/gemma", elapsedMs: 30100 },
    ],
    dispatched: 3,
    skipped: 1,
    elapsedMs: 12350,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "ignored-model-text" }], details },
    { expanded: false },
    THEME,
  );
  // Header
  assert.match(collapsed, /subagents batch/);
  assert.match(collapsed, /2 ok/);
  assert.match(collapsed, /1 aborted/);
  assert.match(collapsed, /1 failed/);
  assert.match(collapsed, /1 skipped/);
  assert.match(collapsed, /12\.3s/);
  // Badges
  assert.match(collapsed, /✓ done/);
  assert.match(collapsed, /⊘ aborted/);
  assert.match(collapsed, /✗ failed/);
  assert.match(collapsed, /⛔ budget/);
  assert.match(collapsed, /⏱ timedout/);
  // Task previews (truncated)
  assert.ok(
    collapsed.includes("audit the security layer thoroughly") || collapsed.includes("audit the security layer"),
  );
  assert.ok(collapsed.includes("review the PR for style issues") || collapsed.includes("review the PR for"));
  // Model info (ticket 04 finding 5: shortened via shortModel on the collapsed line)
  assert.match(collapsed, /flash/);
  assert.match(collapsed, /gemma/);
  assert.ok(!collapsed.includes("x/flash"), "provider prefix dropped on the collapsed batch line");
  assert.ok(!collapsed.includes("y/gemma"), "provider prefix dropped on the collapsed batch line");
  // Elapsed times
  assert.match(collapsed, /3\.5s/);
  assert.match(collapsed, /30\.1s/);
  // Null slot
  assert.match(collapsed, /child failed/);
  // Ctrl-O hint
  assert.match(collapsed, /Ctrl-O to expand/);
  assert.match(collapsed, /subagents for detail/);
  // Shorter than expanded
  assert.ok(collapsed.length < 800, `collapsed is short (got ${collapsed.length})`);
});

test("renderSubagentsResult expanded: header + per-child full themed output", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "Full audit report\nLine two\nLine three",
        status: "done",
        id: "a",
        index: 0,
        task: "audit",
        model: "x/flash",
        elapsedMs: 3500,
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 3500,
  };
  const expanded = renderSubagentsResult(
    { content: [{ type: "text", text: "ignored" }], details },
    { expanded: true },
    THEME,
  );
  assert.match(expanded, /subagents batch/);
  assert.match(expanded, /### \[0\]/);
  assert.match(expanded, /\(a\) done/);
  assert.ok(expanded.includes("Full audit report"));
  assert.ok(expanded.includes("Line three"));
});

test("renderSubagentsResult collapsed: null slot renders as a terse failed line", () => {
  const details: SubagentsToolDetails = {
    results: [null],
    dispatched: 0,
    skipped: 0,
    elapsedMs: 10,
  };
  const out = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(out, /✗ failed/);
  assert.match(out, /child failed/);
});

test("renderSubagentsResult no details → dim raw text fallback", () => {
  const out = renderSubagentsResult({ content: [{ type: "text", text: "raw fallback" }] }, { expanded: false }, THEME);
  assert.equal(out, "raw fallback");
});

test("renderSubagentsResult isPartial+collapsed shows a compact single-line; expanded shows full", () => {
  const text = "subagents · 2/4 running · latest: read src/foo.ts";
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text }] },
    { expanded: false, isPartial: true },
    THEME,
  );
  assert.ok(collapsed.split("\n").length === 1, "collapsed is a single line");
  const expanded = renderSubagentsResult(
    { content: [{ type: "text", text }] },
    { expanded: true, isPartial: true },
    THEME,
  );
  assert.equal(expanded, text, "expanded shows the full streaming text");
});

// --- ticket 04 finding 2: batch child fallback stores AND renders the ACTUAL model ---
// #1103's actual-model capture never reached the batch tool — a batch child that
// requested e.g. anthropic/claude-opus-4-1 and fell back to zai/glm-5.2 rendered
// the REQUESTED opus under a ✓ done badge, with no → / requestedModel anywhere.
// Mirrors the singular tool: onModelResolved captures the ACTUAL model,
// onModelFallback captures the requested spec + marks fellBack; the slot stores
// the actual model + audit fields, and the collapsed renderer shows `requested → actual`.

test("ticket 04 / finding 2: a batch child that falls back stores the ACTUAL model + requestedModel/fellBack in the slot", async () => {
  const spawn = async (opts: {
    onModelResolved?: (id: string) => void;
    onModelFallback?: (spec: string) => void;
  }): Promise<SpawnSubagentResult> => {
    // Simulate fallback: onModelFallback fires first, then onModelResolved with the actual.
    opts.onModelFallback?.("anthropic/claude-opus-4-1");
    opts.onModelResolved?.("zai/glm-5.2");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never });
  const res = await tool.execute(
    "batch-fallback",
    { tasks: [{ task: "#0", model: "anthropic/claude-opus-4-1" }] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const slot = res.details.results[0] as {
    model: string;
    requestedModel?: string;
    fellBack?: boolean;
    status: string;
  };
  assert.equal(slot.status, "done");
  assert.equal(slot.model, "zai/glm-5.2", "slot.model = the ACTUAL model that ran (not the requested opus)");
  assert.equal(slot.requestedModel, "anthropic/claude-opus-4-1", "requestedModel = the audit spec that fell back");
  assert.equal(slot.fellBack, true, "fellBack is marked");
});

test("ticket 04 / finding 2: a batch child with NORMAL resolution stores the resolved model and NO audit fields", async () => {
  const spawn = async (opts: { onModelResolved?: (id: string) => void }): Promise<SpawnSubagentResult> => {
    opts.onModelResolved?.("zai/glm-5.2");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never });
  const res = await tool.execute(
    "batch-normal",
    { tasks: [{ task: "#0", model: "zai/glm-5.2" }] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const slot = res.details.results[0] as {
    model: string;
    requestedModel?: string;
    fellBack?: boolean;
  };
  assert.equal(slot.model, "zai/glm-5.2", "normal resolution → slot.model = the resolved model");
  assert.equal(slot.requestedModel, undefined, "no audit field when there was no fallback");
  assert.equal(slot.fellBack, undefined, "no fellBack when there was no fallback");
});

test("ticket 04 / finding 2 + 5: collapsed batch renderer shows `requested → actual` (shortened) on a fallback child", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "ok",
        status: "done",
        index: 0,
        task: "audit the display code",
        model: "zai/glm-5.2",
        requestedModel: "anthropic/claude-opus-4-1",
        fellBack: true,
        elapsedMs: 1000,
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1000,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "ignored" }], details },
    { expanded: false },
    THEME,
  );
  // The actual model is shown under a ✓ done badge (NOT the stale requested opus).
  assert.match(collapsed, /✓ done/);
  assert.ok(collapsed.includes("glm-5.2"), "the ACTUAL model is shown");
  // The requested → actual fallback indicator is rendered, both shortened.
  assert.match(collapsed, /claude-opus-4-1 → glm-5\.2/);
  // The full provider-prefixed ids do NOT appear (Finding 5 shortening).
  assert.ok(!collapsed.includes("anthropic/claude-opus-4-1"), "requested id is shortened on the collapsed line");
  assert.ok(!collapsed.includes("zai/glm-5.2"), "actual id is shortened on the collapsed line");
});

// --- ticket 05 / finding 6: collapsed batch per-slot badges are padded to a fixed width ---
// The badge text width varies by terminal status (✓ done=6 / ⏱ timedout=10 /
// ⛔ budget=8 / ⊘ aborted=9 / ✗ failed=8). Without padding, the unequal widths
// leave the `model · elapsed · task` columns drifting between rows. Pad each
// badge to the widest so a quick vertical scan of an N-children batch aligns.

const BATCH_BADGE_TEXTS = ["✓ done", "⏱ timedout", "⛔ budget", "⊘ aborted", "✗ failed"] as const;

test("ticket 05 / finding 6: collapsed batch per-slot badges are padded to a fixed width so columns align", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "ok", status: "done", index: 0, task: "t-done", model: "x/flash", elapsedMs: 1000 },
      { output: "", status: "timedout", index: 1, task: "t-timedout", model: "x/flash", elapsedMs: 30000 },
      { output: "", status: "aborted", index: 2, task: "t-aborted", model: "x/flash", elapsedMs: 500 },
      {
        status: "budget",
        source: "batch" as const,
        exhaustion: { kind: "tokens" as const, limit: 1, actual: 2 },
        index: 3,
        task: "t-budget",
        model: "x/flash",
        elapsedMs: 0,
      },
      null, // failed — no model column (renders `(child failed)`); excluded from the model-offset assertion
    ],
    dispatched: 3,
    skipped: 1,
    elapsedMs: 31500,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  // The 4 non-failed slots each render a model column; the failed slot does not.
  const slotLines = collapsed.split("\n").filter((l) => l.includes("flash"));
  assert.equal(slotLines.length, 4, "the 4 non-failed slots each render a model column");

  // The model token starts at the SAME offset on every slot line — the badges
  // are padded to a fixed width so the `model · elapsed · task` columns line up
  // regardless of terminal status.
  const offsets = slotLines.map((l) => l.indexOf("flash"));
  assert.ok(
    offsets.every((o) => o === offsets[0]),
    `model column starts at a consistent offset across rows (got ${JSON.stringify(offsets)})`,
  );

  // Equal offsets only prove alignment when the natural widths differ — and they
  // do (✓ done=6 vs ⏱ timedout=10). Verify the SHORT `✓ done` badge was actually
  // PADDED: there must be MORE whitespace between `done` and the model than the
  // bare 2-space column separator (i.e. ≥1 pad space).
  const doneLine = slotLines.find((l) => l.includes("✓ done")) ?? "";
  assert.ok(doneLine, "the done slot line is present");
  const gap = doneLine.slice(doneLine.indexOf("done") + "done".length, doneLine.indexOf("flash"));
  assert.ok(
    gap.length > 2,
    `✓ done (natural width 6) is padded to match the widest badge (gap between done and model="${gap}")`,
  );

  // Every badge the renderer can emit is present in the collapsed output.
  for (const badge of BATCH_BADGE_TEXTS) {
    assert.ok(collapsed.includes(badge), `collapsed renders the ${badge} badge`);
  }
});

// ── #03 impossible-tool preflight (ABORT, pre-spawn) — plural mirror ──

test("#03 plural mirror: a child missing a required tool is skipped (null), spawn not called for it", async () => {
  const calls: unknown[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  const res = await tool.execute(
    "batch-pf",
    {
      tasks: [
        { task: "needs memory", tools: ["read"], requiredTools: ["memory"] }, // skipped
        { task: "fine", tools: ["read"], requiredTools: ["read"] }, // dispatched
      ],
    } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  assert.equal(calls.length, 1, "only the satisfiable child is dispatched");
  assert.equal(res.details.results[0], null, "missing-tool child → null slot");
  assert.notEqual(res.details.results[1], null);
});

// ── Task 2: pure render helpers (formatUsage / formatModelSeg / formatSlotMeta / sumUsage) ──
// Shared by the done + live render rewrites (Tasks 3-6). formatSlotMeta +
// formatModelSeg mirror the single subagent card's meta (fallback-aware).
// sumUsage feeds both the done-header and live-header usage aggregates.

const U = (total: number, cost: number): AgentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost,
});

test("formatUsage: empty when no usage or zero total; else ` · $cost · Ntok` (3-decimal cost)", () => {
  assert.equal(formatUsage(undefined), "");
  assert.equal(formatUsage(U(0, 0)), "");
  assert.equal(formatUsage(U(15715, 0.0004)), " · $0.000 · 15715 tok");
  assert.equal(formatUsage(U(1000, 0.5)), " · $0.500 · 1000 tok");
});

test("formatModelSeg: shortens provider prefix; `requested → actual` on fallback; default fallback", () => {
  assert.equal(formatModelSeg("zai/glm-5.2"), "glm-5.2");
  assert.equal(formatModelSeg("tier:small"), "tier:small");
  assert.equal(
    formatModelSeg("anthropic/claude-opus-4-1", "anthropic/claude-opus-4-1", true),
    "claude-opus-4-1 → claude-opus-4-1",
  );
  assert.equal(formatModelSeg("zai/glm-5.2", "anthropic/claude-opus-4-1", true), "claude-opus-4-1 → glm-5.2");
  assert.equal(formatModelSeg(""), "default");
});

test("formatSlotMeta: themed `model · elapsed · usage`; defensive on missing usage", () => {
  const meta = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500, usage: U(15715, 0.0004) }, THEME);
  assert.equal(meta, "glm-5.2 · 34.5s · $0.000 · 15715 tok");
  const noUsage = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500 }, THEME);
  assert.equal(noUsage, "glm-5.2 · 34.5s");
  const fb = formatSlotMeta(
    {
      model: "zai/glm-5.2",
      requestedModel: "anthropic/claude-opus-4-1",
      fellBack: true,
      elapsedMs: 1000,
      usage: U(10, 0.001),
    },
    THEME,
  );
  assert.equal(fb, "claude-opus-4-1 → glm-5.2 · 1.0s · $0.001 · 10 tok");
});

test("sumUsage: sums total+cost across an iterable; empty → zeros", () => {
  assert.deepEqual(sumUsage([]), { total: 0, cost: 0 });
  assert.deepEqual(sumUsage([U(100, 0.1), U(200, 0.2)]), { total: 300, cost: 0.30000000000000004 });
  assert.deepEqual(sumUsage(new Map([["a", U(50, 0.05)]]).values()), { total: 50, cost: 0.05 });
});

// ── Task 3: done header Σ + done-collapsed per-slot meta ──
// The done-state collapsed card now (a) appends ` · $Σ · Σtok` to the header
// when aggregate slot usage > 0, and (b) renders each per-slot line as
// `[i] (id) badge · <formatSlotMeta> · "task"` (formatSlotMeta = model · elapsed
// · usage; quoted task preview). Mirrors the single subagent card's meta.

test("done header appends aggregate ` · $Σ · Σtok` when slots carry usage", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "a", status: "done", index: 0, task: "t0", model: "zai/glm-5.2", elapsedMs: 1000, usage: U(1000, 0.1) },
      { output: "b", status: "done", index: 1, task: "t1", model: "zai/glm-5.2", elapsedMs: 2000, usage: U(2000, 0.2) },
      null,
    ],
    dispatched: 2,
    skipped: 0,
    elapsedMs: 3000,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  assert.match(collapsed, /— 3\.0s · \$0\.300 · 3000 tok/);
});

test("done header omits the aggregate suffix when no slot carries usage (byte-stable)", () => {
  const details: SubagentsToolDetails = {
    results: [{ output: "a", status: "done", index: 0, task: "t0", model: "zai/glm-5.2", elapsedMs: 1000 }],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1000,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  assert.match(collapsed, /— 1\.0s$/m); // no trailing ` · $… · … tok`
  assert.doesNotMatch(collapsed, /tok/);
});

test('done collapsed: per-slot line shows `badge · model · elapsed · $cost · Ntok · "task"` (with usage)', () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "ok",
        status: "done",
        index: 0,
        id: "alpha",
        task: "audit the parser",
        model: "zai/glm-5.2",
        elapsedMs: 34500,
        usage: U(15715, 0.0004),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 34500,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  const slot0 = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(slot0, /\(alpha\)/);
  assert.match(slot0, /✓ done/); // fixed-width badge kept
  assert.match(slot0, /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/);
  assert.match(slot0, /"audit the parser"/); // quoted task preview
  assert.ok(!slot0.includes("zai/glm-5.2"), "provider prefix dropped on the collapsed line");
});

test("done collapsed: fallback slot shows `requested → actual` in the meta segment", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "ok",
        status: "done",
        index: 0,
        task: "t",
        model: "zai/glm-5.2",
        requestedModel: "anthropic/claude-opus-4-1",
        fellBack: true,
        elapsedMs: 1000,
        usage: U(10, 0.001),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1000,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  assert.match(collapsed, /claude-opus-4-1 → glm-5\.2 · 1\.0s · \$0\.001 · 10 tok/);
});

test('done collapsed: per-slot meta degrades (no usage → `model · elapsed · "task"`)', () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "", status: "aborted", index: 0, id: "x", task: "t-aborted", model: "zai/glm-5.2", elapsedMs: 500 },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 500,
  };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  const slot0 = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(slot0, /⊘ aborted/);
  assert.match(slot0, /glm-5\.2 · 0\.5s · "t-aborted"/);
  assert.doesNotMatch(slot0, /tok/);
});

test("done collapsed: null (failed) slot still renders the terse failed line (no meta)", () => {
  const details: SubagentsToolDetails = { results: [null], dispatched: 0, skipped: 0, elapsedMs: 10 };
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: false },
    THEME,
  );
  const line = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(line, /✗ failed/);
  assert.match(line, /child failed/);
  assert.doesNotMatch(line, /· .*s ·/);
});

// ── Task 4: done-expanded per-child meta line ──
// The expanded branch prepends a `model · elapsed · $cost · Ntok` meta line
// above each child's output (done/timedout/aborted/budget). Null (failed)
// slots are unchanged. Mirrors the single subagent card's meta placement.

test("done expanded: prepends a `model · elapsed · $cost · Ntok` meta line above each child output", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "Full audit report\nLine two",
        status: "done",
        id: "a",
        index: 0,
        task: "audit",
        model: "zai/glm-5.2",
        elapsedMs: 34500,
        usage: U(15715, 0.0004),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 34500,
  };
  const expanded = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: true },
    THEME,
  );
  const lines = expanded.split("\n");
  // NOTE (T4 brief fix): meta sits at lines[3], not lines[1]. Expanded layout is
  // `header\n\n### [i] (id) status\n<meta>\n<output>` — the brief's verbatim
  // `lines[1]` pointed at the blank line between the batch header and the body.
  assert.match(
    lines[3] ?? "",
    /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/,
    "meta line sits directly under the ### header",
  );
  assert.ok(expanded.includes("Full audit report"), "output preserved under the meta line");
});

test("done expanded: budget + aborted slots get a meta line too (no usage → model · elapsed only)", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        status: "budget",
        source: "child" as const,
        exhaustion: { kind: "tokens" as const, limit: 1000, actual: 2000 },
        index: 0,
        task: "t-budget",
        model: "zai/glm-5.2",
        elapsedMs: 800,
      },
      { output: "", status: "aborted", index: 1, task: "t-aborted", model: "zai/glm-5.2", elapsedMs: 300 },
    ],
    dispatched: 2,
    skipped: 1,
    elapsedMs: 1100,
  };
  const expanded = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: true },
    THEME,
  );
  // NOTE (T4 brief fix): order reversed. Layout is `### [i] skipped — ...\n<meta>`
  // (status word in the ### header precedes the meta), so the brief's verbatim
  // `meta THEN status` regexes never matched. `status THEN meta` is the spec'd order.
  assert.match(expanded, /skipped[\s\S]*glm-5\.2 · 0\.8s/);
  assert.match(expanded, /aborted[\s\S]*glm-5\.2 · 0\.3s/);
});

test("done expanded: null (failed) slot has NO meta line (unchanged failed body)", () => {
  const details: SubagentsToolDetails = {
    results: [null, { output: "ok", status: "done", index: 1, task: "t", model: "zai/glm-5.2", elapsedMs: 100 }],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 100,
  };
  const expanded = renderSubagentsResult(
    { content: [{ type: "text", text: "x" }], details },
    { expanded: true },
    THEME,
  );
  const failedBlock = expanded.split("### [1]")[0];
  assert.match(failedBlock, /### \[0\] failed/);
  assert.doesNotMatch(failedBlock, /· .*s ·/);
});

const NOW = 10_000;

function live(over: Partial<InFlightSubagent> & { id: string }): InFlightSubagent {
  return { taskPreview: "pt", startedAt: 0, ...over } as InFlightSubagent;
}

test("childDispatchIndex: trailing :N from a batch child runId; NaN-resistant", () => {
  assert.equal(childDispatchIndex("batch-call:3"), 3);
  assert.equal(childDispatchIndex("wf:abc:0"), 0);
  assert.equal(childDispatchIndex("no-colon"), NaN);
});

test("buildLiveTable: empty entries → empty string (header-only)", () => {
  assert.equal(buildLiveTable([], NOW), "");
});

test("buildLiveTable: one running child → `[i] slot ⏱ liveElapsed · currentAction`", () => {
  const rows = buildLiveTable(
    [live({ id: "batch-call:0", model: "zai/glm-5.2", startedAt: 6550, status: "running" })],
    NOW,
  );
  assert.equal(rows, "[0] glm-5.2 ⏱ 3.5s · pt");
});

test("buildLiveTable: completed child shows ✓ glyph + FROZEN elapsed (endedAt stamp)", () => {
  // startedAt 9000, endedAt 9500 → frozen 0.5s even though `now` is 10_000
  // (the pre-fix code ticked to 1.0s and kept growing — this codifies the fix).
  const rows = buildLiveTable(
    [live({ id: "batch-call:1", model: "zai/glm-5.2", startedAt: 9000, endedAt: 9500, status: "completed" })],
    NOW,
  );
  assert.equal(rows, "[1] glm-5.2 ✓ 0.5s · pt");
});

test("buildLiveTable: a completed child's elapsed no longer grows as now advances; running rows still tick", () => {
  const child = live({ id: "batch-call:0", model: "zai/glm-5.2", startedAt: 9000, endedAt: 9500, status: "completed" });
  const at10k = buildLiveTable([child], 10_000);
  const at60k = buildLiveTable([child], 60_000);
  const at120k = buildLiveTable([child], 120_000);
  assert.equal(at10k, "[0] glm-5.2 ✓ 0.5s · pt");
  assert.equal(at60k, at10k, "frozen — advancing now does not grow a terminal row's elapsed");
  assert.equal(at120k, at10k, "still frozen much later");
  // Running rows keep ticking with now (regression guard).
  const runner = live({ id: "batch-call:1", model: "zai/glm-5.2", startedAt: 9000, status: "running" });
  assert.equal(buildLiveTable([runner], 10_000), "[1] glm-5.2 ⏱ 1.0s · pt");
  assert.equal(buildLiveTable([runner], 60_000), "[1] glm-5.2 ⏱ 51.0s · pt");
});

test("execute: a completed child's elapsed freezes across two onUpdate renders (no more ticking)", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const updates: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    updates.push(u.content.map((c) => c.text).join(""));
  };
  // Freeze/advance wall-clock: each buildLiveTable inside onUpdate reads
  // Date.now() at emit time, so bumping fakeNow between ticks proves the
  // frozen value (the pre-fix code re-ticked per render).
  const realNow = Date.now;
  let fakeNow = 100_000;
  Date.now = () => fakeNow;
  const tick = (
    opts: { onHistory?: (h: { kind: string; toolName?: string; text?: string }[]) => void },
    lines: string[],
  ) => {
    opts.onHistory?.(lines);
  };
  const spawn = async (opts: {
    task: string;
    onHistory?: (h: { kind: string; toolName?: string; text?: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    tick(opts, [{ role: "assistant", kind: "toolCall", toolName: "read", text: "r" }]); // running tick
    inFlight.markCompleted("batch-frozen:0");
    fakeNow += 60_000;
    // Both post-completion ticks carry the SAME history so only the elapsed
    // column can differ — proving the freeze (the action text stays identical).
    tick(opts, [{ role: "assistant", kind: "toolCall", toolName: "grep", text: "g" }]); // completed tick #1
    fakeNow += 60_000;
    tick(opts, [{ role: "assistant", kind: "toolCall", toolName: "grep", text: "g" }]); // completed tick #2
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  try {
    const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
    await tool.execute("batch-frozen", { tasks: [{ task: "#0" }] }, NO_SIGNAL, onUpdate as never, NO_CTX);
  } finally {
    Date.now = realNow;
  }
  // The last two updates are both AFTER completion (with 60s of wall-clock
  // between them) — their [0] rows must be byte-identical (frozen elapsed).
  const completedRows = updates.filter((u) => u.includes("✓")).map((u) => u.split("\n").slice(1).join("\n"));
  assert.ok(completedRows.length >= 2, "at least two post-completion onUpdate renders");
  const a = completedRows[completedRows.length - 2] ?? "";
  const b = completedRows[completedRows.length - 1] ?? "";
  assert.ok(a && b, "both post-completion rows captured");
  assert.equal(b, a, "elapsed frozen — identical row across renders 60s apart");
});

test("buildLiveTable: fallback child shows `requested → actual` slot", () => {
  const rows = buildLiveTable(
    [
      live({
        id: "batch-call:0",
        model: "anthropic/claude-opus-4-1",
        resolvedModel: "zai/glm-5.2",
        requestedModel: "anthropic/claude-opus-4-1",
        fellBack: true,
        startedAt: 9500,
        status: "running",
      }),
    ],
    NOW,
  );
  assert.equal(rows, "[0] claude-opus-4-1 → glm-5.2 ⏱ 0.5s · pt");
});

test("buildLiveTable: currentAction comes from summarizeLatestAction(history); falls back to task preview", () => {
  const withHist = buildLiveTable(
    [
      live({
        id: "batch-call:0",
        model: "zai/glm-5.2",
        startedAt: 9000,
        history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/a.ts"}' }],
      }),
    ],
    NOW,
  );
  assert.match(withHist, /\[0\] glm-5\.2 ⏱ 1\.0s · .+/);
  assert.notEqual(withHist, "[0] glm-5.2 ⏱ 1.0s · pt", "history-derived action replaces the task-preview fallback");
});

test("buildLiveTable: sorted ascending by dispatch index; defaults to Date.now()", () => {
  const rows = buildLiveTable([
    live({ id: "batch-call:2", model: "zai/glm-5.2", startedAt: 0, status: "running" }),
    live({ id: "batch-call:0", model: "zai/glm-5.2", startedAt: 0, status: "running" }),
    live({ id: "batch-call:1", model: "zai/glm-5.2", startedAt: 0, status: "running" }),
  ]);
  const idxs = rows.split("\n").map((l) => l.slice(1, 2));
  assert.deepEqual(idxs, ["0", "1", "2"]);
});
