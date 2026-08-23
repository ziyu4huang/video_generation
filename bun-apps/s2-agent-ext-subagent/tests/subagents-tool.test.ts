import { test } from "bun:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  AgentDefinition,
  AgentUsage,
  RunView,
  SpawnSubagentOptions,
  SpawnSubagentResult,
  SubagentRunPersistence,
  SubagentRunRecord,
} from "@repo/s2-agent-core-runtime";
import {
  DEFAULT_BATCH_CONCURRENCY,
  loadAgentRegistry,
  MAX_BATCH_TASKS,
  MAX_CONCURRENCY,
  SubagentInFlightRegistry,
} from "@repo/s2-agent-core-runtime";
import { ComposerComponent } from "../src/composer-component.js";
import { createSubagentsTool as fromIndex } from "../src/index.js";
import type { SubagentsToolDetails } from "../src/subagents-tool.js";
import {
  buildLiveTable,
  childDispatchIndex,
  clampConcurrency,
  createSubagentsTool,
  formatSlotMeta,
  formatUsage,
  liveProgressLineBudget,
  mergeReadOnlyExclusion,
  READ_ONLY_EXCLUDED,
  renderBatchResult,
  renderSubagentsCall,
  renderSubagentsResult,
  sumUsage,
} from "../src/subagents-tool.js";
import { budgetAbort, failed, ok, timedout, turnsAbort } from "./_spawn-result.js";

