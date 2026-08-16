# Snapshot Row Single Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow package's presentation read one trusted projection: an exhaustive `persistedToSnapshot` adapter (unmapped persisted field = compile error), one `agentCounts()` derivation, one delivery-text builder, a typed `runStatusGlyph()` — then a time-boxed spike (with user decision gate) on retiring `ActivityRow`.

**Architecture:** Wave 1 (Tasks 1–4) is four mechanical, byte-identical-output refactors inside `bun-apps/pi-agent-ext-workflow`. Ticket 01 moves the persisted→snapshot constructor into `run-persistence.ts` behind a compile-time-exhaustive projection table; ticket 02 converges all per-site status-filter counts onto one `agentCounts()` in `display.ts`; ticket 03 merges the two delivery-text builders with the persisted path riding the ticket-01 adapter; ticket 04 replaces both untyped `STATUS_ICON` maps with a total `runStatusGlyph()`. Wave 2 (Task 5) is a findings-only spike — no production code.

**Tech Stack:** TypeScript (Bun runtime), `bun test` + `bunx tsc`, Biome. The package gate `bun run test` = `bun run check` (Biome) + `bun run build` (tsc — this is what enforces the compile-time exhaustiveness checks) + `bun run test:unit` (bun test).

## Global Constraints

(From spec §4/§5 — apply to every task.)

- **Byte-identical rendered output** for every Wave-1 task: no glyph, wording, spacing, or ordering changes. Expected rendered-output diffs: none.
- **No `RunStatus`/`ActivityStatus` vocabulary merge** — the two unions stay separate and separately typed.
- **Only `bun-apps/pi-agent-ext-workflow` is touched.** No edits under `pi-agent-ext-core-runtime`, `pi-agent-ext-subagents`, or any other package (spec non-goal: subagent-package findings are a separate future effort).
- **`ActivityRow` usage is untouched in Wave 1** — `workflow-ui.ts:432–440` and `task-panel.ts:346–355` keep building/rendering `ActivityRow` exactly as today. Its fate is decided by the Task 5 spike only.
- **Canonical gate for every task:** `( cd bun-apps/pi-agent-ext-workflow && bun run test )` — run from the repo root, never top-level `cd` (use the subshell form as written).
- **Existing tests stay green throughout.**
- No new dependencies. No new files outside `bun-apps/pi-agent-ext-workflow/{src,tests}` except Task 5's findings file in this effort dir.

## File Structure

- `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` — owns `PersistedRunState`/`PersistedAgentState`/`RunStatus`; after Task 1 also owns the exported `persistedToSnapshot` adapter + the exhaustive `agentProjection` table.
- `bun-apps/pi-agent-ext-workflow/src/display.ts` — owns `WorkflowSnapshot` presentation; after Task 2 owns `agentCounts()`; after Task 4 owns `runStatusGlyph()`.
- `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts` — navigator; loses its local `persistedToSnapshot` (Task 1), its `STATUS_ICON` map (Task 4), and its inline count filters (Task 2).
- `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts` — loses its `STATUS_ICON` map (Task 4) and inline count filters (Task 2).
- `bun-apps/pi-agent-ext-workflow/src/task-panel.ts` — delivery text unified (Task 3), inline count filters converged (Task 2).
- `bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts` — `workflowPreview` counts converge (Task 2).
- `bun-apps/pi-agent-ext-workflow/tests/run-persistence.test.ts`, `tests/workflow-display.test.ts`, `tests/task-panel.test.ts` — regression homes for Tasks 1–4.
- `.planning/2026-08-15-snapshot-row-single-source/spike-findings.md` — Task 5's only write artifact.

**Dependency order:** Task 1 → Task 2 (adapter counters reuse `agentCounts`) → Task 3 (persisted path rides the adapter). Task 4 is independent of 1–3 (do it last or in parallel). Task 5 runs only after Wave 1 lands.

---

### Task 1: Exhaustive `persistedToSnapshot` adapter in `run-persistence.ts` (ticket 01)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` (add adapter + projection table after the `PersistedRunState` interface, ~line 113)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts:193–224` (delete local `persistedToSnapshot`, import the adapter)
- Test: `bun-apps/pi-agent-ext-workflow/tests/run-persistence.test.ts` (round-trip + legacy-omit regressions)

**Interfaces:**
- Consumes: `PersistedRunState`, `PersistedAgentState` (already in `run-persistence.ts`); `WorkflowSnapshot` type from `./display.js` (type-only import — `display.ts` does not import `run-persistence.ts`, so no cycle).
- Produces: `export function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot` — exact same shape and values as today's private copy in `workflow-ui.ts`. Tasks 2 and 3 depend on this export.

- [ ] **Step 1: Write the failing tests**

Add to `tests/run-persistence.test.ts` (top of file, extend the existing import from `"../src/run-persistence.js"` to include `persistedToSnapshot`):

