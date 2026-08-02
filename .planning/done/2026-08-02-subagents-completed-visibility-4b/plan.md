# subagents Completed-visibility (deficit 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `subagents` batch children appear as selectable entries in the `/subagents` viewer's **Completed** section after the batch ends — task/model/status/usage each visible, selectable → `output` view shows frozen output — matching the singular-`subagent` Completed richness.

**Architecture:** Source batch-child data from the **branch** (Option B'): enrich each batch result slot with `task`/`model`/`elapsedMs` at execution time (data already in scope), then widen `reconstructSubagentRuns` to expand a `subagents` toolResult into N child `SubagentRun` entries tagged with a shared `batchToolCallId`. The viewer's Completed section then groups those children under a collapsible header, reusing the Running section's `collapsedBatches` set (keyed by the batch's `toolCallId`). No durable-store coupling, no `SubagentRunRecord` schema change. Session-scoped.

**Tech Stack:** TypeScript (Bun), `bun:test` + `node:assert/strict`. Package: `bun-apps/pi-agent-ext-subagent`.

## Global Constraints

- **`renderBatchResult` stays byte-identical** — slot enrichment adds machine-readable fields only; the model-facing rendered text is unchanged (asserted in Task 1).
- **Singular `subagent` path is sacred** — the `toolName === "subagents"` reconstruct branch and Completed-grouping are purely additive; singular dispatches reconstruct + render exactly as before (regression-asserted in every task).
- **Shared singletons untouched** — this work touches branch reconstruction + viewer rendering only; the in-flight registry and run-persistence store are unchanged.
- **No model ids hardcoded** — `childModel` is resolved from `task.model ?? task.tier ?? task.capability ?? mainModel ?? "default"` (existing pattern); never a literal id.
- **Run from the package dir:** all `bun test` / `bunx tsc` commands run inside `bun-apps/pi-agent-ext-subagent/`.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/subagents-tool.ts` | batch tool: dispatch + slot mapping + render | enrich `BatchResultSlot` non-null variants with `task`/`model`/`elapsedMs` |
| `src/subagent-viewer.ts` | `/subagents` viewer: reconstruct + render | `SubagentRun.batchToolCallId?`; `reconstructSubagentRuns` expands `subagents`; Completed section groups batch children |
| `tests/subagents-tool.test.ts` | batch-tool tests | assert slot enrichment + render unchanged |
| `tests/subagent-viewer.test.ts` | viewer tests | assert reconstruct expansion + Completed grouping/select + singular no-regression |

`src/subagents-command.ts` needs **no change** — it already calls `reconstructSubagentRuns(branch)`; the widening flows through automatically.

---

### Task 1: Enrich the batch result slot with task / model / elapsedMs

**Files:**
- Modify: `src/subagents-tool.ts:40-50` (`BatchResultSlot` type), `src/subagents-tool.ts:215-294` (`dispatchChild` slot mapping)
- Test: `tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `taskPreview` (existing helper), `childModel` (already computed), `childT0` (already recorded at line ~232)
- Produces: `BatchResultSlot` non-null variants now carry `task: string; model: string; elapsedMs: number` — consumed by Task 2's reconstruct

- [ ] **Step 1: Write the failing test**

Append to `tests/subagents-tool.test.ts`:

