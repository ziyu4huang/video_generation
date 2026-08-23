# workflow_control tool + subagent abort-signal fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model itself a tool to stop/pause/resume/inspect/wait-on a background `workflow` run (mirrors Claude Code's `TaskStop`/`TaskList`), and fix `subagent` tool ignoring the runtime abort signal so Ctrl+C actually cancels the child session instead of leaving it running.

**Architecture:** One new tool (`workflow_control`, an `action`-enum multiplexed tool) is a thin wrapper over `WorkflowManager`'s existing `stop`/`pause`/`resume`/`getSnapshot`/`getRun`/`listRuns` methods and the existing `renderWorkflowText`/`renderPersistedStatus`/`summarizeRun` formatters — zero new business logic, same methods `/workflows` already calls. A new `wait` action subscribes to the manager's `complete`/`error`/`stopped`/`paused` events, race-timed against a clamped timeout. Separately, `spawn-subagent.ts` gains an `externalSignal` option chained into its internal `AbortController` (same pattern `workflow-manager.ts` already uses for the `workflow` tool's foreground path), with a guard so an external abort never triggers the existing transient-failure retry.

**Tech Stack:** TypeScript, Bun (`bun:test` + `node:assert/strict`), `@earendil-works/pi-coding-agent` (`defineTool`/`ToolDefinition`), `typebox` (`Type.*` schemas), Biome (lint/format).

**Design doc:** `docs/superpowers/specs/2026-07-19-workflow-control-tool-design.md`

**Repo root note:** All commands below use `( cd bun-apps/pi-agent-ext-workflow && ... )` — this repo's shell hook blocks a bare top-level `cd`. Run every command from the repo root.

---

### Task 1: Fix `subagent` tool ignoring the runtime abort signal

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`

- [ ] **Step 1: Write the failing tests in `tests/spawn-subagent.test.ts`**

Add these three `it()` blocks inside the existing `describe("spawnSubagent", ...)` block, after the last existing test (`"null result (recoverable exhaustion) ..."`, currently ending at line 121, just before the closing `});` at line 122):

```ts
  it("externalSignal already aborted before the call → the internal signal passed to runner.run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = mkRunner(async (p) => {
      assert.equal((p.opts.signal as AbortSignal).aborted, true, "internal signal should already be aborted");
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await spawnSubagent({ task: "t", externalSignal: controller.signal, agent: runner });
    assert.equal(out.timedOut, true);
    assert.equal(out.exitCode, 124);
  });

  it("externalSignal that aborts mid-run propagates to the internal signal (addEventListener path)", async () => {
    const controller = new AbortController();
    const runner = mkRunner(async (p) => {
      const sig = p.opts.signal as AbortSignal;
      assert.equal(sig.aborted, false, "not aborted yet at call time");
      controller.abort();
      await Promise.resolve();
      assert.equal(sig.aborted, true, "external abort propagated to the internal signal");
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await spawnSubagent({ task: "t", externalSignal: controller.signal, agent: runner });
    assert.equal(out.timedOut, true);
  });

  it("REGRESSION: an external abort must not trigger the transient-failure retry", async () => {
    const controller = new AbortController();
    controller.abort();
    let n = 0;
    const runner = mkRunner(async () => {
      n++;
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await spawnSubagent({
      task: "t",
      externalSignal: controller.signal,
      retryOnTransient: true,
      agent: runner,
    });
    assert.equal(n, 1, "external abort must not cause a retry — that would re-run work the user just cancelled");
    assert.equal(out.timedOut, true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/spawn-subagent.test.ts )`
Expected: 3 new FAIL — `externalSignal` is not yet a recognized option, so `opts.signal` never becomes aborted and `n` ends up `2` in the regression test (current code always retries on a transient abort-shaped error).

- [ ] **Step 3: Add `externalSignal` to `SpawnSubagentOptions` and wire it into the internal controller**

In `src/spawn-subagent.ts`, add a field to the `SpawnSubagentOptions` interface (after the existing `agent?: Pick<WorkflowAgent, "run">;` field, which is currently the last field before the closing `}`):

```ts
  /** Injectable runner (tests pass a mock; production omits → new WorkflowAgent). */
  agent?: Pick<WorkflowAgent, "run">;
  /** Host signal (e.g. tool-call Ctrl+C) that should cancel this call when fired. */
  externalSignal?: AbortSignal;
}
```

Then inside `spawnSubagent()`'s `tryOnce` function, chain the external signal into the per-attempt controller (same pattern as `workflow-manager.ts`'s `executeRun`). Change:

```ts
  const tryOnce = async (): Promise<{ result: SpawnSubagentResult; transient: boolean }> => {
    const ac = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
```

to:

```ts
  const tryOnce = async (): Promise<{ result: SpawnSubagentResult; transient: boolean }> => {
    const ac = new AbortController();
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) ac.abort();
      else opts.externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
```

- [ ] **Step 4: Guard the retry decision against an external abort**

Change the end of `spawnSubagent()`:

```ts
  const first = await tryOnce();
  if (first.result.exitCode === 0 || !retry || !first.transient) return first.result;
  // Single retry on a transient failure (mirrors runSubagentWithRetry).
  return (await tryOnce()).result;
}
```

to:

```ts
  const first = await tryOnce();
  if (first.result.exitCode === 0 || !retry || !first.transient) return first.result;
  // Never retry a cancel the caller (or user) explicitly requested — retrying
  // would re-run work that was just aborted.
  if (opts.externalSignal?.aborted) return first.result;
  // Single retry on a transient failure (mirrors runSubagentWithRetry).
  return (await tryOnce()).result;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/spawn-subagent.test.ts )`
Expected: PASS (all tests in the file, including the 3 new ones)

- [ ] **Step 6: Write the failing test in `tests/subagent-tool.test.ts`**

Add this `test()` at the end of the file, after `"execute forwards getExtensionTools() === undefined when holder unset"` (currently the last test, ending at line 110, before the file's final `});` at line 110-111 — append after it):

```ts
test("execute forwards the runtime abort signal to spawn as externalSignal", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const controller = new AbortController();
  await tool.execute("id", { task: "t" }, controller.signal, undefined, NO_CTX);
  assert.equal(f.calls[0]?.externalSignal, controller.signal, "the tool-call signal must reach spawn()");
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `f.calls[0]?.externalSignal` is `undefined` (the current `execute` never passes it).

- [ ] **Step 8: Forward the signal in `subagent-tool.ts`**

Change:

```ts
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `You are the ${params.agent} for this task.` : undefined,
        extensionTools: options.getExtensionTools?.(),
      });
```

to:

```ts
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `You are the ${params.agent} for this task.` : undefined,
        extensionTools: options.getExtensionTools?.(),
        externalSignal: signal,
      });
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "fix(pi-agent-ext-workflow): thread runtime abort signal into subagent tool

Ctrl+C on an in-flight subagent tool call previously did not cancel the
child LLM session — the signal was captured but never forwarded. Also
guards spawnSubagent()'s transient-failure retry so an external abort
never triggers a spurious re-run of cancelled work."
```

---

### Task 2: Export `renderPersistedStatus` and `summarizeRun` from `workflow-commands.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts`

These two formatters already produce exactly the text `/workflows status <id>` and `/workflows list` show a human. `workflow_control` (Task 3+) reuses them verbatim so the model sees identical formatting — no new formatting logic, no drift between the two surfaces.

- [ ] **Step 1: Export `summarizeRun`**

In `src/workflow-commands.ts`, change (currently line 30):

```ts
function summarizeRun(run: PersistedRunState): string {
```

to:

```ts
export function summarizeRun(run: PersistedRunState): string {
```

- [ ] **Step 2: Export `renderPersistedStatus`**

Change (currently line 92):

```ts
function renderPersistedStatus(run: PersistedRunState): string {
```

to:

```ts
export function renderPersistedStatus(run: PersistedRunState): string {
```

- [ ] **Step 3: Verify the package still typechecks**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build )`
Expected: exits 0, no TypeScript errors (this is a pure visibility change — no call sites change).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts
git commit -m "refactor(pi-agent-ext-workflow): export renderPersistedStatus + summarizeRun

Prep for the workflow_control tool, which reuses these formatters
verbatim so model-facing status/list output matches /workflows exactly."
```

---

### Task 3: `workflow_control` tool — `stop`/`pause`/`resume` actions

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-control-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/workflow-control-tool.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

/** Same fake-manager pattern as tests/workflow-commands.test.ts, plus real
 *  EventEmitter behavior so the `wait` action (Task 5) can be tested by
 *  emitting events directly. */
function fakeManager(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const base = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return false;
    },
    pause: (id: string) => {
      calls.push(`pause:${id}`);
      return false;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return false;
    },
  };
  const manager = Object.assign(new EventEmitter(), base, overrides);
  return { manager: manager as unknown as WorkflowManager, calls };
}