```ts
import {
  createRunPersistence,
  generateRunId,
  persistedToSnapshot,
  type PersistedAgentState,
  type PersistedRunState,
} from "../src/run-persistence.js";

function fullAgent(): PersistedAgentState {
  return {
    id: 1,
    label: "builder",
    phase: "Build",
    prompt: "build it",
    status: "done",
    result: { verdict: "ok" },
    history: [{ role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" }],
    startedAt: "2025-06-01T12:00:00.000Z",
    endedAt: "2025-06-01T12:01:00.000Z",
    tokens: 1234,
    model: "anthropic/claude-sonnet-4",
  };
}

test("persistedToSnapshot round-trips every PersistedAgentState field", () => {
  const agent = fullAgent();
  const errored: PersistedAgentState = {
    id: 2,
    label: "failing",
    prompt: "try it",
    status: "error",
    error: "boom",
    errorCode: "E_TOOL" as PersistedAgentState["errorCode"],
    recoverable: true,
  };
  const state: PersistedRunState = {
    runId: "r-full",
    workflowName: "full-run",
    script: "export const meta = { name: 'f' }",
    status: "completed",
    phases: ["Build"],
    currentPhase: "Build",
    agents: [agent, errored],
    logs: ["log line"],
    result: "done",
    startedAt: "2025-06-01T12:00:00.000Z",
    updatedAt: "2025-06-01T12:01:00.000Z",
    durationMs: 60000,
    tokenUsage: { input: 10, output: 20, total: 30 },
  };
  const snap = persistedToSnapshot(state);
  assert.equal(snap.name, "full-run");
  assert.equal(snap.runId, "r-full");
  assert.equal(snap.phases.length, 1);
  assert.equal(snap.currentPhase, "Build");
  assert.deepEqual(snap.logs, ["log line"]);
  assert.deepEqual(snap.tokenUsage, { input: 10, output: 20, total: 30 });

  const a = snap.agents[0]!;
  assert.equal(a.id, agent.id);
  assert.equal(a.label, agent.label);
  assert.equal(a.phase, agent.phase);
  assert.equal(a.prompt, agent.prompt);
  assert.equal(a.status, agent.status);
  assert.equal(a.resultPreview, '{"verdict":"ok"}');
  assert.deepEqual(a.history, agent.history);
  assert.equal(a.startedAt, Date.parse("2025-06-01T12:00:00.000Z"));
  assert.equal(a.tokens, agent.tokens);
  assert.equal(a.model, agent.model);

  const e = snap.agents[1]!;
  assert.equal(e.status, "error");
  assert.equal(e.error, "boom");
  assert.equal(e.errorCode, errored.errorCode);
  assert.equal(e.recoverable, true);

  assert.equal(snap.agentCount, 2);
  assert.equal(snap.doneCount, 1);
  assert.equal(snap.runningCount, 0);
  assert.equal(snap.errorCount, 1);
});

test("persistedToSnapshot degrades gracefully on legacy persisted JSON (no tokens/model/startedAt)", () => {
  const state = {
    runId: "r-legacy",
    workflowName: "legacy-run",
    status: "completed",
    phases: ["Build"],
    agents: [{ id: 1, label: "old builder", phase: "Build", status: "done", prompt: "build it", result: "ok" }],
    logs: [],
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as unknown as PersistedRunState;
  const snap = persistedToSnapshot(state);
  assert.equal(snap.agentCount, 1);
  assert.equal(snap.doneCount, 1);
  assert.equal(snap.agents[0]!.tokens, undefined, "legacy files without tokens map to undefined");
  assert.equal(snap.agents[0]!.model, undefined, "legacy files without model map to undefined");
  assert.equal(snap.agents[0]!.startedAt, undefined, "legacy files without startedAt map to undefined");
});
```

(`errorCode` typing: if `"E_TOOL" as …` fights the `WorkflowErrorCode` union, use any literal the union accepts — the point of this assertion is only "the field maps through".)

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/run-persistence.test.ts )`
Expected: FAIL — `persistedToSnapshot` is not exported from `run-persistence.js`.

- [ ] **Step 3: Implement the adapter in `run-persistence.ts`**

Add a type-only import at the top (after the existing imports):

```ts
import type { WorkflowSnapshot } from "./display.js";
```

Add after the `PersistedRunState` interface (before `export interface RunPersistence`):

```ts
/**
 * Project a persisted run back into the UI's WorkflowSnapshot shape. Moved
 * from workflow-ui.ts (snapshot-row-single-source, ticket 01) so the mapping
 * lives beside the type it must stay exhaustive over.
 *
 * `agentProjection` has one row per key of PersistedAgentState; the
 * `Record<keyof PersistedAgentState, …>` annotation makes the table exhaustive
 * in both directions: a NEW persisted field without a row is a compile error
 * (the PR-#1362 bug class — new field, silently blank resumed row), and a row
 * for a REMOVED field is an excess-property error. The gate's `bun run build`
 * (tsc) step is what enforces this.
 */
const agentProjection: Record<keyof PersistedAgentState, (a: PersistedAgentState) => unknown> = {
  id: (a) => a.id,
  label: (a) => a.label,
  phase: (a) => a.phase,
  prompt: (a) => a.prompt,
  status: (a) => a.status,
  result: (a) =>
    a.result == null ? undefined : String(typeof a.result === "string" ? a.result : JSON.stringify(a.result)),
  error: (a) => a.error,
  errorCode: (a) => a.errorCode,
  recoverable: (a) => a.recoverable,
  history: (a) => a.history,
  startedAt: (a) => (a.startedAt ? Date.parse(a.startedAt) : undefined),
  endedAt: () => undefined, // persisted-only (resume bookkeeping); no snapshot field
  tokens: (a) => a.tokens,
  model: (a) => a.model,
};