```ts
test("each completed/budget slot carries task/model/elapsedMs; renderBatchResult is unchanged", async () => {
  const spawn = async (opts: { task: string }) => ({
    output: `out-${opts.task}`,
    exitCode: 0,
    stderr: "",
    timedOut: false,
    usage: { total: 100, cost: 0.001 },
  });
  const tool = createSubagentsTool({
    spawn: spawn as never,
    getMainModel: () => "provider/flash",
  });
  const res = await tool.execute!("call-1", {
    tasks: [{ task: "research A", id: "a" }, { task: "research B" }],
  } as never, undefined as never, undefined as never, undefined as never);

  const r = res.details.results;
  // done slots carry task (preview), model, elapsedMs
  const s0 = r[0] as { task: string; model: string; elapsedMs: number; status: string; output: string };
  assert.ok(s0.task.includes("research A"), "slot.task carries the task preview");
  assert.equal(s0.model, "provider/flash");
  assert.ok(s0.elapsedMs >= 0);

  // renderBatchResult does NOT leak task/model — only output/status/id
  const rendered = renderBatchResult(res.details);
  assert.ok(!rendered.includes("provider/flash"), "model must not appear in rendered text");
  assert.ok(!rendered.includes("research A"), "task must not appear in rendered text");
  assert.match(rendered, /out-research A/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts -t "carries task/model/elapsedMs"`
Expected: FAIL — `s0.task` is `undefined` (`BatchResultSlot` has no `task` field yet).

- [ ] **Step 3: Widen the type + enrich the slots**

In `src/subagents-tool.ts`, widen `BatchResultSlot` (lines 40-50) — add `task: string; model: string; elapsedMs: number` to BOTH non-null variants:

```ts
export type BatchResultSlot =
  | {
      output: string;
      status: "done" | "timedout";
      id?: string;
      index: number;
      usage?: AgentUsage;
      task: string;       // task preview (for Completed-section display)
      model: string;      // resolved child model (never a hardcoded id)
      elapsedMs: number;  // per-child wall-clock, from childT0
    }
  | {
      status: "budget";
      exhaustion: BudgetExhaustion;
      source: "batch" | "child";
      id?: string;
      index: number;
      task: string;
      model: string;
      elapsedMs: number;  // 0 for gate-skipped (never ran); real for child-budget aborts
    }
  | null;
```

In `dispatchChild` (lines ~215-294), compute `childModel` and `taskPreview` **before** the gate check so both branches can use them, then enrich every slot:

```ts
const dispatchChild = async (task: BatchTask, index: number): Promise<void> => {
  const childModel = task.model ?? task.tier ?? task.capability ?? mainModel ?? "default";
  const preview = taskPreview(task.task);
  if (gateTripped) {
    if (budgetExhaustion) {
      slots[index] = {
        status: "budget", exhaustion: budgetExhaustion, source: "batch",
        id: task.id, index, task: preview, model: childModel, elapsedMs: 0,
      };
    }
    return;
  }
  // ... existing childOpts / inFlight.start / childSpawnOpts unchanged ...
  // (childModel is already computed above; remove the now-duplicate later `const childModel =` line)
  const childT0 = Date.now();
  // ... existing spawn + markCompleted ...
  // ... existing usage accumulation ...
  const status = deriveSubagentStatus(result);
  if (status === "failed") {
    slots[index] = null;
  } else if (result.budget) {
    slots[index] = {
      status: "budget", exhaustion: result.budget, source: "child",
      id: task.id, index, task: preview, model: childModel, elapsedMs: Date.now() - childT0,
    };
  } else {
    slots[index] = {
      output: result.output,
      status: status === "timedout" ? "timedout" : "done",
      id: task.id, index, usage: result.usage,
      task: preview, model: childModel, elapsedMs: Date.now() - childT0,
    };
  }
  // ... existing persistence.save unchanged ...
};
```