test("createSubagentsTool has name 'list_subagents' + executionMode 'sequential'", () => {
  const tool = createSubagentsTool();
  assert.equal(tool.name, "list_subagents");
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

test("mergeReadOnlyExclusion forwards retryOnTransient so a batch caller can turn retry OFF", () => {
  // Batch children always retried once (spawnSubagent defaults it on) while the
  // batch surface offered no way to say otherwise — the singular tool did. The
  // knob now exists on both, and omitting it still means "retry" (undefined →
  // spawnSubagent's `!== false` default).
  assert.equal(
    mergeReadOnlyExclusion({ task: "t", retryOnTransient: false }, { defaultCwd: "/repo" }).retryOnTransient,
    false,
  );
  assert.equal(mergeReadOnlyExclusion({ task: "t" }, { defaultCwd: "/repo" }).retryOnTransient, undefined);
});

test("ticket 04: ONE shared git snapshot prefixes every batch child's task; context 'none' skips capture", async () => {
  const calls: SpawnSubagentOptions[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return ok("ok");
  };
  let snapshotCalls = 0;
  const gitSnapshotOps = {
    async snapshot(cwd: string) {
      snapshotCalls++;
      assert.equal(cwd, "/r");
      return { branch: "## main...origin/main", head: "abc123 last commit", statusLines: ["M src/a.ts"] };
    },
  };
  const tool = createSubagentsTool({ spawn: spawn as never, cwd: "/r", gitSnapshotOps: gitSnapshotOps as never });
  await tool.execute(
    "batch-ctx",
    { tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  // ONE snapshot for the whole batch (map D5) — not one per child.
  assert.equal(snapshotCalls, 1);
  // Every child's task prefixes the IDENTICAL block (shared spawn-time state).
  const prefixes = calls.map((o) => (o.task as string).split("\n\n")[0]);
  assert.equal(new Set(prefixes).size, 1, "all children share one block");
  assert.match(prefixes[0] as string, /Startup context/);
  assert.match(prefixes[0] as string, /## main\.\.\.origin\/main/);
  assert.match(prefixes[0] as string, /HEAD: abc123 last commit/);
  // Batch default is MINIMAL: no porcelain body.
  for (const [i, o] of calls.entries()) {
    assert.doesNotMatch(o.task as string, /M src\/a\.ts/);
    // The raw task survives after the block (each child keeps its own input).
    assert.ok((o.task as string).includes(`\n\n${["a", "b", "c"][i]}`), `task ${i} keeps its raw input`);
  }

  // context "none": no snapshot, no block — spawned task byte-identical to input.
  calls.length = 0;
  snapshotCalls = 0;
  await tool.execute(
    "batch-ctx-none",
    { tasks: [{ task: "x" }], context: "none" } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  assert.equal(snapshotCalls, 0);
  // No startup block; the abort-safety footer may still ride (pre-existing
  // recon-envelope behavior, not this ticket's concern).
  assert.ok((calls[0]?.task as string).startsWith("x"));
  assert.doesNotMatch(calls[0]?.task as string, /Startup context/);
});

test("#01 plural mirror: per-child tier default applied when tokenBudget omitted", async () => {
  const calls: SpawnSubagentOptions[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return ok("ok");
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  await tool.execute(
    "batch-bud",
    {
      tasks: [
        // H3: explicit maxTurns keeps the role-aware recon envelope off so the
        // tier default (the thing under test) supplies the budget.
        { task: "research", tier: "small", maxTurns: 6 },
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
    return ok("ok");
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  await tool.execute(
    "batch-maxturns",
    {
      // H3: an explicit timeoutMs on "uncapped" opts out of the role-aware
      // recon envelope, so omitted maxTurns stays genuinely unset.
      tasks: [
        { task: "capped", maxTurns: 4 },
        { task: "uncapped", timeoutMs: 45_000 },
      ],
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
    if (idx === 1) return turnsAbort({ maxTurns: 5, turnsUsed: 5 });
    return ok(`out${idx}`);
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
  const f = fakeSpawnByIndex([ok("A"), ok("B"), ok("C")]);
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
      return ok("ok");
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
  const f = fakeSpawnByIndex([ok("ok"), failed("boom")]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn });
  const res = await tool.execute("call-2", { tasks: [{ task: "#0" }, { task: "#1" }] }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.results[0] && (res.details.results[0] as { status: string }).status, "done");
  assert.equal(res.details.results[1], null);
});

test("each completed slot carries task/model/elapsedMs; renderBatchResult is unchanged", async () => {
  // Generic output independent of the task text, so we can prove the task label
  // and model do NOT leak into the model-facing rendered text.
  const spawn = async (_opts: { task: string }) => ok("child-output", { usage: { total: 100, cost: 0.001 } as never });
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
    spawn: async () => ok(),
  });
  const res = await tool.execute("call-3", { tasks: [] }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(res.content[0].text, /tasks must be a non-empty array/i);
});

test("execute rejects an over-limit tasks array (MAX_BATCH_TASKS + 1) with an actionable message", async () => {
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: async () => ok(),
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
    return ok(`out${idx}`, {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.total, cost: u.cost },
    });
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
    if (idx === 1) return budgetAbort({ kind: "tokens", limit: 1000, actual: 1500 });
    return ok(`out${idx}`);
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
      seenDuringRun = inFlight.views().length;
      return ok("A");
    },
    () => {
      seenDuringRun = Math.max(seenDuringRun, inFlight.views().length);
      return ok("B");
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
  assert.equal(inFlight.views().length, 0);
  // while running, both children were registered
  assert.ok(seenDuringRun >= 1, "at least one child was in-flight during the run");
  // one persistence record per dispatched child
  assert.equal(persistence.saved.length, 2);
  assert.equal(persistence.saved[0].task, "#0");
  assert.equal(persistence.saved[0].status, "done");
});

test("a failed child is not persisted; a gate-skipped child is not persisted", async () => {
  const f = fakeSpawnByIndex([
    failed("x"), // failed
    ok("ok"), // done, trips gate
    ok("ok"), // skipped by gate
  ]);
  const persistence = memPersistence();
  // give the done child heavy usage so the gate trips after it
  // (re-use the usage fake by wrapping)
  const wrappedSpawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const r = await f.spawn(opts);
    if (!r.failure) return { ...r, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 60000, cost: 0 } };
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
  assert.equal(fromIndex().name, "list_subagents");
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
    opts.onModelResolved?.("google/gemma-4-12b");
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    const entry = inFlight.view(`batch-call:${idx}`);
    captured.push({
      id: `batch-call:${idx}`,
      batchId: entry?.batchId,
      resolved: entry?.modelSeg,
      historyLen: entry?.history.length ?? 0,
    });
    return ok("ok");
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
    assert.equal(c.resolved, "gemma-4-12b", "onModelResolved forwarded → modelSeg shows the resolved model");
    assert.equal(c.historyLen, 1, "onHistory forwarded → history stored");
  }
  assert.equal(inFlight.views().length, 0, "registry empty after the batch completes");
});

test("a child hitting its own per-child budget renders as 'child budget' (source: child)", async () => {
  const spawn = async (): Promise<SpawnSubagentResult> =>
    budgetAbort({ kind: "tokens", limit: 100, actual: 200 }, "out");
  const tool = createSubagentsTool({ cwd: "/repo", spawn });
  const res = await tool.execute("call-child-budget", { tasks: [{ task: "#0" }] }, NO_SIGNAL, undefined, NO_CTX);
  const slot = res.details.results[0];
  assert.equal((slot as { status: string }).status, "budget");
  assert.equal((slot as { source: string }).source, "child");
  assert.match(res.content[0].text, /child budget: tokens 200 > 100/);
});

test("batch keeps a completed child (status=done) mid-run; evicts the whole batch on return", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const seen: { id: string; status?: string; present: boolean }[] = [];
  const spawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    // child #0 finishes first (concurrency 1 → strict order): by the time #1 runs,
    // #0 must still be present in the registry, marked terminal (NOT evicted).
    if (idx === 1) {
      const c0 = inFlight.view("batch-call:0");
      seen.push({ id: "batch-call:0", status: c0?.status, present: !!c0 });
    }
    return ok("ok");
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
  assert.equal(inFlight.views().length, 0, "registry empty after the batch returns (whole-batch eviction)");
});

test("mid-batch throw: siblings drained, registry cleaned, no zombie children, execute fails loudly (P1)", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const dispatched: number[] = [];
  const spawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    dispatched.push(idx);
    if (idx === 1) throw new Error("boom");
    return ok("ok");
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
  assert.equal(inFlight.views().length, 0, "registry cleaned despite the mid-batch throw");
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
      return ok("ok");
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
  assert.equal(inFlight.views().length, 0, "both children evicted (in-flight sibling drained, not orphaned)");
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
    return ok("ok");
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
    return ok("ok");
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
  // Sabotage views() to throw mid-onUpdate; the child must still complete.
  const badViews = () => {
    throw new Error("boom");
  };
  inFlight.views = badViews as never;
  let completed = false;
  const spawn = async (opts: {
    task: string;
    onHistory?: (h: { kind: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    return ok("ok");
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  const res = await tool.execute("batch-throw", { tasks: [{ task: "#0" }] }, NO_SIGNAL, undefined, NO_CTX);
  completed = (res.details.results[0] as { status: string }).status === "done";
  assert.equal(completed, true, "child completed despite a throwing inFlight.views() during onUpdate");
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
        resolve(timedout("Subagent was aborted"));
        return;
      }
      sig.addEventListener("abort", () => resolve(timedout("Subagent was aborted")), { once: true });
    });
  return { calls, spawn };
}

test("user per-child abort mid-batch → aborted slot; sibling unaffected; parent turn intact", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const f = spawnBlockingOnAbort(new Set([0]), ok("sibling-ok"));
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
  await waitFor(() => inFlight.view("batch-abort:0"));
  assert.equal(inFlight.view("batch-abort:0")?.abortable, true, "abort lever wired on the child entry");
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
  const f = spawnBlockingOnAbort(new Set([0, 1]), ok("x"));
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn as never, inFlight });
  const parent = new AbortController();
  const p = tool.execute(
    "batch-fanin",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 2 },
    parent.signal,
    undefined,
    NO_CTX,
  );
  await waitFor(() => inFlight.views().length >= 1);
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

test("subagents renderCall composes at render width", () => {
  const tool = createSubagentsTool();
  const long = "z".repeat(70); // long first task: preview truncation is observable
  const comp = tool.renderCall?.(
    { tasks: [{ task: `audit the batch width ladder ${long}` }, { task: "review PR" }], concurrency: 2 },
    THEME,
    { toolCallId: "tc-batch" } as never,
  );
  assert.ok(comp instanceof ComposerComponent);
  for (const line of comp.render(40)) {
    assert.ok(visibleWidth(line) <= 40, `width 40 overflow: ${visibleWidth(line)}`);
  }
  // The first-task preview keeps more of the long task at the wide render.
  const zRun = (s: string) => [...s].filter((c) => c === "z").length;
  assert.ok(zRun(comp.render(200).join("\n")) > zRun(comp.render(40).join("\n")));
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

test("renderSubagentsResult isPartial+collapsed keeps a short feed intact (no truncation); expanded shows full", () => {
  const text = "subagents · 2/4 running · latest: read src/foo.ts";
  const collapsed = renderSubagentsResult(
    { content: [{ type: "text", text }] },
    { expanded: false, isPartial: true },
    THEME,
  );
  // A feed within the live-line budget renders verbatim — one line in, one line out.
  assert.equal(collapsed, text, "collapsed shows the single-line feed as-is");
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
    return ok("ok");
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
    return ok("ok");
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
  // Settled slots have no RunView (endBatch evicted the registry), so the meta
  // segment degrades to shortModel(slot.model) — the fallback indicator itself
  // now lives only in RunView.modelSeg (live table) + the slot audit fields.
  assert.match(collapsed, /glm-5\.2 · 1\.0s/);
  assert.ok(!collapsed.includes("→"), "no fallback arrow on the settled collapsed line (degrade path)");
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
    return ok("ok");
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

// ── Task 2: pure render helpers (formatUsage / formatSlotMeta / sumUsage) ──
// Shared by the done + live render rewrites (Tasks 3-6). formatSlotMeta takes a
// RunView-sourced `modelSeg` (or degrades to shortModel(model)); the
// fallback-aware segment itself now lives once in core-runtime's RunView.
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

test("formatSlotMeta: themed `modelSeg · elapsed · usage`; RunView-sourced segment, shortModel degrade, default fallback", () => {
  const meta = formatSlotMeta({ modelSeg: "glm-5.2", elapsedMs: 34500, usage: U(15715, 0.0004) }, THEME);
  assert.equal(meta, "glm-5.2 · 34.5s · $0.000 · 15715 tok");
  const noUsage = formatSlotMeta({ modelSeg: "glm-5.2", elapsedMs: 34500 }, THEME);
  assert.equal(noUsage, "glm-5.2 · 34.5s");
  // Settled slots that have no view degrade to shortModel(slot.model).
  const degraded = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500 }, THEME);
  assert.equal(degraded, "glm-5.2 · 34.5s");
  const fb = formatSlotMeta(
    {
      // RunView.modelSeg on fallback: `resolved→requested` (built by buildRunView).
      modelSeg: "glm-5.2→claude-opus-4-1",
      elapsedMs: 1000,
      usage: U(10, 0.001),
    },
    THEME,
  );
  assert.equal(fb, "glm-5.2→claude-opus-4-1 · 1.0s · $0.001 · 10 tok");
  // No model anywhere → "default".
  assert.equal(formatSlotMeta({ elapsedMs: 100 }, THEME), "default · 0.1s");
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

test("done collapsed: fallback slot meta degrades to shortModel(actual) — the arrow lives in RunView.modelSeg only", () => {
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
  assert.match(collapsed, /glm-5\.2 · 1\.0s · \$0\.001 · 10 tok/);
  assert.ok(!collapsed.includes("→"), "no fallback arrow on the settled line (degrade path)");
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

/** RunView fixture for buildLiveTable — elapsed/modelSeg/action are baked in
 *  (buildRunView owns the freeze policy; buildLiveTable only renders). */
function view(over: Partial<RunView> & { id: string }): RunView {
  return {
    foreground: false,
    status: "running",
    actor: "general-purpose",
    modelSeg: "glm-5.2",
    elapsedMs: 0,
    elapsedFrozen: false,
    toolCallCount: 0,
    latestAction: "pt",
    history: [],
    startedAt: 0,
    ...over,
  };
}

test("childDispatchIndex: trailing :N from a batch child runId; NaN-resistant", () => {
  assert.equal(childDispatchIndex("batch-call:3"), 3);
  assert.equal(childDispatchIndex("wf:abc:0"), 0);
  assert.equal(childDispatchIndex("no-colon"), NaN);
});

test("buildLiveTable: empty views → empty string (header-only)", () => {
  assert.equal(buildLiveTable([]), "");
});

test("buildLiveTable: one running child → `[i] slot ⏱ elapsed · currentAction`", () => {
  const rows = buildLiveTable([view({ id: "batch-call:0", elapsedMs: 3500 })]);
  assert.equal(rows, "[0] glm-5.2 ⏱ 3.5s · pt");
});

test("buildLiveTable: terminal child shows ✓ glyph + the FROZEN elapsed baked into the view", () => {
  // buildRunView froze elapsedMs at endedAt - startedAt = 500ms; the frozen
  // value renders verbatim regardless of wall-clock (the freeze has exactly
  // one home: core-runtime's buildRunView).
  const rows = buildLiveTable([view({ id: "batch-call:1", elapsedMs: 500, elapsedFrozen: true, status: "done" })]);
  assert.equal(rows, "[1] glm-5.2 ✓ 0.5s · pt");
});

test("buildLiveTable: terminal rows are idempotent across renders; a live view's elapsed ticks via views()", () => {
  const child = view({ id: "batch-call:0", elapsedMs: 500, elapsedFrozen: true, status: "done" });
  const a = buildLiveTable([child]);
  const b = buildLiveTable([child]);
  assert.equal(a, "[0] glm-5.2 ✓ 0.5s · pt");
  assert.equal(b, a, "frozen — repeated renders of the same terminal view are identical");
  // Running rows tick because views() recomputes elapsedMs from Date.now().
  assert.equal(buildLiveTable([view({ id: "batch-call:1", elapsedMs: 1000 })]), "[1] glm-5.2 ⏱ 1.0s · pt");
  assert.equal(buildLiveTable([view({ id: "batch-call:1", elapsedMs: 51_000 })]), "[1] glm-5.2 ⏱ 51.0s · pt");
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
    return ok("ok");
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

test("buildLiveTable: fallback child shows the RunView modelSeg slot (`resolved→requested`)", () => {
  const rows = buildLiveTable([view({ id: "batch-call:0", modelSeg: "glm-5.2→claude-opus-4-1", elapsedMs: 500 })]);
  assert.equal(rows, "[0] glm-5.2→claude-opus-4-1 ⏱ 0.5s · pt");
});

test("buildLiveTable: currentAction comes from summarizeLatestAction(history); falls back to latestAction", () => {
  const withHist = buildLiveTable([
    view({
      id: "batch-call:0",
      elapsedMs: 1000,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/a.ts"}' }],
    }),
  ]);
  assert.match(withHist, /\[0\] glm-5\.2 ⏱ 1\.0s · .+/);
  assert.notEqual(withHist, "[0] glm-5.2 ⏱ 1.0s · pt", "history-derived action replaces the latestAction fallback");
});

test("buildLiveTable: sorted ascending by dispatch index", () => {
  const rows = buildLiveTable([
    view({ id: "batch-call:2" }),
    view({ id: "batch-call:0" }),
    view({ id: "batch-call:1" }),
  ]);
  const idxs = rows.split("\n").map((l) => l.slice(1, 2));
  assert.deepEqual(idxs, ["0", "1", "2"]);
});

// ── collapsed partial render: live-feed line budget (SUBAGENT_LIVE_LINES) ──

/** Set SUBAGENT_LIVE_LINES for one block, restoring the ambient value after
 *  (budget-defaults.test.ts save/restore style, scoped to a single test). */
function withLiveLines<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.SUBAGENT_LIVE_LINES;
  if (value === undefined) delete process.env.SUBAGENT_LIVE_LINES;
  else process.env.SUBAGENT_LIVE_LINES = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.SUBAGENT_LIVE_LINES;
    else process.env.SUBAGENT_LIVE_LINES = saved;
  }
}

/** A realistic 7-line live feed: header + 6 table rows. */
function liveFeed(): string {
  return [
    "subagents · 3/6 running · 12k tok · $0.004",
    ...[0, 1, 2, 3, 4, 5].map((i) => `[${i}] glm-5.2 ⏱ ${i}.0s · pt`),
  ].join("\n");
}

test("liveProgressLineBudget: default 5; SUBAGENT_LIVE_LINES overrides; invalid falls back", () => {
  withLiveLines(undefined, () => assert.equal(liveProgressLineBudget(), 5));
  withLiveLines("3", () => assert.equal(liveProgressLineBudget(), 3));
  withLiveLines("abc", () => assert.equal(liveProgressLineBudget(), 5));
  withLiveLines("0", () => assert.equal(liveProgressLineBudget(), 5));
});

test("isPartial+collapsed: header + 6 rows → header + first 5 child rows + trailing `… +1 more` (default budget, header exempt)", () => {
  withLiveLines(undefined, () => {
    const out = renderSubagentsResult(
      { content: [{ type: "text", text: liveFeed() }] },
      { expanded: false, isPartial: true },
      THEME,
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 7, "header + 5 rows + indicator");
    assert.equal(lines[0], "subagents · 3/6 running · 12k tok · $0.004", "header always shown, exempt from budget");
    assert.equal(lines[5], "[4] glm-5.2 ⏱ 4.0s · pt", "header + first 5 child rows kept verbatim");
    assert.equal(lines[6], "… +1 more", "indicator is the LAST line, counts only cut child rows");
  });
});

test("isPartial+collapsed: SUBAGENT_LIVE_LINES=3 → header + 3 rows + `… +3 more`", () => {
  withLiveLines("3", () => {
    const out = renderSubagentsResult(
      { content: [{ type: "text", text: liveFeed() }] },
      { expanded: false, isPartial: true },
      THEME,
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 5, "header + 3 rows + indicator");
    assert.equal(lines[3], "[2] glm-5.2 ⏱ 2.0s · pt");
    assert.equal(lines[4], "… +3 more");
  });
});

test("isPartial+collapsed: invalid SUBAGENT_LIVE_LINES (abc, 0) → default 5 child rows", () => {
  for (const bad of ["abc", "0"]) {
    withLiveLines(bad, () => {
      const out = renderSubagentsResult(
        { content: [{ type: "text", text: liveFeed() }] },
        { expanded: false, isPartial: true },
        THEME,
      );
      const lines = out.split("\n");
      assert.equal(lines.length, 7, `(${bad}) header + 5 rows + indicator`);
      assert.equal(lines[6], "… +1 more");
    });
  }
});

test("isPartial+collapsed: header + ≤5 child rows renders whole (no indicator); header-only unchanged", () => {
  // header + 2 rows → verbatim.
  const three = ["subagents · 1/2 running", "[0] glm-5.2 ⏱ 1.0s · pt", "[1] glm-5.2 ⏱ 2.0s · pt"].join("\n");
  withLiveLines(undefined, () => {
    const out3 = renderSubagentsResult(
      { content: [{ type: "text", text: three }] },
      { expanded: false, isPartial: true },
      THEME,
    );
    assert.equal(out3, three, "no truncation, no indicator");
  });
  // Boundary: exactly header + 5 rows → still whole.
  const six = ["subagents · 1/6 running", ...[0, 1, 2, 3, 4].map((i) => `[${i}] glm-5.2 ⏱ ${i}.0s · pt`)].join("\n");
  withLiveLines(undefined, () => {
    const out6 = renderSubagentsResult(
      { content: [{ type: "text", text: six }] },
      { expanded: false, isPartial: true },
      THEME,
    );
    assert.equal(out6, six);
  });
  // Single-line text (header only) → unchanged.
  const headerOnly = "subagents · 1/2 running";
  withLiveLines(undefined, () => {
    const out1 = renderSubagentsResult(
      { content: [{ type: "text", text: headerOnly }] },
      { expanded: false, isPartial: true },
      THEME,
    );
    assert.equal(out1, headerOnly);
  });
});

test("`!d` streaming path (details: undefined — what onHistory/onUpdate emits) honors the header-exempt budget in all option combos", () => {
  const feed = liveFeed(); // header + 6 rows
  withLiveLines("3", () => {
    // collapsed partial → header + first 3 rows + indicator.
    const collapsed = renderSubagentsResult(
      { content: [{ type: "text", text: feed }] },
      { expanded: false, isPartial: true },
      THEME,
    );
    const lines = collapsed.split("\n");
    assert.equal(lines.length, 5, "header + 3 rows + indicator");
    assert.equal(lines[0], "subagents · 3/6 running · 12k tok · $0.004", "header exempt, always shown");
    assert.equal(lines[4], "… +3 more");
    // expanded partial → full feed.
    const expanded = renderSubagentsResult(
      { content: [{ type: "text", text: feed }] },
      { expanded: true, isPartial: true },
      THEME,
    );
    assert.equal(expanded, feed, "expanded shows all 7 lines");
    // non-partial (final render, no isPartial) → full feed.
    const done = renderSubagentsResult({ content: [{ type: "text", text: feed }] }, { expanded: false }, THEME);
    assert.equal(done, feed, "non-partial shows the full text");
  });
});

test("details-carrying isPartial render budgets identically (shared helper on both paths)", () => {
  const feed = liveFeed();
  const details: SubagentsToolDetails = { results: [], dispatched: 0, skipped: 0, elapsedMs: 1 };
  withLiveLines("2", () => {
    const out = renderSubagentsResult(
      { content: [{ type: "text", text: feed }], details },
      { expanded: false, isPartial: true },
      THEME,
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 4, "header + 2 rows + indicator");
    assert.equal(lines[3], "… +4 more");
  });
});

// ── ticket 07: per-task agentType on the batch tool (subagent-teams-parity 07/08) ──
// Resolution mirrors the singular path (resolveAgentType + buildSpawnOptions
// precedence): task field > agentType definition > ctx default, read-only
// exclusion non-overridable, worktree-isolating types rejected, unknown types
// fail the WHOLE batch before dispatch (a null slot cannot carry the
// "available types" hint the caller needs).

/** Minimal AgentDefinition factory (required fields: name/prompt/source). */
function def(over: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return { prompt: `You are ${over.name}.`, source: "project", ...over };
}

function fakeSpawnFullOpts() {
  const calls: SpawnSubagentOptions[] = [];
  return {
    calls,
    spawn: async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
      calls.push(opts);
      return ok(`out${calls.length - 1}`);
    },
  };
}

test("ticket 07: mergeReadOnlyExclusion binds agentDef tools/model/tier/prompt with singular precedence", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t" },
    {
      defaultCwd: "/repo",
      activeTools: ["read", "grep"],
      agentDef: def({
        name: "researcher",
        tools: ["read", "grep", "find"],
        disallowedTools: ["web_search"],
        model: "p/research-model",
        tier: "small",
        prompt: "Research carefully.",
      }),
    },
  );
  assert.deepEqual(opts.tools, ["read", "grep", "find"], "agentDef.tools sits between task.tools and activeTools");
  for (const forbidden of READ_ONLY_EXCLUDED) assert.ok(opts.excludeTools?.includes(forbidden));
  assert.ok(opts.excludeTools?.includes("web_search"), "agentDef.disallowedTools denied");
  assert.equal(opts.model, "p/research-model");
  assert.equal(opts.tier, "small");
  assert.equal(opts.instructions, "Research carefully.");
});

test("ticket 07: explicit per-task tools/model/tier win over the agentType definition", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t", tools: ["read"], model: "p/explicit", tier: "big" },
    {
      defaultCwd: "/repo",
      agentDef: def({ name: "researcher", tools: ["find"], model: "p/def-model", tier: "small" }),
    },
  );
  assert.deepEqual(opts.tools, ["read"], "explicit task tools win");
  assert.equal(opts.model, "p/explicit", "explicit task model wins");
  assert.equal(opts.tier, "big", "explicit task tier wins");
});

test("ticket 07: read-only exclusion stays non-overridable via an agentType allowlist", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t" },
    { defaultCwd: "/repo", agentDef: def({ name: "writer", tools: ["read", "edit", "write", "bash"] }) },
  );
  // The definition allowlists the write tools, but the union exclusion applies
  // AFTER the allowlist (deny wins) — a batch child is read-only by construction.
  for (const forbidden of READ_ONLY_EXCLUDED) assert.ok(opts.excludeTools?.includes(forbidden));
});

test("ticket 07: per-task agentType resolves and binds on the execute path", async () => {
  const f = fakeSpawnFullOpts();
  const registry = new Map<string, AgentDefinition>([
    [
      "researcher",
      def({
        name: "researcher",
        tools: ["read", "grep"],
        model: "p/research-model",
        tier: "small",
        prompt: "Be rigorous.",
      }),
    ],
  ]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  const res = await tool.execute(
    "call-agenttype",
    { tasks: [{ task: "#0", agentType: "researcher" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.dispatched, 2);
  assert.deepEqual(f.calls[0]?.tools, ["read", "grep"], "typed child binds the definition's allowlist");
  assert.equal(f.calls[0]?.model, "p/research-model");
  assert.equal(f.calls[0]?.tier, "small");
  assert.equal(f.calls[0]?.instructions, "Be rigorous.");
  // Untyped sibling (calls[1]) keeps the pre-07 path: no instructions.
  assert.equal(f.calls[1]?.instructions, undefined);
  assert.equal(f.calls[1]?.model, undefined);
});

test("ticket 07: unknown agentType rejects the whole batch before dispatch, listing per-task indexes", async () => {
  const f = fakeSpawnFullOpts();
  const registry = new Map<string, AgentDefinition>([["researcher", def({ name: "researcher" })]]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  const res = await tool.execute(
    "call-unknown-type",
    {
      tasks: [{ task: "#0" }, { task: "#1", agentType: "ghost" }, { task: "#2", agentType: "phantom" }],
      concurrency: 1,
    },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0, "nothing dispatched on a rejected batch");
  const text = res.content[0]?.type === "text" ? res.content[0].text : "";
  assert.match(text, /Batch rejected before dispatch/);
  assert.match(text, /\[1\] unknown agentType "ghost"/, "per-task index listed");
  assert.match(text, /\[2\] unknown agentType "phantom"/);
  assert.match(text, /Available agentTypes: researcher/, "available types listed like the singular path");
  assert.equal(res.details.dispatched, 0);
  assert.deepEqual(res.details.results, []);
});

test("ticket 07: worktree-isolating agentType is rejected in batch with a clear message", async () => {
  const f = fakeSpawnFullOpts();
  const registry = new Map<string, AgentDefinition>([
    ["isolated-implementer", def({ name: "isolated-implementer", isolation: "worktree" })],
  ]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  const res = await tool.execute(
    "call-worktree-type",
    { tasks: [{ task: "#0", agentType: "isolated-implementer" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0, "worktree-isolating type never dispatches");
  const text = res.content[0]?.type === "text" ? res.content[0].text : "";
  assert.match(text, /\[0\] agentType "isolated-implementer" uses worktree isolation/);
  assert.match(text, /spawn_subagent/, "message points at the singular tool");
});

test("ticket 07: empty registry reports no definitions found (singular-path message parity)", async () => {
  const f = fakeSpawnFullOpts();
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: new Map() });
  const res = await tool.execute(
    "call-empty-registry",
    { tasks: [{ task: "#0", agentType: "anyone" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const text = res.content[0]?.type === "text" ? res.content[0].text : "";
  assert.match(text, /No agentType definitions found/);
});

test("ticket 07 (review 4a): tier-default tokenBudget derives from the agentType definition's tier", async () => {
  const f = fakeSpawnFullOpts();
  const registry = new Map<string, AgentDefinition>([
    // No task tokenBudget/tier/maxTurns: the folded tier "small" must drive the
    // 500k default (H3 recon envelope off via explicit maxTurns).
    ["cheap", def({ name: "cheap", tier: "small" })],
  ]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  await tool.execute(
    "call-tier-default",
    { tasks: [{ task: "#0", agentType: "cheap", maxTurns: 6 }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls[0]?.tokenBudget, 500_000, "agentDef.tier 'small' → 500k tier default");
});

test("ticket 07 (review 4b): explicit per-task excludeTools override the definition's disallowedTools", () => {
  const opts = mergeReadOnlyExclusion(
    { task: "t", excludeTools: ["web_fetch"] },
    { defaultCwd: "/repo", agentDef: def({ name: "researcher", disallowedTools: ["web_search"] }) },
  );
  assert.ok(opts.excludeTools?.includes("web_fetch"), "explicit exclusion survives");
  assert.ok(
    !opts.excludeTools?.includes("web_search"),
    "definition's disallowedTools yields to the explicit per-task denylist",
  );
  for (const forbidden of READ_ONLY_EXCLUDED) assert.ok(opts.excludeTools?.includes(forbidden));
});

test("ticket 07 (review 4c): agentType allowlisting a required tool still skips via the read-only union", async () => {
  // The definition allowlists `edit` and the task REQUIRES it — the read-only
  // union denies edit after the allowlist, so the impossible-tools preflight
  // skips the child (null slot) instead of dispatching a child that can never
  // use its required tool.
  const f = fakeSpawnFullOpts();
  const registry = new Map<string, AgentDefinition>([["editor", def({ name: "editor", tools: ["read", "edit"] })]]);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  const res = await tool.execute(
    "call-required-edit",
    { tasks: [{ task: "#0", agentType: "editor", requiredTools: ["edit"] }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0, "child never dispatched — required tool denied by the read-only union");
  assert.equal(res.details.results[0], null, "skipped child maps to a null slot");
});

// ── ticket 03 (cc-parity-2): built-in read-only agent types (explore/plan) ──
// Built-ins ride the SAME resolution path as user files: loadAgentRegistry
// folds BUILTIN_AGENT_DEFS in as the lowest-precedence tier, so a batch task
// naming agentType "explore"/"plan" binds with zero user setup and stays
// inside the non-overridable READ_ONLY_EXCLUDED read-only notion.

test("ticket 03: batch resolves agentType 'explore' from the built-in tier and stays read-only", async () => {
  const f = fakeSpawnFullOpts();
  // A registry loaded from nonexistent dirs = the built-in tier only — exactly
  // what a fresh machine with no .pi/agents sees.
  const registry = loadAgentRegistry("/nonexistent-cwd", {
    projectDir: "/nonexistent-project",
    userDir: "/nonexistent-user",
  });
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  const res = await tool.execute(
    "call-builtin-explore",
    { tasks: [{ task: "#0", agentType: "explore" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.dispatched, 1, "built-in type resolves — not rejected as unknown");
  assert.deepEqual(f.calls[0]?.tools, ["read", "grep", "find", "ls"], "built-in allowlist binds");
  for (const forbidden of READ_ONLY_EXCLUDED) {
    assert.ok(f.calls[0]?.excludeTools?.includes(forbidden), `${forbidden} denied (union exclusion)`);
  }
  assert.match(
    String(f.calls[0]?.instructions ?? ""),
    /read-only exploration agent/,
    "built-in prompt rides instructions",
  );
});

test("ticket 03: a user 'explore' file shadows the built-in on the batch execute path", async () => {
  const f = fakeSpawnFullOpts();
  const registry = new Map<string, AgentDefinition>(
    // What loadAgentRegistry yields for a user explore.md: the project/user def
    // REPLACES the built-in wholesale (no merge) — core-runtime test pins the
    // registry side; this pins the batch binding side.
    [["explore", def({ name: "explore", tools: ["read"], prompt: "My own explorer." })]],
  );
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, agentRegistry: registry });
  await tool.execute(
    "call-shadowed-explore",
    { tasks: [{ task: "#0", agentType: "explore" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.deepEqual(f.calls[0]?.tools, ["read"], "shadowing file's allowlist wins");
  assert.equal(f.calls[0]?.instructions, "My own explorer.", "shadowing file's prompt wins");
});