/** Run every projection row, then rename `result` → the snapshot's `resultPreview`. */
function projectAgent(a: PersistedAgentState): WorkflowSnapshot["agents"][number] {
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(agentProjection) as Array<keyof PersistedAgentState>) {
    projected[key] = agentProjection[key](a);
  }
  const { result, endedAt: _endedAt, ...rest } = projected;
  void _endedAt;
  return { ...rest, resultPreview: result } as WorkflowSnapshot["agents"][number];
}

export function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot {
  return {
    name: p.workflowName,
    phases: p.phases,
    currentPhase: p.currentPhase,
    logs: p.logs,
    agents: p.agents.map(projectAgent),
    agentCount: p.agents.length,
    runningCount: p.agents.filter((a) => a.status === "running").length,
    doneCount: p.agents.filter((a) => a.status === "done").length,
    errorCount: p.agents.filter((a) => a.status === "error").length,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    runId: p.runId,
  };
}
```

Field values are byte-identical to the old `workflow-ui.ts` copy (including `tokens: a.tokens ?? undefined` semantics — `a.tokens` is `number | undefined`, identical).

- [ ] **Step 4: Delete the local copy in `workflow-ui.ts`**

In `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts`:
1. Change line 28 from `import type { PersistedRunState } from "./run-persistence.js";` to `import { persistedToSnapshot, type PersistedRunState } from "./run-persistence.js";`
2. Delete the whole private `function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot` (lines 193–224).

Nothing else in `workflow-ui.ts` changes — the two call sites (`:101` and tests) resolve to the import.

- [ ] **Step 5: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS — including the pre-existing `tests/workflow-ui.test.ts` regression suite ("persistedToSnapshot round-trips tokens + startedAt…", "…tolerates old persisted files…"), which now exercises the moved adapter through `NavigatorModel`.

- [ ] **Step 6: Verify the exhaustiveness check actually fires**

Temporarily comment out the `tokens: (a) => a.tokens,` row in `agentProjection`, then:

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build )`
Expected: FAIL — tsc reports a missing property `tokens` in the `Record<keyof PersistedAgentState, …>`.
Restore the row and re-run — expected PASS. (This step lands no diff; it proves the invariant.)

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/run-persistence.ts bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/tests/run-persistence.test.ts
git commit -m "refactor(workflow): exhaustive persistedToSnapshot adapter in run-persistence (ticket 01)