Note: the existing `const childModel = ...` line (currently ~line 230, after the gate check) is removed — it moves to the top of `dispatchChild` (before the gate check) so the gate-skip branch can use it. `taskPreview(task.task)` is already imported/used for `inFlight.start`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts`
Expected: PASS — new test green, all existing batch-tool tests green (the slot just has extra fields; existing assertions on `.output`/`.status` still hold; `renderBatchResult` selects fields so its output is unchanged).

- [ ] **Step 5: Typecheck + commit**

Run: `cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit`
Expected: clean (the widened type is backward-compatible — readers cast slot fields as needed).
```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): enrich batch result slot with task/model/elapsedMs (deficit 4b prep)"
```

---

### Task 2: Reconstruct expands a `subagents` batch into N child runs

**Files:**
- Modify: `src/subagent-viewer.ts` (`SubagentRun` interface ~line 30; `reconstructSubagentRuns` ~line 57)
- Test: `tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: Task 1's enriched `BatchResultSlot` (`task`/`model`/`elapsedMs`) carried in the batch toolResult's `details.results`
- Produces: `SubagentRun` now has optional `batchToolCallId?: string` (group key for Task 3); `reconstructSubagentRuns` emits one entry per non-null batch child

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent-viewer.test.ts` (reuse the existing `toolResultEntry` helper + add a batch variant):

```ts
import type { SubagentsToolDetails } from "../src/subagents-tool.js";

function batchResultEntry(
  toolCallId: string,
  results: SubagentsToolDetails["results"],
  text = "batch done",
) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagents",
      toolCallId,
      content: [{ type: "text", text }],
      details: { results, dispatched: results.length, skipped: 0, elapsedMs: 5000 } as never,
    },
  };
}
const doneSlot = (i: number, task: string, output: string) => ({
  status: "done" as const, index: i, output, task, model: "x/flash", elapsedMs: 1000, usage: { total: 10, cost: 0 },
});

test("reconstructSubagentRuns expands a subagents batch into child entries (skips null)", () => {
  const branch = [
    batchResultEntry("batch-1", [
      doneSlot(0, "task A", "out A"),
      null, // failed child — skipped
      doneSlot(2, "task C", "out C"),
    ]),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs.length, 2, "null failed slot is skipped");
  assert.equal(runs[0].batchToolCallId, "batch-1");
  assert.equal(runs[0].taskPreview, "task A");
  assert.equal(runs[0].model, "x/flash");
  assert.equal(runs[0].output, "out A");
  assert.equal(runs[1].taskPreview, "task C");
});

