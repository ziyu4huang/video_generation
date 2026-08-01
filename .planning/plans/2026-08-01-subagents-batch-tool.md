# `subagents` Batch Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a model-callable `subagents` tool that fans out N isolated **read-only** subagents in parallel (bounded), returning a positional array of results — closing the "parallel fan-out needs the `workflow` JS DSL" gap.

**Architecture:** A new tool alongside `subagent`/`subagent_runs`, in `pi-agent-ext-subagent`. It does **not** import `parallel()` (that's a closure inside `pi-agent-ext-workflow/src/workflow.ts`); instead it reimplements the proven `Promise.all`-over-thunks fan-out using this package's own `spawnSubagent()` (the same runner `WorkflowAgent.run` the singular tool uses). Read-only is **enforced**, not conventional: `edit`/`write`/`bash` are merged into every child's `excludeTools` (non-overridable) so parallel children sharing the parent's working tree can never race on writes. A batch-wide budget is a **soft gate** (checked between dispatches, never aborts an in-flight child), mirroring workflow's run-wide gate. The singular `subagent` tool and its `executionMode: "sequential"` contract are untouched.

**Tech Stack:** TypeScript (Bun), `typebox`, `@earendil-works/pi-coding-agent` `defineTool`, `bun:test`.

## Global Constraints

- **Spec:** `.planning/2026-08-01-what-s-next-for-subagent-develop-map/` (tickets 01–04) + `output/next-goal-20260801_093603.md`. The four decisions are settled — implement them, do not re-litigate.
- **Bun only** — never node/npm/yarn. Tests: `( cd bun-apps/pi-agent-ext-subagent && bun test )`. Typecheck: `( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit )`. Format/lint: `( cd bun-apps/pi-agent-ext-subagent && bunx biome check src tests )`.
- **No top-level `cd`** — use `( cd <dir> && … )`.
- **Explicit `git add <paths>`** — never `git add -A`/`git add .`.
- **Read-only enforcement is load-bearing** — every child path MUST go through `mergeReadOnlyExclusion`. A child with `edit`/`write`/`bash` in the shared (un-isolated) tree races. Do not ship without it.
- **Do NOT relax the singular `subagent` tool's `executionMode: "sequential"`** — it's a deliberate contract ("parallel fan-out goes through `workflow.parallel()`"). This new tool is the parallel path; the singular tool stays sequential.
- **`MAX_CONCURRENCY = 16`** is defined locally in `pi-agent-ext-subagent/src/config.ts` (mirrors `pi-agent-ext-workflow`'s value) to keep the package independent — do NOT import it from workflow.
- **Schema-cost canary** — this new tool adds palette cost. Keep the schema lean: `tasks[]`, `concurrency`, batch `tokenBudget`/`spendBudget`, and per-task `{ task, id?, model?, tier?, capability?, cwd?, tools?, excludeTools?, timeoutMs?, tokenBudget?, spendBudget? }`. Measured by `bun-apps/pi-agent-cli/src/commands/schema-cost.ts`.
- **Branch:** create `subagents-batch-tool-20260801` from `main` before Task 1.

---

## File Structure

- **Create** `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` — schema (`subagentsToolSchema`), types (`BatchTask`, `BatchResultSlot`, `SubagentsToolDetails`, `SubagentsToolOptions`), `READ_ONLY_EXCLUDED` constant, pure helpers (`clampConcurrency`, `mergeReadOnlyExclusion`, `runWithConcurrency`, `sumUsage`), `renderBatchResult`, and `createSubagentsTool(options)`.
- **Create** `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` — factory shape, read-only enforcement, bounded fan-out + positional results, failed→null, collective budget soft gate, in-flight + persistence, rendering.
- **Modify** `bun-apps/pi-agent-ext-subagent/src/config.ts` — add `MAX_CONCURRENCY` + `DEFAULT_BATCH_CONCURRENCY`.
- **Modify** `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts` — construct + `pi.registerTool(subagentsTool)`; add `"subagents"` to `activateSubagentTools`'s name list.
- **Modify** `bun-apps/pi-agent-ext-subagent/src/index.ts` — re-export `createSubagentsTool` + `BatchResultSlot`/`SubagentsToolDetails`/`SubagentsToolOptions` types.

---

## Task 1: Config constants + types + schema + factory shell

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/config.ts`
- Create: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Produces: `MAX_CONCURRENCY = 16` and `DEFAULT_BATCH_CONCURRENCY = 4` (config.ts); `BatchTask`, `BatchResultSlot`, `SubagentsToolDetails`, `SubagentsToolOptions` types; `subagentsToolSchema`; `clampConcurrency(n, max)`; `createSubagentsTool(options?): ToolDefinition` with `name === "subagents"`, `executionMode === "sequential"`.

- [ ] **Step 1: Add config constants**

Append to `bun-apps/pi-agent-ext-subagent/src/config.ts`:

```ts
/**
 * Hard ceiling on parallel children in a `subagents` batch. Mirrors
 * pi-agent-ext-workflow's MAX_CONCURRENCY (kept local so this package stays
 * independent of the workflow engine). Unbounded fan-out cascades into
 * provider rate limits (cf. ~50 RPM at Anthropic Tier 1).
 */
export const MAX_CONCURRENCY = 16;

/**
 * Default parallelism for a `subagents` batch when the caller omits
 * `concurrency`. Moderate — read-only research/review fan-out rarely needs
 * more; the caller can raise it up to MAX_CONCURRENCY per call.
 */
export const DEFAULT_BATCH_CONCURRENCY = 4;
```

- [ ] **Step 2: Write the failing test (factory shape + clamp)**

Create `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { MAX_CONCURRENCY, DEFAULT_BATCH_CONCURRENCY } from "../src/config.js";
import { clampConcurrency, createSubagentsTool } from "../src/subagents-tool.js";

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `Cannot find module '../src/subagents-tool.js'`.

- [ ] **Step 4: Write the minimal implementation**

Create `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`:

```ts
/**
 * `subagents` tool — agent-callable PARALLEL read-only fan-out. Dispatches N
 * isolated subagents (via spawnSubagent) with bounded concurrency, returning a
 * positional array of results. Read-only is ENFORCED: edit/write/bash are
 * always excluded (non-overridable) so children sharing the parent's working
 * tree can never race on writes. See .planning/2026-08-01-what-s-next-for-subagent-develop-map/.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUsage, BudgetExhaustion } from "./agent.js";
import { DEFAULT_BATCH_CONCURRENCY, MAX_CONCURRENCY } from "./config.js";
import {
  DEFAULT_TIMEOUT_MS,
  deriveSubagentStatus,
  taskPreview,
} from "./subagent-tool.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "./spawn-subagent.js";
import { spawnSubagent } from "./spawn-subagent.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";
import type { SubagentInFlightRegistry } from "./subagent-in-flight.js";
import { checkBudgetExhaustion } from "./agent.js";

/** Tree-mutating tools a read-only child may NEVER carry (non-overridable). */
export const READ_ONLY_EXCLUDED = ["edit", "write", "bash"] as const;

/** One task in a batch. Mirrors the singular tool's surface, minus mutating hooks. */
export interface BatchTask {
  task: string;
  id?: string;
  model?: string;
  tier?: string;
  capability?: string;
  cwd?: string;
  tools?: string[];
  excludeTools?: string[];
  timeoutMs?: number;
  tokenBudget?: number;
  spendBudget?: number;
}

/** A positional result slot (input order). `null` = the child failed. */
export type BatchResultSlot =
  | { output: string; status: "done" | "timedout"; id?: string; index: number; usage?: AgentUsage }
  | { status: "budget"; exhaustion: BudgetExhaustion; id?: string; index: number }
  | null;

export interface SubagentsToolDetails {
  results: BatchResultSlot[];
  /** Present when the batch-wide soft gate tripped. */
  budgetExhaustion?: BudgetExhaustion;
  /** Aggregate usage across children that reported usage. */
  usage?: AgentUsage;
  dispatched: number;
  skipped: number;
  elapsedMs: number;
}

export interface SubagentsToolOptions {
  cwd?: string;
  getExtensionTools?: () => ToolDefinition[] | undefined;
  getMainModel?: () => string | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  inFlight?: SubagentInFlightRegistry;
  persistence?: SubagentRunPersistence;
}

export const subagentsToolSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      task: Type.String({ description: "Full self-contained prompt — the child has NO access to this session's history." }),
      id: Type.Optional(Type.String({ description: "Optional caller tag echoed in the result for correlation." })),
      model: Type.Optional(Type.String({ description: "Model override `provider/model-id`; omit to inherit the session model." })),
      tier: Type.Optional(Type.String({ description: "Model tier: 'small'|'medium'|'big'." })),
      capability: Type.Optional(Type.String({ description: "Model capability (e.g. 'vision'), resolved from model-tiers config." })),
      cwd: Type.Optional(Type.String({ description: "Child working directory (defaults to parent session cwd)." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Curated tool allowlist." })),
      excludeTools: Type.Optional(Type.Array(Type.String(), { description: "Denied after the allowlist. edit/write/bash are ALWAYS also excluded (non-overridable)." })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Per-child wall-clock cap (ms). Defaults to 15 min." })),
      tokenBudget: Type.Optional(Type.Integer({ description: "Per-child token cap (hard — aborts that one child)." })),
      spendBudget: Type.Optional(Type.Number({ description: "Per-child cost cap in $ (hard)." })),
    }),
    { description: "Read-only fan-out: each task runs as an isolated subagent with edit/write/bash always excluded." },
  ),
  concurrency: Type.Optional(Type.Integer({ description: "Max parallel children. Clamped to [1,16]; default 4." })),
  tokenBudget: Type.Optional(Type.Integer({ description: "Optional batch-wide token cap (soft gate — stops dispatching new children; never aborts in-flight)." })),
  spendBudget: Type.Optional(Type.Number({ description: "Optional batch-wide cost cap in $ (soft gate)." })),
});

/** Clamp a concurrency value to [1, MAX_CONCURRENCY], defaulting when undefined. */
export function clampConcurrency(n: number | undefined, max = MAX_CONCURRENCY): number {
  if (n === undefined) return Math.min(DEFAULT_BATCH_CONCURRENCY, max);
  if (n < 1) return 1;
  return Math.min(Math.floor(n), max);
}

export function createSubagentsTool(_options: SubagentsToolOptions = {}): ToolDefinition {
  return defineTool({
    name: "subagents",
    label: "Subagents",
    description: "Dispatch N isolated read-only subagents in parallel (bounded) and return a positional array of results.",
    promptSnippet:
      "Fan out read-only research/review subagents in parallel. Each child has edit/write/bash excluded. Returns one result per task in input order (null for a failed child).",
    executionMode: "sequential",
    parameters: subagentsToolSchema,
    async execute() {
      throw new Error("subagents execute not implemented until Task 3");
    },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/config.ts bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): add config constants, schema, types, factory shell"
```

---

## Task 2: Read-only enforcement helper (pure)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `BatchTask`, `READ_ONLY_EXCLUDED`, `SubagentsToolOptions` (Task 1).
- Produces: `mergeReadOnlyExclusion(task, ctx): SpawnSubagentOptions` — the exact `SpawnSubagentOptions` handed to `spawnSubagent` per child; later tasks call this inside `execute`.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagents-tool.test.ts`:

```ts
import type { SpawnSubagentOptions } from "../src/spawn-subagent.js";
import { mergeReadOnlyExclusion, READ_ONLY_EXCLUDED } from "../src/subagents-tool.js";

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
  const opts = mergeReadOnlyExclusion(
    { task: "t", tokenBudget: 1000, spendBudget: 0.5 },
    { defaultCwd: "/repo" },
  );
  assert.equal(opts.timeoutMs, 15 * 60 * 1000);
  assert.equal(opts.tokenBudget, 1000);
  assert.equal(opts.spendBudget, 0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `mergeReadOnlyExclusion is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/subagents-tool.ts` (import `DEFAULT_TIMEOUT_MS` is already imported in Task 1):

```ts
/** Build the per-child spawn opts, folding in the non-overridable read-only exclusion. */
export function mergeReadOnlyExclusion(
  task: BatchTask,
  ctx: { defaultCwd: string; mainModel?: string; extensionTools?: ToolDefinition[] },
): SpawnSubagentOptions {
  const excludeTools = Array.from(new Set([...(task.excludeTools ?? []), ...READ_ONLY_EXCLUDED]));
  const opts: SpawnSubagentOptions = {
    task: task.task,
    cwd: task.cwd ?? ctx.defaultCwd,
    tools: task.tools,
    excludeTools,
    timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tokenBudget: task.tokenBudget,
    spendBudget: task.spendBudget,
  };
  if (task.model) opts.model = task.model;
  if (task.tier) opts.tier = task.tier;
  if (task.capability) opts.capability = task.capability;
  if (ctx.mainModel) opts.mainModel = ctx.mainModel;
  if (ctx.extensionTools?.length) opts.extensionTools = ctx.extensionTools;
  return opts;
}
```

Add `ToolDefinition` to the existing `@earendil-works/pi-coding-agent` import line at the top of the file (it currently imports only `defineTool` + `type ToolDefinition` — confirm both are present; if `ToolDefinition` is missing, add it).

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): enforce read-only via non-overridable edit/write/bash exclusion"
```

---

## Task 3: Bounded-concurrency fan-out + positional results + failed→null

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `mergeReadOnlyExclusion` (Task 2), `clampConcurrency` (Task 1), `deriveSubagentStatus` (from `subagent-tool.js`), `spawnSubagent` shape.
- Produces: a working `execute(toolCallId, params, signal, onUpdate, ctx)` returning `{ content, details: SubagentsToolDetails }`; `runWithConcurrency` helper. (Tasks 4–5 add budget-gate + observability inside this same `execute`.)

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
import type { SpawnSubagentResult } from "../src/spawn-subagent.js";

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
      const resolved = typeof o === "function" ? o(opts) : o;
      return resolved;
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
  const tool = createSubagentsTool({ cwd: "/repo", spawn: async () => ({ output: "", exitCode: 0, stderr: "", timedOut: false }) });
  const res = await tool.execute("call-3", { tasks: [] }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(res.content[0].text, /tasks must be a non-empty array/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — execute throws "not implemented until Task 3".

- [ ] **Step 3: Implement `runWithConcurrency` + `execute`**

In `src/subagents-tool.ts`, first add the bounded-concurrency runner near the other helpers:

```ts
/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
```

Replace the stub `execute` inside `createSubagentsTool` with a real implementation. Replace the whole `createSubagentsTool` body:

```ts
export function createSubagentsTool(options: SubagentsToolOptions = {}): ToolDefinition {
  const spawn = options.spawn ?? spawnSubagent;
  const defaultCwd = options.cwd ?? process.cwd();

  return defineTool({
    name: "subagents",
    label: "Subagents",
    description: "Dispatch N isolated read-only subagents in parallel (bounded) and return a positional array of results.",
    promptSnippet:
      "Fan out read-only research/review subagents in parallel. Each child has edit/write/bash excluded. Returns one result per task in input order (null for a failed child).",
    executionMode: "sequential",
    parameters: subagentsToolSchema,
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const t0 = Date.now();
      const tasks = params.tasks as BatchTask[];
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "tasks must be a non-empty array." }],
          details: { results: [], dispatched: 0, skipped: 0, elapsedMs: 0 } as SubagentsToolDetails,
        };
      }
      const concurrency = clampConcurrency(params.concurrency);
      const mainModel = options.getMainModel?.();
      const extensionTools = options.getExtensionTools?.();

      const slots: BatchResultSlot[] = new Array(tasks.length).fill(null);
      let dispatched = 0;

      await runWithConcurrency(tasks, concurrency, async (task, index) => {
        const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools });
        const result = await spawn(childOpts);
        dispatched++;
        const status = deriveSubagentStatus(result);
        slots[index] = status === "failed" ? null : { output: result.output, status, id: task.id, index, usage: result.usage };
      });

      const details: SubagentsToolDetails = {
        results: slots,
        dispatched,
        skipped: 0,
        elapsedMs: Date.now() - t0,
      };
      return { content: [{ type: "text" as const, text: renderBatchResult(details) }], details };
    },
  });
}
```

Add the renderer (used by Task 3's tests indirectly via the result text; fully exercised in Task 6):

```ts
/** Render the batch result as a readable summary for the model. */
export function renderBatchResult(details: SubagentsToolDetails): string {
  const done = details.results.filter((s) => s && (s as { status: string }).status !== "budget").length;
  const failed = details.results.filter((s) => s === null).length;
  const skipped = details.skipped;
  const header = `## subagents batch (${done} ok · ${failed} failed · ${skipped} skipped) — ${(details.elapsedMs / 1000).toFixed(1)}s`;
  const body = details.results
    .map((slot, i) => {
      if (slot === null) return `### [${i}] failed\n_(null — child failed; re-run via the singular \`subagent\` tool to see the error)_`;
      if (slot.status === "budget") return `### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped — batch budget: ${slot.exhaustion.kind} ${slot.actual} > ${slot.exhaustion.limit}`;
      return `### [${i}]${slot.id ? ` (${slot.id})` : ""} ${slot.status}\n${slot.output || "_(empty output)_"}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): bounded-concurrency fan-out, positional results, failed->null"
```

---

## Task 4: Batch-wide budget soft gate

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `checkBudgetExhaustion(stats, budget)` + `AgentUsage`/`BudgetExhaustion` from `./agent.js` (already imported in Task 1).
- Produces: the soft gate inside `execute` — after each child completes, sum usage and check the batch budget; if exceeded, stop dispatching new children (in-flight ones finish) and mark remaining slots `{ status: "budget", exhaustion }`. `SubagentsToolDetails.budgetExhaustion` is set; `skipped` counts them.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagents-tool.test.ts`:

```ts
function fakeSpawnWithUsage(usages: { total: number; cost: number }[], delayMs = 0) {
  let i = 0;
  return async (): Promise<SpawnSubagentResult> => {
    const idx = i++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = usages[idx] ?? { total: 0, cost: 0 };
    return { output: `out${idx}`, exitCode: 0, stderr: "", timedOut: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.total, cost: u.cost } };
  };
}

test("batch token budget soft gate skips remaining slots without aborting in-flight children", async () => {
  // 4 tasks, concurrency 1 (deterministic order). Child 0 burns 40k of a 50k budget;
  // child 1 (30k) pushes cumulative to 70k > 50k AFTER it finishes → gate trips →
  // children 2,3 are never dispatched and become budget slots.
  const f = fakeSpawnWithUsage([{ total: 40000, cost: 0 }, { total: 30000, cost: 0 }, { total: 0, cost: 0 }, { total: 0, cost: 0 }]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `dispatched` is 4 (no gate yet); `budgetExhaustion` undefined.

- [ ] **Step 3: Add the soft gate to `execute`**

In `createSubagentsTool`'s `execute`, add gate state before the `runWithConcurrency` call and check it inside the worker. Replace the block from `const slots:` through the end of the `runWithConcurrency` callback with:

```ts
      const slots: BatchResultSlot[] = new Array<BatchResultSlot | undefined>(tasks.length).fill(undefined);
      let dispatched = 0;
      let gateTripped = false;
      let budgetExhaustion: BudgetExhaustion | undefined;
      const acc = { tokens: { total: 0 }, cost: 0 };
      const batchBudget = {
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
        ...(params.spendBudget !== undefined ? { spendBudget: params.spendBudget } : {}),
      };
      const hasBatchBudget = params.tokenBudget !== undefined || params.spendBudget !== undefined;

      await runWithConcurrency(tasks, concurrency, async (task, index) => {
        // Soft gate: once tripped, no NEW children start; in-flight ones finish.
        if (gateTripped) {
          slots[index] = { status: "budget", exhaustion: budgetExhaustion!, id: task.id, index };
          return;
        }
        const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools });
        const result = await spawn(childOpts);
        dispatched++;
        if (result.usage) {
          acc.tokens.total += result.usage.total;
          acc.cost += result.usage.cost;
        }
        const status = deriveSubagentStatus(result);
        slots[index] = status === "failed" ? null : { output: result.output, status, id: task.id, index, usage: result.usage };
        // Check the batch budget BETWEEN dispatches (never aborts the child that just finished).
        if (hasBatchBudget && !gateTripped) {
          const ex = checkBudgetExhaustion(acc, batchBudget);
          if (ex) {
            gateTripped = true;
            budgetExhaustion = ex;
          }
        }
      });

      // Backfill any slot no worker reached (all workers broke early on the gate).
      for (let i = 0; i < slots.length; i++) {
        if (slots[i] === undefined) {
          slots[i] = { status: "budget", exhaustion: budgetExhaustion!, id: tasks[i].id, index: i };
        }
      }

      const skipped = slots.filter((s) => s !== null && (s as { status: string }).status === "budget").length;
      const details: SubagentsToolDetails = {
        results: slots as BatchResultSlot[],
        dispatched,
        skipped,
        elapsedMs: Date.now() - t0,
        ...(budgetExhaustion ? { budgetExhaustion } : {}),
      };
      return { content: [{ type: "text" as const, text: renderBatchResult(details) }], details };
```

Note: the empty-tasks early-return above this block stays unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (8 tests). Confirm Task 3's "failed→null" test still passes (a failed child with no batch budget doesn't trip any gate).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): batch-wide budget soft gate (between-dispatch, never aborts in-flight)"
```

---

## Task 5: Per-child in-flight registry + durable persistence

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `options.inFlight` (`SubagentInFlightRegistry`: `.start({id,agent?,model,taskPreview,startedAt})`, `.end(id)`) and `options.persistence` (`SubagentRunPersistence.save(record)` + `generateSubagentRunId()`). Both already imported in Task 1.
- Produces: each dispatched child registers in-flight on start / deregisters in a `finally`; on completion, one write-once persistence record is saved (mirroring the singular tool). Failed/skipped children are NOT persisted (they aren't real completed runs), matching the singular tool's pre-flight-skip behavior.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
import { SubagentInFlightRegistry } from "../src/subagent-in-flight.js";
import type { SubagentRunPersistence, SubagentRunRecord } from "../src/subagent-run-persistence.js";

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
    () => { seenDuringRun = inFlight.list().length; return { output: "A", exitCode: 0, stderr: "", timedOut: false }; },
    () => { seenDuringRun = Math.max(seenDuringRun, inFlight.list().length); return { output: "B", exitCode: 0, stderr: "", timedOut: false }; },
  ]);
  const persistence = memPersistence();
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, inFlight, persistence });
  await tool.execute("call-obs", { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 2 }, NO_SIGNAL, undefined, NO_CTX);
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
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn, persistence });
  // give the done child heavy usage so the gate trips after it
  // (re-use the usage fake by wrapping)
  const wrappedSpawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const r = await f.spawn(opts);
    if (r.exitCode === 0) return { ...r, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 60000, cost: 0 } };
    return r;
  };
  const tool2 = createSubagentsTool({ cwd: "/repo", spawn: wrappedSpawn, persistence });
  await tool2.execute("call-np", { tasks: [{ task: "#0" }, { task: "#1" }, { task: "#2" }], concurrency: 1, tokenBudget: 50000 }, NO_SIGNAL, undefined, NO_CTX);
  // only the one done child persists (failed + skipped do not)
  assert.equal(persistence.saved.length, 1);
  assert.equal(persistence.saved[0].status, "done");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `persistence.saved` is empty (save not called yet).

- [ ] **Step 3: Wire in-flight + persistence into the worker**

In `execute`, inside the `runWithConcurrency` callback, wrap the spawn in in-flight start/end and add a persistence save for completed (non-failed) children. Replace the worker body (the non-gated branch) with:

```ts
        const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools });
        const childRunId = `${toolCallId}:${index}`;
        const childT0 = Date.now();
        options.inFlight?.start({
          id: childRunId,
          model: task.model ?? task.tier ?? task.capability ?? mainModel ?? "default",
          taskPreview: taskPreview(task.task),
          startedAt: childT0,
        });
        let result: SpawnSubagentResult;
        try {
          result = await spawn(childOpts);
        } finally {
          options.inFlight?.end(childRunId);
        }
        dispatched++;
        if (result.usage) {
          acc.tokens.total += result.usage.total;
          acc.cost += result.usage.cost;
        }
        const status = deriveSubagentStatus(result);
        slots[index] = status === "failed" ? null : { output: result.output, status, id: task.id, index, usage: result.usage };
        // Durable record for completed runs only (failed/skipped are not real completed runs).
        if (status !== "failed") {
          options.persistence?.save({
            id: generateSubagentRunId(),
            toolCallId,
            task: task.task,
            model: childOpts.model ?? mainModel,
            tier: task.tier,
            cwd: childOpts.cwd,
            status,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stderr: result.stderr || undefined,
            startedAt: new Date(childT0).toISOString(),
            elapsedMs: Date.now() - childT0,
            usage: result.usage,
            budget: result.budget,
            output: result.output,
          });
        }
        // Check the batch budget BETWEEN dispatches (never aborts the child that just finished).
        if (hasBatchBudget && !gateTripped) {
          const ex = checkBudgetExhaustion(acc, batchBudget);
          if (ex) {
            gateTripped = true;
            budgetExhaustion = ex;
          }
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): per-child in-flight registry + durable persistence"
```

---

## Task 6: Register the tool in the extension + re-export from index

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `createSubagentsTool` (Task 1–5), the extension's `inFlight`/`persistence`/holder getters (already in `extensions/subagent.ts`).
- Produces: a registered `subagents` tool active in every session; `createSubagentsTool` + types re-exported from the package root.

- [ ] **Step 1: Write the failing test (registration via index re-export)**

Append to `tests/subagents-tool.test.ts`:

```ts
import { createSubagentsTool as fromIndex } from "../src/index.js";

test("createSubagentsTool is re-exported from the package index", () => {
  assert.equal(fromIndex, createSubagentsTool);
  assert.equal(fromIndex().name, "subagents");
});

test("renderBatchResult renders ok/failed/skipped sections", () => {
  const { renderBatchResult } = require("../src/subagents-tool.js");
  const text = renderBatchResult({
    results: [
      { output: "hello", status: "done", index: 0, id: "a" },
      null,
      { status: "budget", exhaustion: { kind: "tokens", limit: 50000, actual: 70000 }, index: 2 },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `createSubagentsTool` not exported from `src/index.js`.

- [ ] **Step 3: Re-export from the package index**

In `bun-apps/pi-agent-ext-subagent/src/index.ts`, add (near the existing `createSubagentTool` re-export):

```ts
// subagents batch tool
export { createSubagentsTool, subagentsToolSchema } from "./subagents-tool.js";
export type {
  BatchTask,
  BatchResultSlot,
  SubagentsToolDetails,
  SubagentsToolOptions,
} from "./subagents-tool.js";
```

- [ ] **Step 4: Register the tool in the extension**

In `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts`, import the factory and construct + register it alongside the others. Add to the existing import from `../src/index.js`:

```ts
import {
  createSubagentRunsTool,
  createSubagentTool,
  createSubagentsTool,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
} from "../src/index.js";
```

After the `subagentRunsTool` construction/registration, add:

```ts
  const subagentsTool = createSubagentsTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => mainModelHolder.current,
    inFlight,
    persistence,
  });
  pi.registerTool(subagentsTool);
```

In `activateSubagentTools`, add `"subagents"` to the name list:

```ts
      const missing = [subagentTool.name, subagentRunsTool.name, subagentsTool.name].filter(
        (nm) => !Array.isArray(active) || !active.includes(nm),
      );
```

- [ ] **Step 5: Run the full suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test )`
Expected: all tests PASS (including the new 12 in `subagents-tool.test.ts` and the existing suites).

Run: `( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit )`
Expected: no type errors.

Run: `( cd bun-apps/pi-agent-ext-subagent && bunx biome check src/subagents-tool.ts tests/subagents-tool.test.ts extensions/subagent.ts src/index.ts )`
Expected: clean (or run `bunx biome check --write …` to auto-fix).

- [ ] **Step 6: Verify the schema-cost canary picks up the new tool**

Run: `( cd bun-apps/pi-agent-cli && bun run src/commands/schema-cost.ts 2>/dev/null || bun run schema-cost 2>/dev/null ) || echo "(canary optional — note the new 'subagents' tool's measured cost in the PR description)"`
Expected: the `subagents` tool appears in the measured list. If the canary is unavailable, note the new tool's schema footprint in the PR description.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/extensions/subagent.ts bun-apps/pi-agent-ext-subagent/src/index.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): register tool in extension + re-export from package index"
```

---

## Self-review (run before handoff)

1. **Spec coverage** — all four map tickets map to tasks:
   - Scope (read-only) → `READ_ONLY_EXCLUDED` + `mergeReadOnlyExclusion` (Task 2), applied in `execute` (Tasks 3–5). ✓
   - Shape (`subagents` batch tool, wraps `spawnSubagent`) → Tasks 1, 3. Singular `subagent` untouched. ✓
   - Result model (positional array, `{output,status}`/`null`/`{status:"budget"}`) → Task 3 + Task 4. ✓
   - Cap (`concurrency` clamped `[1,16]`, default 4) → `clampConcurrency` (Task 1). ✓
   - Budget (per-child hard + batch soft gate, never aborts in-flight) → Task 4 (per-child budgets flow through `mergeReadOnlyExclusion`). ✓
   - Backpressure (skipped slots `{status:"budget",exhaustion}`, top-level summary) → Task 4 + `renderBatchResult`. ✓
2. **Placeholder scan** — no TBD/TODO/"add error handling"; every code step shows real code. ✓
3. **Type consistency** — `BatchResultSlot`/`SubagentsToolDetails`/`SubagentsToolOptions` defined once (Task 1) and used consistently; `deriveSubagentStatus`, `generateSubagentRunId`, `checkBudgetExhaustion`, `spawnSubagent` referenced by their real exported names. ✓
4. **Deviation note** — `DEFAULT_BATCH_CONCURRENCY = 4` is a local default (spec said "default `defaultConcurrency`", a workflow-layer setting); kept local for package independence, overridable + clamped to 16. Documented in Global Constraints.

## Execution Handoff

Plan complete and saved to `.planning/plans/2026-08-01-subagents-batch-tool.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