Move the PersistedRunState -> WorkflowSnapshot constructor from workflow-ui.ts
into run-persistence.ts behind a Record<keyof PersistedAgentState, …> projection
table: a new persisted agent field without a projection row is now a compile
error (the PR-#1362 bug class), not a silently blank resumed row."
```

---

### Task 2: `agentCounts(agents)` single derivation (ticket 02)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/display.ts:82–88` (`agentCounts` beside `recomputeWorkflowSnapshot`; refactor `recomputeWorkflowSnapshot` onto it)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts:110–115` (`NavigatorModel.runs()`), `:155` (`phases()` rows)
- Modify: `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` (`persistedToSnapshot` counters, currently lines 215–218 region post-Task-1)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts:33–34` (`summarizeRun`), `:40–43` (`oneLineProgress`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/task-panel.ts:243` (`renderPanel`), `:327–330` (`renderRunBody`), `:386` (`renderPanelDetailed`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts:65–71` (`workflowPreview`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts`

**Interfaces:**
- Consumes: Task 1's exported `persistedToSnapshot` (its counters move onto the helper).
- Produces: `export interface AgentCounts { total: number; running: number; done: number; error: number; skipped: number; finished: number }` and `export function agentCounts(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): AgentCounts` in `display.ts`. `finished` = done + error + skipped (statuses that will not change again). The `Pick` parameter accepts both `WorkflowAgentSnapshot[]` and `PersistedAgentState[]` (their `status` unions are identical).

- [ ] **Step 1: Write the failing tests**

Add to `tests/workflow-display.test.ts` (extend existing imports from `"../src/display.js"` with `agentCounts`, `recomputeWorkflowSnapshot`; add imports `import { persistedToSnapshot, type PersistedAgentState, type PersistedRunState } from "../src/run-persistence.js";` and `import { summarizeRun } from "../src/workflow-commands.js";`):

```ts
test("agentCounts counts every status in one pass", () => {
  const agents = [
    { status: "done" },
    { status: "running" },
    { status: "error" },
    { status: "skipped" },
    { status: "queued" },
  ] as Array<Pick<WorkflowAgentSnapshot, "status">>;
  const c = agentCounts(agents);
  assert.equal(c.total, 5);
  assert.equal(c.done, 1);
  assert.equal(c.running, 1);
  assert.equal(c.error, 1);
  assert.equal(c.skipped, 1);
  assert.equal(c.finished, 3, "finished = done + error + skipped");
  assert.equal(agentCounts([]).total, 0);
});

test("agentCounts: every converged site agrees on the same agents array", () => {
  const agents: PersistedAgentState[] = [
    { id: 1, label: "a", prompt: "p", status: "done" },
    { id: 2, label: "b", prompt: "p", status: "running" },
    { id: 3, label: "c", prompt: "p", status: "error" },
    { id: 4, label: "d", prompt: "p", status: "skipped" },
    { id: 5, label: "e", prompt: "p", status: "queued" },
  ];
  const c = agentCounts(agents);

  // persisted adapter rollup counters == helper output
  const state = {
    runId: "r-counts",
    workflowName: "counts",
    status: "running",
    phases: [],
    agents,
    logs: [],
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as unknown as PersistedRunState;
  const snap = persistedToSnapshot(state);
  assert.equal(snap.agentCount, c.total);
  assert.equal(snap.runningCount, c.running);
  assert.equal(snap.doneCount, c.done);
  assert.equal(snap.errorCount, c.error);

  // live recomputation == same derivation
  const recomputed = recomputeWorkflowSnapshot(snap);
  assert.equal(recomputed.doneCount, snap.doneCount);
  assert.equal(recomputed.runningCount, snap.runningCount);
  assert.equal(recomputed.errorCount, snap.errorCount);
  assert.equal(recomputed.agentCount, snap.agentCount);

  // /workflows list summary shows the same done/total
  assert.ok(summarizeRun(state).includes(`1/5 agents`), summarizeRun(state));
});
```

(If `tests/workflow-display.test.ts` does not already import `WorkflowSnapshot`, add it to the display.js type import.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-display.test.ts )`
Expected: FAIL — `agentCounts` is not exported from `display.js`.

- [ ] **Step 3: Implement `agentCounts` in `display.ts`**

Replace `recomputeWorkflowSnapshot` (lines 82–88) with:

```ts
export interface AgentCounts {
  total: number;
  running: number;
  done: number;
  error: number;
  skipped: number;
  /** done + error + skipped — statuses that will not change again. */
  finished: number;
}

/**
 * The single agent-status count derivation (snapshot-row-single-source,
 * ticket 02). Every presentation site that needs done/running/error/skipped/
 * finished counts calls this — no per-site `agents.filter(...)` copies. Accepts
 * anything with a `status` field, so both WorkflowAgentSnapshot[] (live) and
 * PersistedAgentState[] (persisted) work.
 */
export function agentCounts(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): AgentCounts {
  let running = 0;
  let done = 0;
  let error = 0;
  let skipped = 0;
  for (const a of agents) {
    if (a.status === "running") running++;
    else if (a.status === "done") done++;
    else if (a.status === "error") error++;
    else if (a.status === "skipped") skipped++;
  }
  return { total: agents.length, running, done, error, skipped, finished: done + error + skipped };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const counts = agentCounts(snapshot.agents);
  return {
    ...snapshot,
    agentCount: counts.total,
    runningCount: counts.running,
    doneCount: counts.done,
    errorCount: counts.error,
  };
}
```

- [ ] **Step 4: Converge the six call-site clusters**

Each edit replaces `filter(...).length` counting with the helper. Rendered strings are assembled from the same numbers, so output is byte-identical.

`src/run-persistence.ts` — inside `persistedToSnapshot`, replace the four counter lines with:

```ts
  const counts = agentCounts(p.agents);
  return {
    name: p.workflowName,
    phases: p.phases,
    currentPhase: p.currentPhase,
    logs: p.logs,
    agents: p.agents.map(projectAgent),
    agentCount: counts.total,
    runningCount: counts.running,
    doneCount: counts.done,
    errorCount: counts.error,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    runId: p.runId,
  };
```

and change the display import to a value import: `import { agentCounts, type WorkflowSnapshot } from "./display.js";` (runtime direction is one-way: `run-persistence → display`; `display.ts` imports `run-persistence` only as a type in Task 4, which erases — no runtime cycle).

`src/workflow-ui.ts` — in `NavigatorModel.runs()` (line 110–115 region):

```ts
      const agents = (live?.snapshot.agents ?? p.agents) as WorkflowAgentSnapshot[];
      const counts = agentCounts(agents);
      return {
        runId: p.runId,
        name: live?.snapshot.name ?? p.workflowName,
        status: live?.status ?? p.status,
        done: counts.done,
        total: counts.total,
        tokens: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.total ?? 0,
        cost: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.cost ?? 0,
      };
```

and in `phases()` (line 155 region), the row build becomes:

```ts
    return order.map((title) => {
      const agents = byPhase.get(title) ?? [];
      const counts = agentCounts(agents);
      return {
        title,
        done: counts.done,
        total: counts.total,
        tokens: agents.reduce((n, a) => n + (a.tokens ?? 0), 0),
      };
    });
```

Add `agentCounts` to the existing `./display.js` import line.

`src/workflow-commands.ts` — `summarizeRun` (lines 33–34):

```ts
export function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_ICON[run.status] ?? "?"; // STATUS_ICON replaced in Task 4; unchanged here
  const counts = agentCounts(run.agents);
  const tokens = run.tokenUsage ? ` · ${run.tokenUsage.total.toLocaleString()} tok` : "";
  return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${counts.done}/${counts.total} agents${tokens}`;
}
```

`oneLineProgress` (lines 40–43):

```ts
function oneLineProgress(snapshot: WorkflowSnapshot): string {
  const counts = agentCounts(snapshot.agents);
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  return `◆ ${snapshot.name}: ${counts.done}/${counts.total} done${
    counts.running ? `, ${counts.running} running` : ""
  }${counts.error ? `, ${counts.error} err` : ""}${phase}`;
}
```

Add `agentCounts` to the existing `./display.js` import.

`src/task-panel.ts` — `renderPanel` (line 243): replace `const done = agents.filter((a) => a.status === "done").length;` with `const done = agentCounts(agents).done;`. `renderPanelDetailed` (line 386): same replacement. `renderRunBody` (lines 327–330), replace the four count lines and `complete`:

```ts
    const counts = agentCounts(phaseAgents);
    const complete = counts.finished === counts.total;
    const marker = counts.running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseTokens = phaseAgents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    const phaseMeta = [
      `${counts.done}/${counts.total} agents`,
      counts.running ? `${counts.running} running` : "",
      counts.error ? `${counts.error} errors` : "",
      phaseTokens > 0 ? `${fmtTokensShort(phaseTokens)} tok` : "",
    ]
```

Add `agentCounts` to the existing `./display.js` import (it currently imports only types — make it `import { agentCounts, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";`).

`src/workflow-manager.ts` — `workflowPreview` (lines 65–71):

```ts
export function workflowPreview(snapshot: WorkflowSnapshot): string {
  const c = agentCounts(snapshot.agents);
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  const counts = c.total > 0 ? ` · ${c.finished}/${c.total} agents` : "";
  return `${snapshot.name}${phase}${counts}`;
}
```

Change line 12 to `import { agentCounts, type WorkflowSnapshot } from "./display.js";`.

- [ ] **Step 5: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS, zero rendered-output diffs (all existing workflow-ui / workflow-commands / task-panel / workflow-manager tests green).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/src/run-persistence.ts bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts bun-apps/pi-agent-ext-workflow/src/task-panel.ts bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts
git commit -m "refactor(workflow): single agentCounts() derivation across all count sites (ticket 02)

One exported helper in display.ts replaces the per-site
agents.filter(a => a.status === …) copies in workflow-ui, the persisted
adapter rollup, workflow-commands (summarizeRun/oneLineProgress), task-panel
(renderPanel/renderRunBody/renderPanelDetailed), and workflowPreview; snapshot
rollup counters now derive once from the same function as recomputeWorkflowSnapshot."
```

---

### Task 3: Unified delivery text (ticket 03; depends on Task 1)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/task-panel.ts:82–90` (`deliverText`), `:178–197` (`deliverTextFromPersisted`), `:224` (call site in `redeliverPendingResults`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` (adapter maps run-level `result` + `durationMs`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/task-panel.test.ts`

**Interfaces:**
- Consumes: Task 1's `persistedToSnapshot`; Task 2's `agentCounts` (already imported in task-panel if Task 2 ran; not needed here otherwise).
- Produces: `export function deliverText(run: ManagedRun): string` (unchanged signature — existing callers/tests untouched) and `export function deliverTextFromSnapshot(p: PersistedRunState): string` (new export, replaces the private `deliverTextFromPersisted`). Internal shared builder: `deliverTextBody(facts: DeliveryFacts, lead: string, suffix?: string): string` with `export interface DeliveryFacts { name: string; result?: unknown; agentCount: number; tokenUsage?: { total: number } | undefined; durationMs?: number | undefined }`.

- [ ] **Step 1: Write the failing test**

Add to `tests/task-panel.test.ts` (inside the existing top-level imports, add `import type { PersistedRunState } from "../src/run-persistence.js";` if absent; `mod` is the existing `import * as mod from "../src/task-panel.js"` pattern used by this file):

```ts
describe("deliverText / deliverTextFromSnapshot share one builder", () => {
  const persisted: PersistedRunState = {
    runId: "r-dual",
    workflowName: "test-workflow",
    script: "export const meta = { name: 't' }",
    status: "completed",
    phases: [],
    agents: [
      { id: 1, label: "a", prompt: "p", status: "done" },
      { id: 2, label: "b", prompt: "p", status: "done" },
      { id: 3, label: "c", prompt: "p", status: "done" },
    ],
    logs: [],
    result: "All tests passed",
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:10.000Z",
    durationMs: 1500,
    tokenUsage: { input: 1, output: 2, total: 50000 },
  };

  it("persisted path renders via the adapter with the recovered lead", () => {
    const text = mod.deliverTextFromSnapshot(persisted);
    assert.ok(text.startsWith('✓ Background workflow "test-workflow" finished while this session was closed (3 agents'), text);
    assert.ok(/50[\s,.]?000 tokens/.test(text), text);
    assert.ok(text.includes("1.5s"), text);
    assert.ok(text.endsWith("Recovered result:\n\nAll tests passed"), text);
  });

  it("live and persisted variants share the identical tail for the same facts", () => {
    const live = mod.deliverText({
      runId: "r-dual",
      status: "completed",
      snapshot: { name: "test-workflow", agents: [], agentCount: 3, runningCount: 0, doneCount: 3, errorCount: 0, phases: [], logs: [] },
      result: { result: "All tests passed", agentCount: 3, durationMs: 1500, tokenUsage: { input: 1, output: 2, total: 50000, cost: 0 } },
    } as unknown as Parameters<typeof mod.deliverText>[0]);
    const viaSnapshot = mod.deliverTextFromSnapshot(persisted);
    const tail = (s: string) =>
      s.split("\n")[0]!.replace(/^✓ Background workflow "test-workflow" finished( while this session was closed)?/, "");
    assert.equal(tail(viaSnapshot), tail(live));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/task-panel.test.ts )`
Expected: FAIL — `mod.deliverTextFromSnapshot` is not a function.

- [ ] **Step 3: Extend the adapter with run-level `result` + `durationMs`**

In `src/run-persistence.ts`, inside `persistedToSnapshot`'s return object, add two mappings (the `WorkflowSnapshot` type already declares both optional fields; nothing reads them on this path today, so rendered output is unchanged):

```ts
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    durationMs: p.durationMs,
    result: p.result,
    runId: p.runId,
```

- [ ] **Step 4: Replace the two builders in `task-panel.ts`**

Change the run-persistence import to a value import: `import { persistedToSnapshot, type PersistedRunState } from "./run-persistence.js";`

Replace `deliverText` (lines 82–90) AND the whole private `deliverTextFromPersisted` (its doc comment at ~178 through the function end) with:

```ts
/** Fields both delivery paths share — the common subset of a live run's
 * WorkflowRunResult and a persisted run projected through persistedToSnapshot. */
export interface DeliveryFacts {
  name: string;
  result?: unknown;
  agentCount: number;
  tokenUsage?: { total: number } | undefined;
  durationMs?: number | undefined;
}

/** Shared delivery body: lead sentence + "(N agents · tokens · duration)" tail
 * + blank line + summarized result. `suffix` carries the persisted path's
 * " Recovered result:" marker; everything else is byte-identical by construction. */
function deliverTextBody(facts: DeliveryFacts, lead: string, suffix = ""): string {
  const summary = summarizeResult(facts.result);
  const tokens = facts.tokenUsage ? ` · ${facts.tokenUsage.total.toLocaleString()} tokens` : "";
  const duration = facts.durationMs ? ` · ${fmtElapsed(facts.durationMs)}` : "";
  return [`${lead} (${facts.agentCount} agents${tokens}${duration}).${suffix}`, "", summary].join("\n");
}

export function deliverText(run: ManagedRun): string {
  return deliverTextBody(
    {
      name: run.snapshot.name,
      result: run.result?.result,
      agentCount: run.result?.agentCount ?? run.snapshot.agentCount,
      tokenUsage: run.result?.tokenUsage,
      durationMs: run.result?.durationMs,
    },
    `✓ Background workflow "${run.snapshot.name}" finished`,
  );
}

/**
 * Delivery text for a persisted-only run (session_start re-delivery path).
 * Sources its fields THROUGH the persistedToSnapshot adapter (ticket 01) — not
 * raw PersistedRunState fields — so a future unmapped field cannot fork the
 * live and persisted texts apart again.
 */
export function deliverTextFromSnapshot(p: PersistedRunState): string {
  const snap = persistedToSnapshot(p);
  return deliverTextBody(
    {
      name: snap.name,
      result: snap.result,
      agentCount: snap.agentCount,
      tokenUsage: snap.tokenUsage,
      durationMs: snap.durationMs,
    },
    `✓ Background workflow "${snap.name}" finished while this session was closed`,
    " Recovered result:",
  );
}
```

In `redeliverPendingResults` (line ~224), change `deliverTextFromPersisted(run)` to `deliverTextFromSnapshot(run)`.

Output check (byte-identical): old live text was `✓ Background workflow "N" finished (X agents · T tokens · D).` + `\n\n` + summary — identical. Old persisted text was `✓ Background workflow "N" finished while this session was closed (X agents…). Recovered result:` + `\n\n` + summary — identical (the `.` before ` Recovered result:` and the space are preserved by the suffix string).

- [ ] **Step 5: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS — including the pre-existing `deliverText` and `redeliverPendingResults` suites (they assert on the live/recovered texts verbatim and must not change).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/task-panel.ts bun-apps/pi-agent-ext-workflow/src/run-persistence.ts bun-apps/pi-agent-ext-workflow/tests/task-panel.test.ts
git commit -m "refactor(workflow): unify deliverText/deliverTextFromPersisted over shared facts (ticket 03)

One deliverTextBody builder assembles both delivery variants; the persisted
(session_start re-delivery) path sources name/result/agentCount/tokenUsage/
durationMs through the persistedToSnapshot adapter instead of re-reading raw
PersistedRunState fields, so an unmapped persisted field can no longer fork
the live and recovered texts."
```

---

### Task 4: Typed `runStatusGlyph()` replaces both `STATUS_ICON` maps (ticket 04; independent of Tasks 1–3)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/display.ts` (add `runStatusGlyph` near `statusIcon`, ~line 271)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts:17–25` (delete map), `:32`, `:94`, `:115`, `:287` (call sites)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts:33–45` (delete map), `:399` (call site), `RunRow.status` typing (~line 65)
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts`

**Interfaces:**
- Consumes: `RunStatus` from `./run-persistence.js` (type-only import; `display.ts` ← type ← `run-persistence.ts` erases at runtime, so the Task-2 value import `run-persistence → display` stays acyclic).
- Produces: `export function runStatusGlyph(status: RunStatus): string` — total over `RunStatus` by construction (exhaustive `Record<RunStatus, string>`), no `"?"` fallback.

- [ ] **Step 1: Write the failing test**

Add to `tests/workflow-display.test.ts` (extend the display.js import with `runStatusGlyph`; add `import type { RunStatus } from "../src/run-persistence.js";`):

```ts
test("runStatusGlyph is total: every RunStatus maps to a real glyph, never ?", () => {
  const statuses: RunStatus[] = ["pending", "running", "paused", "completed", "failed", "aborted"];
  for (const s of statuses) {
    const glyph = runStatusGlyph(s);
    assert.notEqual(glyph, "?");
    assert.ok(glyph.length > 0, `empty glyph for ${s}`);
  }
  // glyph values match the maps being deleted (byte-identical rendered output)
  assert.equal(runStatusGlyph("pending"), "·");
  assert.equal(runStatusGlyph("running"), "◆");
  assert.equal(runStatusGlyph("paused"), "⏸");
  assert.equal(runStatusGlyph("completed"), "✓");
  assert.equal(runStatusGlyph("failed"), "✗");
  assert.equal(runStatusGlyph("aborted"), "⊘");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-display.test.ts )`
Expected: FAIL — `runStatusGlyph` is not exported from `display.js`.

- [ ] **Step 3: Implement `runStatusGlyph` in `display.ts`**

Add a type-only import at the top: `import type { RunStatus } from "./run-persistence.js";` and, beside `statusIcon` (~line 271):

```ts
/** Run-level status glyphs. Exhaustive Record<RunStatus, string>: adding a
 * RunStatus value without a glyph is a compile error, and every lookup is
 * total — the silent `?? "?"` fallback of the old STATUS_ICON maps is gone
 * by construction (snapshot-row-single-source, ticket 04). Agent-status
 * glyphs stay with activityGlyph (core-runtime/agent-row-display.ts). */
const RUN_STATUS_GLYPHS: Record<RunStatus, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

export function runStatusGlyph(status: RunStatus): string {
  return RUN_STATUS_GLYPHS[status];
}
```

- [ ] **Step 4: Delete both `STATUS_ICON` maps and converge call sites**

`src/workflow-commands.ts`:
1. Delete the whole `const STATUS_ICON: Record<string, string> = { … };` block (lines 17–25).
2. Add `runStatusGlyph` to the existing `./display.js` import.
3. Replace four call sites:
   - `:32` in `summarizeRun`: `const icon = STATUS_ICON[run.status] ?? "?";` → `const icon = runStatusGlyph(run.status);`
   - `:94` in `renderPersistedStatus`: `` const lines = [`${STATUS_ICON[run.status] ?? "?"} …`] `` → `` const lines = [`${runStatusGlyph(run.status)} …`] ``
   - `:115` in `renderPersistedResult`: `const head = \`${STATUS_ICON[run.status] ?? "?"} …\`` → `const head = \`${runStatusGlyph(run.status)} …\``
   - `:287` in the `result` subcommand's finished-runs list: `const icon = STATUS_ICON[r.status] ?? "?";` → `const icon = runStatusGlyph(r.status);`

`src/workflow-ui.ts`:
1. Delete the whole `const STATUS_ICON: Record<string, string> = { … };` block (lines 33–45). Its agent-status entries (`queued`/`done`/`error`/`skipped`) were dead weight for this map's only call site — run rows. Agent rows render via `renderActivityRow`/`activityGlyph`, which is untouched.
2. Add `runStatusGlyph` to the existing `./display.js` import and add `RunStatus` to the `./run-persistence.js` import.
3. Tighten `RunRow.status` from `string` to `RunStatus` (the `runs()` builder assigns `live?.status ?? p.status`, both `RunStatus` — this types the glyph call with no cast):
   ```ts
   interface RunRow {
     runId: string;
     name: string;
     status: RunStatus;
     done: number;
     total: number;
     tokens: number;
     cost: number;
   }
   ```
4. `:399` in `renderNavigator`: `const icon = STATUS_ICON[r.status] ?? "?";` → `const icon = runStatusGlyph(r.status);`

- [ ] **Step 5: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS, byte-identical glyph output everywhere.

- [ ] **Step 6: Verify the type-level exhaustiveness actually fires**

Temporarily comment out `aborted: "⊘",` in `RUN_STATUS_GLYPHS`, then:

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build )`
Expected: FAIL — tsc reports the missing property. Restore the row (no diff lands).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts
git commit -m "refactor(workflow): typed runStatusGlyph replaces both STATUS_ICON maps (ticket 04)

One exhaustive Record<RunStatus, string> in display.ts replaces the untyped
Record<string, string> maps in workflow-commands.ts and workflow-ui.ts: a new
RunStatus value without a glyph is now a compile error instead of a silent ?
fallback. RunRow.status is typed RunStatus; agent-status glyphs remain with
activityGlyph."
```

---

### Task 5: Wave-2 spike — what does task-panel/workflow-ui need from `ActivityRow`? (ticket 05; findings only)

**Files:**
- Read-only: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts:424–441` (agents view `ActivityRow` build), `bun-apps/pi-agent-ext-workflow/src/task-panel.ts:340–356` (`renderRunBody` agent rows), `bun-apps/pi-agent-ext-core-runtime/src/agent-row-display.ts` (`activityGlyph`, `renderActivityRow`, RunView projection)
- Create: `.planning/2026-08-15-snapshot-row-single-source/spike-findings.md` (this effort dir — the ticket's ONLY write artifact)
- Optional write: `bun-apps/pi-agent-ext-workflow/CONTEXT.md` (only if the recommendation is "keep")
- **No production code changes land from this task.** A scratch prototype on an unmerged branch is fine.

**Interfaces:** none — this task produces a findings document, not code.

**Time-box:** one session (~half day). If the spike overruns, stop and record partial findings — no scope extension.

**USER DECISION GATE — read before starting:** the spike outcome is reported to the user BEFORE any retirement work is planned or executed. This task delivers findings + recommendation ONLY. `ActivityRow` retirement would be a follow-up effort approved explicitly by the user. Do not start it here, even if the recommendation is "retire".

- [ ] **Step 1: Map the field-by-field `ActivityRow` ↔ RunView delta**

Read the three files above and fill the delta table in the findings template below. For each field the workflow side sets on `ActivityRow` (`status`, `actor`, `model`, `elapsedMs`, `tokens`, `latestAction` via `summarizeLatestAction`, `badge`) record: does the RunView stack (`agent-row-display.ts` → `renderRunRow`) already encode it, encode it differently (state the semantic difference, e.g. elapsed-freeze), or not at all?

- [ ] **Step 2: Measure hydration cost and fidelity**

On a scratch branch (do not merge), prototype hydrating `WorkflowSnapshot.agents → RunView → renderRunRow` for the navigator agents view (`workflow-ui.ts:424–441`). Measure/estimate: per-render cost for a 100-agent run (the package README's scale bar), whether `latestAction`, model fallback segment, and snapshot-only sourcing survive, and whether elapsed-freeze semantics match `Date.now() - startedAt` live ticking (`workflow-ui.ts`'s 1s `liveTimer`).

- [ ] **Step 3: Write the findings document**

Create `.planning/2026-08-15-snapshot-row-single-source/spike-findings.md` with exactly this structure (fill every section — no "TBD"):

```markdown
# Spike findings — ActivityRow retirement (ticket 05)

> Wave 2 · spec §3 · time-boxed: one session · date: YYYY-MM-DD

## Question

Can task-panel / workflow-ui hydrate `agents → RunView → renderRunRow` cheaply
and faithfully, making ActivityRow production usage retireable (test-fixture-only)?

## (a) Field-by-field ActivityRow ↔ RunView delta

| Field (workflow-ui.ts:432–440 sets) | RunView equivalent | Faithful? / semantic delta |
| --- | --- | --- |
| status | … | … |
| actor | … | … |
| model | … | … |
| elapsedMs (live `Date.now() - startedAt`) | … | … |
| tokens | … | … |
| latestAction (`summarizeLatestAction(history)`) | … | … |

(task-panel.ts:346–355 adds `badge: "[id]"` — record its RunView fate too.)

## (b) Hydration cost

(Per-render cost for a 100-agent run; re-render cadence compatibility with the
navigator's 1s liveTimer; any allocation/format hot spots.)

## (c) Recommendation — retire vs keep-and-document

(One of: **retire** — cheap + faithful, propose follow-up effort | **keep** —
expensive/lossy, document why. State the deciding evidence.)

## User decision record

Reported to user on YYYY-MM-DD: <pending user decision — no retirement work
planned or executed before approval>
```

- [ ] **Step 4: If (and only if) the recommendation is "keep"**

Append the why to `bun-apps/pi-agent-ext-workflow/CONTEXT.md` under a "ActivityRow (kept)" note: one paragraph stating RunView hydration was measured and why it loses. If the recommendation is "retire", skip this step — the follow-up effort writes the plan after the user approves.

- [ ] **Step 5: Run the package gate (must be untouched)**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS with zero source diffs on this task's commit (`git diff --stat` shows only the findings/CONTEXT docs). Delete the scratch prototype branch.

- [ ] **Step 6: STOP at the user decision gate**

Present the findings summary to the user and ask for the retire/keep decision. **Do not plan or execute any retirement work in this effort.** Then commit:

```bash
git add .planning/2026-08-15-snapshot-row-single-source/spike-findings.md
# plus bun-apps/pi-agent-ext-workflow/CONTEXT.md if Step 4 ran
git commit -m "docs(planning): snapshot-row ActivityRow retirement spike findings (ticket 05)

Field-by-field ActivityRow vs RunView delta, hydration cost measurement, and
a retire/keep recommendation. Retirement is NOT executed here: outcome
reported to the user at the decision gate before any follow-up is planned."
```

---

## Verification (effort-level)

- Every task's gate: `( cd bun-apps/pi-agent-ext-workflow && bun run test )` from the repo root — green before each commit.
- Wave-1 bar: zero rendered-output diffs (all pre-existing tests green, no new visual behavior).
- Compile-time invariants proven live during Tasks 1 and 4 (comment-out-a-row → tsc fails → restore).
- Task 5 delivers findings only; production code identical before/after.