test("reconstructSubagentRuns: singular subagent + batch children coexist; singular unchanged", () => {
  const branch = [
    toolResultEntry("subagent", "singular report", {
      exitCode: 0, timedOut: false, agent: "impl", model: "y/pro",
      taskPreview: "sing", elapsedMs: 500, status: "done",
    }),
    batchResultEntry("batch-9", [doneSlot(0, "b-task", "b-out")]),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].batchToolCallId, undefined, "singular run has no batchToolCallId");
  assert.equal(runs[0].taskPreview, "sing");
  assert.equal(runs[1].batchToolCallId, "batch-9");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "expands a subagents batch"`
Expected: FAIL — `runs[0].batchToolCallId` is `undefined`/type error (the `subagents` toolName is still filtered out; no expansion).

- [ ] **Step 3: Widen the type + add the expansion branch**

In `src/subagent-viewer.ts`, add `batchToolCallId?` to `SubagentRun` (after `toolCallId?`):

```ts
export interface SubagentRun {
  index: number;
  toolCallId?: string;
  /** Shared toolCallId of the parent `subagents` batch — present on expanded batch
   *  children (Completed-section grouping key); absent on singular `subagent` runs. */
  batchToolCallId?: string;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout" | "budget";
  elapsedMs: number;
  startedAt?: number;
  usage?: AgentUsage;
  output: string;
}
```

Add the `SubagentsToolDetails` import and rewrite `reconstructSubagentRuns` to handle both tool names:

```ts
import type { SubagentsToolDetails, BatchResultSlot } from "./subagents-tool.js";
// (BatchResultSlot is already exported from subagents-tool.ts; re-export from index.js if the
//  package's barrel doesn't already surface it — check src/index.ts first.)

/** Scan a session branch and collect subagent tool results in order. */
export function reconstructSubagentRuns(branch: Iterable<BranchEntry>): SubagentRun[] {
  const runs: SubagentRun[] = [];
  let i = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult") continue;

    if (msg.toolName === "subagents") {
      // Expand the batch's positional result array into N child runs (Option B').
      // Failed (null) slots have no data → skipped (their count is in the batch header).
      const d = msg.details as unknown as Partial<SubagentsToolDetails> | undefined;
      for (const slot of d?.results ?? []) {
        if (!slot) continue; // null === failed child
        i += 1;
        runs.push({
          index: i,
          toolCallId: undefined,            // batch children share no per-child branch id
          batchToolCallId: msg.toolCallId,  // grouping key for the Completed section
          model: slot.model ?? "default",
          taskPreview: slot.task ?? "",
          status: slot.status,
          elapsedMs: slot.elapsedMs ?? 0,
          usage: "usage" in slot ? slot.usage : undefined,
          output: "output" in slot ? slot.output : "",
        });
      }
      continue;
    }

    if (msg.toolName !== "subagent") continue; // singular path — byte-identical to before
    i += 1;
    const d = msg.details;
    const status: SubagentRun["status"] = d?.status ?? (d && d.exitCode === 0 ? "done" : "failed");
    runs.push({
      index: i,
      toolCallId: msg.toolCallId,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      startedAt: d?.startedAt,
      usage: d?.usage,
      output: msg.content?.find((c) => c.type === "text")?.text ?? "",
    });
  }
  return runs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: PASS — both new tests green; the two existing `reconstructSubagentRuns` tests (singular-only) stay green (the singular branch is byte-identical).

- [ ] **Step 5: Typecheck + commit**

Run: `cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit`
Expected: clean.
```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagents): reconstruct expands a batch toolResult into child runs (deficit 4b)"
```

---

### Task 3: Group completed batch children under a collapsible header

**Files:**
- Modify: `src/subagent-viewer.ts` (`entries()` ~line 105; `renderList()` completed-section ~line 230)
- Test: `tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: Task 2's `SubagentRun.batchToolCallId` grouping key
- Produces: the Completed section renders batch children under a `▼ subagents batch · N children` header (collapse via the existing `collapsedBatches` set, keyed by `batchToolCallId`); selecting a child opens the `output` view

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent-viewer.test.ts`:

```ts
function run(partial: Partial<SubagentRun> & { index: number }): SubagentRun {
  return {
    model: "x/flash", taskPreview: "t", status: "done", elapsedMs: 1000, output: "o", ...partial,
  };
}

test("Completed section groups batch children under one header; enter opens a child's output", () => {
  // Two batch children (same batchToolCallId) + one singular run.
  const runs = [
    run({ index: 1, batchToolCallId: "batch-1", taskPreview: "child A", output: "out A" }),
    run({ index: 2, batchToolCallId: "batch-1", taskPreview: "child B", output: "out B" }),
    run({ index: 3, taskPreview: "singular", output: "sing out" }),
  ];
  const v = new SubagentViewer({ runs, onClose: () => {} }, T);
  const lines = v.render(80);

  // Exactly one batch header for batch-1, labelled with child count.
  const headers = lines.filter((l) => l.includes("subagents batch"));
  assert.equal(headers.length, 1);
  assert.ok(headers[0].includes("2 children"), "completed batch header shows child count");

  // Both children render (indented under the header); the singular run is separate.
  assert.ok(lines.some((l) => l.includes("child A")));
  assert.ok(lines.some((l) => l.includes("child B")));
  assert.ok(lines.some((l) => l.includes("singular")));

  // Cursor starts at index 0 = the batch header; press down once → first child;
  // enter opens its output view.
  v.handleInput("\x1b[B"); // down → first child ("child A")
  v.handleInput("\r");     // enter → output view
  const out = v.render(80);
  assert.ok(out.some((l) => l.includes("out A")), "enter on a batch child opens its frozen output");
});

test("Completed section: collapsing a batch header hides its children", () => {
  const runs = [
    run({ index: 1, batchToolCallId: "batch-1", taskPreview: "child A", output: "out A" }),
    run({ index: 2, batchToolCallId: "batch-1", taskPreview: "child B", output: "out B" }),
  ];
  const v = new SubagentViewer({ runs, onClose: () => {} }, T);
  v.handleInput("\r"); // enter on the header (cursor 0) → toggle collapse
  const collapsed = v.render(80);
  assert.ok(!collapsed.some((l) => l.includes("child A")), "collapsed batch hides its children");
  assert.ok(collapsed.some((l) => l.includes("subagents batch")), "header still shows when collapsed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "Completed section groups batch children"`
Expected: FAIL — no `subagents batch` header in the Completed section (children render flat, or the batch header count is wrong); children not hidden on collapse.

- [ ] **Step 3: Group completed runs in `entries()` + render headers/children**

In `entries()` (`src/subagent-viewer.ts`), replace the flat completed mapping with batch-aware grouping. Add a `section` discriminant to the `batchHeader` kind so `renderList` can tell running-section headers from completed-section headers:

```ts
private entries(): Array<
  | { kind: "running"; ref: InFlightSubagent }
  | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }
  | { kind: "completed"; ref: SubagentRun }
> {
  const q = this.filter.trim().toLowerCase();
  const matches = (agent: string | undefined, preview: string): boolean =>
    !q || (agent ?? "").toLowerCase().includes(q) || preview.toLowerCase().includes(q);

  // --- RUNNING section (unchanged except `section: "running"` on the header) ---
  const allRunning = (this.getRunning?.() ?? []).filter((r) => matches(r.agent, r.taskPreview));
  const runningEntries: Array<{ kind: "running"; ref: InFlightSubagent } | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }> = [];
  const seenBatches = new Set<string>();
  for (const r of allRunning) {
    const bid = r.batchId;
    if (bid) {
      if (seenBatches.has(bid)) continue;
      seenBatches.add(bid);
      const children = allRunning.filter((x) => x.batchId === bid);
      const done = children.filter((x) => x.status === "completed").length;
      runningEntries.push({ kind: "batchHeader", section: "running", batchId: bid, running: children.length - done, done });
      if (!this.collapsedBatches.has(bid)) {
        for (const c of children) runningEntries.push({ kind: "running", ref: c });
      }
    } else {
      runningEntries.push({ kind: "running", ref: r });
    }
  }

  // --- COMPLETED section: group by batchToolCallId, flat otherwise ---
  const allCompleted = this.runs.filter((r) => matches(r.agent, r.taskPreview));
  const capped = !q && !this.showAll ? allCompleted.slice(-COMPLETED_CAP) : allCompleted;
  const completedEntries: Array<{ kind: "completed"; ref: SubagentRun } | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }> = [];
  const seenCompletedBatches = new Set<string>();
  for (const r of capped) {
    const bid = r.batchToolCallId;
    if (bid) {
      if (seenCompletedBatches.has(bid)) continue;
      seenCompletedBatches.add(bid);
      const children = capped.filter((x) => x.batchToolCallId === bid);
      completedEntries.push({ kind: "batchHeader", section: "completed", batchId: bid, running: 0, done: children.length });
      if (!this.collapsedBatches.has(bid)) {
        for (const c of children) completedEntries.push({ kind: "completed", ref: c });
      }
    } else {
      completedEntries.push({ kind: "completed", ref: r });
    }
  }

  return [...runningEntries, ...completedEntries];
}
```

In `renderList()`, update the two section splits to honor `section`, and render the completed batch header + indented children. Replace the running-section filter and the completed loop:

```ts
// running section now excludes completed-section headers:
const runningEntries = entries.filter(
  (e) => e.kind === "running" || (e.kind === "batchHeader" && e.section === "running"),
);
// ... existing Running rendering UNCHANGED (the batchHeader counts logic stays) ...

// Completed section: include completed-section batch headers + children.
const completed = entries.filter(
  (e) => e.kind === "completed" || (e.kind === "batchHeader" && e.section === "completed"),
) as Array<{ kind: "completed"; ref: SubagentRun } | { kind: "batchHeader"; section: "completed"; batchId: string; running: number; done: number }>;
if (completed.length === 0) {
  lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
} else {
  for (const e of completed) {
    const cur = entries.indexOf(e) === this.selected;
    if (e.kind === "batchHeader") {
      const collapsed = this.collapsedBatches.has(e.batchId);
      const glyph = collapsed ? "▶" : "▼";
      const header = `${th.fg("accent", th.bold(`${glyph} subagents batch`))} ${th.fg("dim", `· ${e.done} children`)}`;
      lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${header}`) : `  ${header}`}`, width));
      continue;
    }
    const r = e.ref;
    const indented = Boolean(r.batchToolCallId);
    const row: ActivityRow = {
      status: r.status,
      actor: r.agent ?? "general-purpose",
      badge: `#${r.index}`,
      model: shortModel(r.model),
      elapsedMs: r.elapsedMs,
      cost: r.usage?.cost,
      detail: r.taskPreview
        ? `${r.startedAt ? `${formatRelativeTime(r.startedAt)} — ` : ""}${r.taskPreview}`
        : r.startedAt ? formatRelativeTime(r.startedAt) : undefined,
    };
    const head = renderActivityRow(row, th, 50);
    // Indented batch child (mirrors the Running section's indentation); the ungrouped
    // singular row is byte-identical to before.
    if (indented) {
      const body = cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`;
      lines.push(truncateToWidth(`    ${body}`, width));
    } else {
      lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
    }
  }
}
```

The `handleInput` enter-on-batchHeader toggle already keys on `e.batchId` and uses `collapsedBatches` — it works for completed-section headers unchanged (the `batchHeader` kind still carries `batchId`). No `handleInput` change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: PASS — both new grouping tests green; all existing viewer tests green (singular Completed rows render byte-identically via the `indented ? ... : <unchanged>` branch).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit && bun test`
Expected: clean typecheck; full package suite green.
```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagents): group batch children under a collapsible header in Completed (deficit 4b)"
```

---

## Self-Review

**1. Spec coverage:** D1 (B' sourcing) → Task 1 (slot enrich) + Task 2 (branch reconstruct). D2 (slot fields, render unchanged) → Task 1 test asserts render byte-identical. D3 (reconstruct expansion, singular sacred, null skipped) → Task 2 + its regression test. D4 (Completed grouping + select→output) → Task 3. Acceptance criteria 1–6 each map to a task test. ✅ (AC4 "render byte-identical" → Task 1 step 1; AC5 "singular no-regression" → Tasks 2 & 3 regression tests; AC6 "full suite green" → Task 3 step 5.)

**2. Placeholder scan:** No TBD/TODO; each step has real code. The Task 1 step 3 "… existing … unchanged" comment markers delimit UNCHANGED regions (explicitly labeled, not placeholders) — the actual changed lines are shown in full. ✅

**3. Type consistency:** `batchToolCallId` introduced in Task 2 (`SubagentRun`) and consumed in Task 3 (`entries()` grouping). `section: "running" | "completed"` added to `batchHeader` in Task 3's `entries()` and read in `renderList()` — consistent. `task`/`model`/`elapsedMs` added to `BatchResultSlot` (Task 1) and read as `slot.task`/`slot.model`/`slot.elapsedMs` (Task 2) — consistent. ✅

## Execution Handoff

Plan complete and saved to `.planning/2026-08-02-subagents-completed-visibility-4b/plan.md`. Three tasks, each independently testable. Recommended: **subagent-driven-development** (fresh subagent per task, review between) — or **inline execution** here. Branch `feat/subagents-completed-visibility-4b` is synced to `origin/main` and ready.