async function textOf(result: { content: Array<{ type: string; text?: string }> }): Promise<string> {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

test("createWorkflowControlTool has name 'workflow_control'", () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  assert.equal(tool.name, "workflow_control");
});

test("action=stop with no runId throws", async () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  await assert.rejects(() => tool.execute("id", { action: "stop" }, NO_SIGNAL, undefined, NO_CTX));
});

test("action=stop on a running run calls manager.stop and reports success", async () => {
  const { manager, calls } = fakeManager({ stop: (id: string) => (calls.push(`stop:${id}`), true) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "stop", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(calls, ["stop:run-1"]);
  assert.match(await textOf(res), /Stopped run-1/);
});

test("action=stop on an unknown/non-running run lists currently-running ids", async () => {
  const { manager } = fakeManager({
    stop: () => false,
    listRuns: () => [
      { runId: "run-2", status: "running" },
      { runId: "run-3", status: "completed" },
    ],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "stop", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  const text = await textOf(res);
  assert.match(text, /Cannot stop run-1/);
  assert.match(text, /run-2/);
  assert.doesNotMatch(text, /run-3/, "only running runs are listed, not completed ones");
});

test("action=stop when nothing is running says so instead of an empty list", async () => {
  const { manager } = fakeManager({ stop: () => false, listRuns: () => [] });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "stop", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /No runs are currently running/);
});

test("action=pause calls manager.pause", async () => {
  const { manager, calls } = fakeManager({ pause: (id: string) => (calls.push(`pause:${id}`), true) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "pause", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(calls, ["pause:run-1"]);
  assert.match(await textOf(res), /Paused run-1/);
});

test("action=resume calls manager.resume (async)", async () => {
  const { manager, calls } = fakeManager({ resume: async (id: string) => (calls.push(`resume:${id}`), true) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "resume", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(calls, ["resume:run-1"]);
  assert.match(await textOf(res), /Resumed run-1/);
});

test("action=resume reports failure when nothing resumable", async () => {
  const { manager } = fakeManager({ resume: async () => false });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "resume", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /Resume not available/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-control-tool.test.ts )`
Expected: FAIL — `../src/workflow-control-tool.js` does not exist yet.

- [ ] **Step 3: Create `src/workflow-control-tool.ts` with the `stop`/`pause`/`resume` actions**

```ts
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkflowManager } from "./workflow-manager.js";

const workflowControlActionEnum = Type.Union([
  Type.Literal("stop"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("status"),
  Type.Literal("list"),
  Type.Literal("wait"),
]);

const workflowControlToolSchema = Type.Object({
  action: workflowControlActionEnum,
  runId: Type.Optional(
    Type.String({
      description:
        "The run ID returned by the workflow tool's background start. Required for stop/pause/resume/status/wait; ignored by list.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "wait only: how long to block for the run to finish, in milliseconds. Default 30000, clamped to [1000, 300000].",
    }),
  ),
});

export type WorkflowControlToolInput = {
  action: "stop" | "pause" | "resume" | "status" | "list" | "wait";
  runId?: string;
  timeoutMs?: number;
};

export interface WorkflowControlToolOptions {
  manager: WorkflowManager;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function requireRunId(action: string, runId: string | undefined): string {
  if (!runId) throw new Error(`workflow_control: action "${action}" requires runId`);
  return runId;
}

/** Run IDs the manager currently reports as "running" — used to help the
 *  model self-correct a stale/wrong runId without a separate list call. */
function runningIds(manager: WorkflowManager): string[] {
  return manager
    .listRuns()
    .filter((r) => r.status === "running")
    .map((r) => r.runId);
}

export function createWorkflowControlTool(
  options: WorkflowControlToolOptions,
): ToolDefinition<typeof workflowControlToolSchema, any> {
  const { manager } = options;
  return defineTool({
    name: "workflow_control",
    label: "WorkflowControl",
    description:
      "Stop, pause, resume, inspect, or wait on a background workflow run (a run started by the workflow tool with background: true). Use runId from the workflow tool's background-start result.",
    promptSnippet:
      "Control a background workflow run: workflow_control({ action, runId }). action is one of stop | pause | resume | status | list | wait.",
    parameters: workflowControlToolSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "stop": {
          const runId = requireRunId("stop", params.runId);
          if (manager.stop(runId)) return textResult(`Stopped ${runId}.`);
          const ids = runningIds(manager);
          return textResult(
            ids.length
              ? `Cannot stop ${runId} (not running). Currently running: ${ids.join(", ")}.`
              : `Cannot stop ${runId} (not running). No runs are currently running.`,
          );
        }
        case "pause": {
          const runId = requireRunId("pause", params.runId);
          const ok = manager.pause(runId);
          return textResult(ok ? `Paused ${runId}.` : `Cannot pause ${runId} (not running).`);
        }
        case "resume": {
          const runId = requireRunId("resume", params.runId);
          const ok = await manager.resume(runId);
          return textResult(ok ? `Resumed ${runId}.` : `Resume not available for ${runId} yet.`);
        }
        default:
          throw new Error(`workflow_control: action "${params.action}" not yet implemented`);
      }
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-control-tool.test.ts )`
Expected: PASS (7 tests: name check + 6 stop/pause/resume cases)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts bun-apps/pi-agent-ext-workflow/tests/workflow-control-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): add workflow_control tool (stop/pause/resume)

Model-callable control over a background workflow run, wrapping the same
WorkflowManager methods /workflows already calls. Closes the gap where
the model itself has no way to act on 'cancel that background run' —
only a human typing /workflows stop could."
```

---

### Task 4: `workflow_control` tool — `status`/`list` actions

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-control-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflow-control-tool.test.ts` (add the import first, then the tests at the end of the file):

Add to the top-of-file imports (alongside the existing `import type { WorkflowManager } from "../src/workflow-manager.js";`):

```ts
import { createWorkflowSnapshot } from "../src/display.js";
```

Append these tests at the end of the file:

```ts
test("action=status with no runId throws", async () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  await assert.rejects(() => tool.execute("id", { action: "status" }, NO_SIGNAL, undefined, NO_CTX));
});

test("action=status on a live run renders the live snapshot + a no-poll hint", async () => {
  const snapshot = createWorkflowSnapshot({ name: "audit", description: "d", phases: [] });
  snapshot.agents.push({ id: 1, label: "scan", status: "running" } as never);
  const { manager } = fakeManager({ getSnapshot: (id: string) => (id === "run-1" ? snapshot : null) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "status", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  const text = await textOf(res);
  assert.match(text, /audit/);
  assert.match(text, /wait/i, "includes the prefer-notification-over-polling hint");
});

test("action=status on a finished (persisted-only) run falls back to renderPersistedStatus", async () => {
  const { manager } = fakeManager({
    getSnapshot: () => null,
    listRuns: () => [{ runId: "run-1", workflowName: "audit", status: "completed", phases: [], agents: [], logs: [] }],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "status", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /audit/);
});

test("action=status on an unknown runId says so", async () => {
  const { manager } = fakeManager({ getSnapshot: () => null, listRuns: () => [] });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "status", runId: "nope" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /No workflow run "nope"/);
});

test("action=list with no runs says so", async () => {
  const { manager } = fakeManager({ listRuns: () => [] });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /No workflow runs yet/);
});

test("action=list renders every run + a no-poll hint", async () => {
  const { manager } = fakeManager({
    listRuns: () => [
      { runId: "run-1", workflowName: "audit", status: "running", phases: [], agents: [], logs: [] },
      { runId: "run-2", workflowName: "review", status: "completed", phases: [], agents: [], logs: [] },
    ],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, NO_CTX);
  const text = await textOf(res);
  assert.match(text, /run-1/);
  assert.match(text, /run-2/);
  assert.match(text, /wait/i, "includes the prefer-notification-over-polling hint");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-control-tool.test.ts )`
Expected: FAIL — `status`/`list` hit the `default:` throw branch.

- [ ] **Step 3: Implement `status` and `list`**

In `src/workflow-control-tool.ts`, add these imports at the top (alongside the existing `import type { WorkflowManager } from "./workflow-manager.js";`):

```ts
import { recomputeWorkflowSnapshot, renderWorkflowText } from "./display.js";
import { renderPersistedStatus, summarizeRun } from "./workflow-commands.js";
```

Add this constant and these two helper functions above `createWorkflowControlTool`:

```ts
const NO_POLL_HINT = "Prefer waiting for the automatic completion notification over polling repeatedly.";

/** Live snapshot if the run is active in this process, else the persisted
 *  status if it exists at all, else undefined. Mirrors the fallback chain
 *  the /workflows status|watch slash command already uses. */
function renderRunStatus(manager: WorkflowManager, runId: string): string | undefined {
  const live = manager.getSnapshot(runId);
  if (live) return renderWorkflowText(recomputeWorkflowSnapshot(live), false);
  const run = manager.listRuns().find((r) => r.runId === runId);
  return run ? renderPersistedStatus(run) : undefined;
}

function renderRunList(manager: WorkflowManager): string {
  const runs = manager.listRuns();
  if (!runs.length) return "No workflow runs yet.";
  return [...runs.map(summarizeRun), "", NO_POLL_HINT].join("\n");
}
```

Replace the `default:` branch in the `switch (params.action)` block with the two new cases (keep `default:` as the last case, now unreachable for the six known actions but still present for exhaustiveness against a malformed call):

```ts
        case "status": {
          const runId = requireRunId("status", params.runId);
          const text = renderRunStatus(manager, runId);
          return textResult(text ? `${text}\n\n${NO_POLL_HINT}` : `No workflow run "${runId}".`);
        }
        case "list":
          return textResult(renderRunList(manager));
        default:
          throw new Error(`workflow_control: action "${params.action}" not yet implemented`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-control-tool.test.ts )`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts bun-apps/pi-agent-ext-workflow/tests/workflow-control-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): workflow_control status/list actions

Reuses renderWorkflowText/renderPersistedStatus/summarizeRun verbatim so
model-facing output matches /workflows exactly; both results nudge the
model to prefer the automatic completion notification over polling."
```

---

### Task 5: `workflow_control` tool — `wait` action

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-control-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflow-control-tool.test.ts`:

```ts
test("action=wait with no runId throws", async () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  await assert.rejects(() => tool.execute("id", { action: "wait" }, NO_SIGNAL, undefined, NO_CTX));
});

test("action=wait on an already-finished run returns immediately, no event needed", async () => {
  const { manager } = fakeManager({
    getRun: () => undefined, // not live in this process
    getSnapshot: () => null,
    listRuns: () => [{ runId: "run-1", workflowName: "audit", status: "completed", phases: [], agents: [], logs: [] }],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "wait", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /audit/);
});

test("action=wait on a running run resolves when the manager emits complete for that runId", async () => {
  const snapshot = createWorkflowSnapshot({ name: "audit", description: "d", phases: [] });
  const { manager } = fakeManager({
    getRun: (id: string) => (id === "run-1" ? { status: "running" } : undefined),
    getSnapshot: (id: string) => (id === "run-1" ? snapshot : null),
  });
  const tool = createWorkflowControlTool({ manager });
  const pending = tool.execute("id", { action: "wait", runId: "run-1", timeoutMs: 5000 }, NO_SIGNAL, undefined, NO_CTX);
  // Let execute() reach its event-subscribe point, then emit completion.
  await Promise.resolve();
  (manager as unknown as EventEmitter).emit("complete", { runId: "run-1" });
  const res = await pending;
  assert.match(await textOf(res), /audit/);
});

test("action=wait ignores events for other runIds", async () => {
  const snapshot = createWorkflowSnapshot({ name: "audit", description: "d", phases: [] });
  const { manager } = fakeManager({
    getRun: (id: string) => (id === "run-1" ? { status: "running" } : undefined),
    getSnapshot: (id: string) => (id === "run-1" ? snapshot : null),
  });
  const tool = createWorkflowControlTool({ manager });
  const pending = tool.execute("id", { action: "wait", runId: "run-1", timeoutMs: 200 }, NO_SIGNAL, undefined, NO_CTX);
  await Promise.resolve();
  (manager as unknown as EventEmitter).emit("complete", { runId: "run-OTHER" });
  const res = await pending; // times out at 200ms since the event was for a different run
  assert.match(await textOf(res), /audit/, "times out and returns the current (still-running) snapshot");
});

test("action=wait times out and returns the current snapshot, not an error", async () => {
  const snapshot = createWorkflowSnapshot({ name: "audit", description: "d", phases: [] });
  const { manager } = fakeManager({
    getRun: (id: string) => (id === "run-1" ? { status: "running" } : undefined),
    getSnapshot: (id: string) => (id === "run-1" ? snapshot : null),
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "wait", runId: "run-1", timeoutMs: 50 }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /audit/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-control-tool.test.ts )`
Expected: FAIL — `wait` hits the `default:` throw branch.

- [ ] **Step 3: Implement `wait`**

In `src/workflow-control-tool.ts`, add these constants above `createWorkflowControlTool` (near `NO_POLL_HINT`):

```ts
const WAIT_DEFAULT_MS = 30_000;
const WAIT_MIN_MS = 1_000;
const WAIT_MAX_MS = 300_000;
const WAIT_FINAL_EVENTS = ["complete", "error", "stopped", "paused"] as const;

function clampWaitTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WAIT_DEFAULT_MS;
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Math.floor(value)));
}

/** Block until `runId` reaches a terminal/paused state or `timeoutMs` elapses,
 *  then return its current status text. A run that is not actively "running"
 *  in this process (already finished, or unknown) resolves immediately —
 *  there is nothing to wait for. A timeout is not an error: it returns the
 *  still-running snapshot so the model can decide to wait again or yield. */
function waitForRun(manager: WorkflowManager, runId: string, timeoutMs: number): Promise<string | undefined> {
  const managed = manager.getRun(runId);
  if (!managed || (managed as { status?: string }).status !== "running") {
    return Promise.resolve(renderRunStatus(manager, runId));
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (e?: { runId?: string }) => {
      if (settled || (e && e.runId !== runId)) return;
      settled = true;
      clearTimeout(timer);
      for (const ev of WAIT_FINAL_EVENTS) manager.off(ev, finish);
      resolve(renderRunStatus(manager, runId));
    };
    for (const ev of WAIT_FINAL_EVENTS) manager.on(ev, finish);
    timer = setTimeout(() => finish(), timeoutMs);
  });
}
```

Replace the `default:` branch again, adding `wait` before it:

```ts
        case "wait": {
          const runId = requireRunId("wait", params.runId);
          const text = await waitForRun(manager, runId, clampWaitTimeoutMs(params.timeoutMs));
          return textResult(text ?? `No workflow run "${runId}".`);
        }
        default:
          throw new Error(`workflow_control: action "${params.action}" not yet implemented`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-control-tool.test.ts )`
Expected: PASS (18 tests total)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts bun-apps/pi-agent-ext-workflow/tests/workflow-control-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): workflow_control wait action

Lets the model synchronously rendezvous with a background run it started
when the current turn actually needs the result now, instead of only
being able to yield control and wait for the async delivery notification
(modeled on pi-subagents' subagent_wait). Times out to the current
snapshot rather than erroring."
```

---

### Task 6: Register the tool + export from the package barrel

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/index.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts`

- [ ] **Step 1: Export from `src/index.ts`**

Add these two lines right after the existing `export { registerWorkflowCommands } from "./workflow-commands.js";` line (currently line 85), before the `export { ... } from "./workflow-editor.js";` block:

```ts
export type { WorkflowControlToolInput, WorkflowControlToolOptions } from "./workflow-control-tool.js";
export { createWorkflowControlTool } from "./workflow-control-tool.js";
```

- [ ] **Step 2: Register the tool in `extensions/workflow.ts`**

Add `createWorkflowControlTool` to the import from `"../src/index.js"` — change:

```ts
import {
  buildWorkflowGuidelinesForTurn,
  createEffortState,
  createWorkflowHelpTool,
  createWorkflowStorage,
  createWorkflowTool,
```

to:

```ts
import {
  buildWorkflowGuidelinesForTurn,
  createEffortState,
  createWorkflowControlTool,
  createWorkflowHelpTool,
  createWorkflowStorage,
  createWorkflowTool,
```

Instantiate and register it right after the existing `subagentTool` registration block. Change:

```ts
  pi.registerTool(subagentTool);
```

to:

```ts
  pi.registerTool(subagentTool);
  const workflowControlTool = createWorkflowControlTool({ manager });
  pi.registerTool(workflowControlTool);
```

Add it to the always-active tool list inside `activateWorkflowTools`. Change:

```ts
  const activateWorkflowTools = () => {
    const active = pi.getActiveTools();
    const missing = [workflowTool.name, workflowHelpTool.name, subagentTool.name].filter((nm) => !active.includes(nm));
    if (missing.length) {
      pi.setActiveTools([...active, ...missing]);
    }
  };
```

to:

```ts
  const activateWorkflowTools = () => {
    const active = pi.getActiveTools();
    const missing = [workflowTool.name, workflowHelpTool.name, subagentTool.name, workflowControlTool.name].filter(
      (nm) => !active.includes(nm),
    );
    if (missing.length) {
      pi.setActiveTools([...active, ...missing]);
    }
  };
```

- [ ] **Step 3: Run the full package test suite**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test )`
Expected: PASS, no regressions in any existing test file (the barrel export and extension wiring are additive-only).

- [ ] **Step 4: Run the typecheck**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build )`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/index.ts bun-apps/pi-agent-ext-workflow/extensions/workflow.ts
git commit -m "feat(pi-agent-ext-workflow): activate workflow_control every turn

Registered alongside workflow/subagent/workflow_help with the same
always-active pattern — no new lifecycle hook."
```

---

### Task 7: Update `CONTEXT.md` and `PRD.md`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-workflow/PRD.md`

- [ ] **Step 1: Add the `workflow_control` term to `CONTEXT.md`**

In `CONTEXT.md`, insert a new term after the existing `**Saved workflow**` entry and before the `### Quality & control` heading. Current text at that boundary:

```
**Saved workflow**:
A run's script turned into a reusable `/<name>` command; composable from inside other scripts via `workflow(name, args)`.
_Avoid_: template, macro

### Quality & control
```

New text:

```
**Saved workflow**:
A run's script turned into a reusable `/<name>` command; composable from inside other scripts via `workflow(name, args)`.
_Avoid_: template, macro

**`workflow_control`**:
The model-callable control surface for a background run — `stop`/`pause`/`resume`/`status`/`list`/`wait` — mirroring `/workflows`'s human-typed surface but reachable by the LLM itself without a user typing a command. Only knows `workflow`-tool run ids; a `subagent`-tool call has no run identity to control.
_Avoid_: task management, subagent control

### Quality & control
```

- [ ] **Step 2: Add a row to the `PRD.md` Tools/Commands table**

In `PRD.md`, the Tools/Commands table currently ends with:

```
| `/workflows-trigger set/off/status` | Manage keyword auto-trigger |
```

Add a new row right after it:

```
| `/workflows-trigger set/off/status` | Manage keyword auto-trigger |
| `workflow_control` tool | Model-callable stop/pause/resume/status/list/wait for a background run |
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/CONTEXT.md bun-apps/pi-agent-ext-workflow/PRD.md
git commit -m "docs(pi-agent-ext-workflow): document workflow_control in CONTEXT.md + PRD.md"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the package's full test command**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: `check` (biome), `build` (tsc), and `test:unit` (bun test) all pass with exit 0.

- [ ] **Step 2: Confirm no other package broke**

Run: `( cd bun-apps/pi-agent && bash run-test.sh high )`
Expected: PASS — this is pi-agent's unit + patches + deploy e2e gate, and `pi-agent-ext-workflow` is loaded eagerly via `run-dir/manifest.json`, so a broken export or tool registration here would surface as a deploy/runtime-probe failure there.

- [ ] **Step 3: Report done**

No code changes in this step — if both commands passed, the plan is complete.
