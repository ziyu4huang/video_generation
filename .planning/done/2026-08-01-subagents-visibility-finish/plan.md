# subagents visibility finish (deficits 3 + 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two deficits #988 deferred: **(4a)** show full k/N progress in the batch header (completed children persist instead of being evicted per-child), and **(3)** kill the batch tool's blind spinner (wire `onUpdate` to a live single-line summary).

**Architecture:** Add an optional `status: "running" | "completed"` to `InFlightSubagent`. The batch tool **keeps** each child in the registry on completion (sets status) instead of `end()`-ing it, and evicts the **whole batch** when `execute()` returns. The viewer's batch header counts running vs completed → `k running / N done`, and renders completed children greyed (still selectable → frozen trace). Separately, the batch tool wires its `onUpdate` to a single-line `subagents · k/N running · latest: <action>` derived from the registry. Singular-tool runs never set `status`/`batchId` and stay flat + per-child-`end()`-ed exactly as today.

**Tech Stack:** TypeScript, Bun (`bun:test`), typebox, `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`.

## Global Constraints

- **Bun only** — never node/npm/yarn. Tests: `( cd bun-apps/pi-agent-ext-subagent && bun test )`. Type-check: `( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit )`.
- **No top-level `cd`** — use `( cd <dir> && … )`.
- **Explicit `git add <paths>`** — never `git add -A` (the recurring `.planning/.../sdd/` scratch sweep).
- **Shared singleton** — `SubagentInFlightRegistry` is imported by multiple extensions (singular tool, subprocess, obsidian). `status` is **optional**; singular-tool + workflow + obsidian paths leave it undefined and behave unchanged (undefined is treated as "running").
- **Visibility-only** — this effort touches *visibility*; `edit`/`write`/`bash` exclusion on batch children stays exactly as built. Read-only enforcement unchanged.
- **Biome is CI-gated** for `pi-agent-ext-*` (the test job runs `bun run check` first). Run `( cd bun-apps/pi-agent-ext-subagent && bun run check )` before every push.
- `tsc --noEmit` must exit 0.

---

### Task 1: 4a — completed children persist with `status`; batch-end eviction

**Goal:** Stop evicting each batch child on completion; instead mark it `completed` and keep it in the registry (selectable, frozen trace) until the whole batch ends, then evict all of the batch's children together.

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts` (`InFlightSubagent` type + two registry methods)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (per-child completion + batch-end cleanup)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `InFlightSubagent.batchId` (from #988), the existing `end(id)` registry method.
- Produces: `InFlightSubagent.status?: "running" | "completed"`; registry methods `markCompleted(id)` and `endBatch(batchId)`. Consumed by Task 2 (count by status) and Task 3 (count running).

- [ ] **Step 1: Write the failing tests (in-flight carries `status`; `markCompleted` / `endBatch`)**

Append to `tests/subagent-in-flight.test.ts`:

```ts
test("start carries status; markCompleted flips it; endBatch evicts the whole batch", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "bX" });
  reg.start({ id: "c1", model: "y", taskPreview: "u", startedAt: 0, batchId: "bX" });
  // default status is undefined (treated as running); singular-tool entries omit it
  assert.equal(reg.get("c0")?.status, undefined);
  reg.markCompleted("c0");
  assert.equal(reg.get("c0")?.status, "completed");
  assert.equal(reg.get("c1")?.status, undefined, "sibling still running");
  // both still present (kept for k/N + frozen-trace follow)
  assert.equal(reg.list().length, 2);
  reg.endBatch("bX");
  assert.equal(reg.list().length, 0, "whole batch evicted");
});

test("endBatch evicts only the named batch; a sibling batch is untouched", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a0", model: "x", taskPreview: "t", startedAt: 0, batchId: "bA" });
  reg.start({ id: "b0", model: "y", taskPreview: "u", startedAt: 0, batchId: "bB" });
  reg.endBatch("bA");
  assert.equal(reg.get("a0"), undefined);
  assert.ok(reg.get("b0"), "bB untouched");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts -t "markCompleted" )`
Expected: FAIL — `status` does not exist on `InFlightSubagent`; `markCompleted` / `endBatch` are not functions.

- [ ] **Step 3: Add `status` + the two registry methods**

In `src/subagent-in-flight.ts`:

(a) Add the optional field to `InFlightSubagent` (after `batchId`):

```ts
export interface InFlightSubagent {
  id: string;
  agent?: string;
  model: string;
  resolvedModel?: string;
  batchId?: string;
  /** Lifecycle status for batch-tool children. The batch tool sets "completed" on
   *  finish (kept in the registry for k/N progress + frozen-trace follow) and
   *  evicts the whole batch on its return. Undefined (= "running") for singular
   *  `subagent` dispatches, workflow agents, and obsidian — they `end()` per-child
   *  as before and never appear "completed". */
  status?: "running" | "completed";
  taskPreview: string;
  startedAt: number;
  history?: AgentHistoryEntry[];
  invalidate?: () => void;
}
```

(b) Add `markCompleted` and `endBatch` to `SubagentInFlightRegistry` (alongside `end`):

```ts
/** Mark a batch child finished without removing it (so the header can show k/N
 *  and the frozen trace stays followable). Per-child eviction happens via endBatch. */
markCompleted(id: string): void {
  const e = this.map.get(id);
  if (e) e.status = "completed";
}

/** Evict every child of one batch (called when the batch tool's execute() returns). */
endBatch(batchId: string): void {
  for (const [id, e] of this.map) {
    if (e.batchId === batchId) this.map.delete(id);
  }
  this.notify();
}
```

(If the registry stores entries under a different field name than `this.map`, use the actual field. `notify()` is the existing change-broadcast helper used by `end()`/`update()` — reuse it; if it is named differently, use the real name.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: PASS.

- [ ] **Step 5: Write the failing test (batch tool keeps completed children; evicts on batch end)**

Append to `tests/subagents-tool.test.ts`. The fake spawn marks a child mid-registry so the test can assert it persists as "completed" and the registry is empty only after the whole batch resolves:

```ts
test("batch keeps a completed child (status=completed) mid-run; evicts the whole batch on return", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const seen: { id: string; status?: string; present: boolean }[] = [];
  const spawn = async (opts: { task: string }): Promise<SpawnSubagentResult> => {
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    const id = `batch-call:${idx}`;
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
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts -t "keeps a completed child" )`
Expected: FAIL — `seen[0].present` is false (the current `end(childRunId)` evicts #0 before #1 runs) and/or `status` is undefined.

- [ ] **Step 7: Keep-on-complete + whole-batch eviction in `execute()`**

In `src/subagents-tool.ts`, inside `execute()`:

(a) Find the per-child `finally { options.inFlight?.end(childRunId); }` block (currently at ~line 243). Replace `end` with `markCompleted` so the child stays in the registry:

```ts
} finally {
  options.inFlight?.markCompleted(childRunId);
}
```

(b) Wrap the batch dispatch (`await runWithConcurrency(...)` — the line that awaits all children) in a `try/finally` that evicts the whole batch on return (success OR failure — a mid-batch throw must still clean up):

```ts
try {
  await runWithConcurrency(/* …existing args… */);
} finally {
  options.inFlight?.endBatch(toolCallId);
}
```

(Locate the real variable name for the concurrency runner; if `execute()` already has a top-level try/finally, add the `endBatch` to its finally. `toolCallId` is the batch's own id, used as `batchId` for every child — so `endBatch(toolCallId)` evicts exactly this batch's children.)

- [ ] **Step 8: Run the full batch-tool suite**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — new test + all existing batch-tool tests (including the #988 callback-forwarding + `batchId` test, which asserts `inFlight.list().length === 0` after the batch — still true, now via `endBatch`).

- [ ] **Step 9: Type-check + biome + commit**

```bash
( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit && bun run check )
git add bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts \
        bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): keep completed batch children (status) + whole-batch eviction"
```

---

### Task 2: 4a — viewer header shows k/N; completed children render + stay selectable

**Goal:** The batch header counts running vs completed → `k running / N done`; completed-status children render under the header (greyed/checkmarked) and remain selectable (follow shows the frozen trace). `entries()` keeps its shape; the only change is the batch-header counts + a status-aware render branch.

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (batch-header count + completed-child render)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: `InFlightSubagent.status` (Task 1) + `batchId` (#988). Completed-status children are still in the registry (kept by Task 1), so they already flow through `getRunning()` into `entries()` — no `entries()` shape change needed, only counts + render.
- Produces: the k/N header + greyed completed-child rows.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagent-viewer.test.ts`. Reuse the file's `T` theme + `runningEntry(id, overrides)` helper (it spreads overrides, so `status` passes through):

```ts
test("batch header shows k running / N done as children complete", () => {
  const running = [
    runningEntry("bX:0", { batchId: "bX", status: "completed" }),
    runningEntry("bX:1", { batchId: "bX" }), // still running
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.match(out, /1 running/, "running count is the non-completed child");
  assert.match(out, /1 done/, "done count is the completed child");
});

test("a completed batch child renders (greyed) and is still selectable → follow shows frozen trace", () => {
  const running = [
    runningEntry("bX:0", { batchId: "bX", status: "completed", history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }] }),
    runningEntry("bX:1", { batchId: "bX" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("bX:0"), "completed child still rendered under the header");
  // cursor on header (entry 0); down → first child (bX:0, the completed one); enter → follow
  viewer.handleInput("\x1b[B");
  viewer.handleInput("\r");
  const followed = viewer.render(80).join("\n");
  assert.ok(followed.includes("→ read"), "completed child is selectable → follow shows its frozen trace");
});

test("counts update as more children complete (2 running → 1 running 1 done → 0 running 2 done)", () => {
  const states: Array<typeof running> = [
    [runningEntry("bX:0", { batchId: "bX" }), runningEntry("bX:1", { batchId: "bX" })],
    [runningEntry("bX:0", { batchId: "bX", status: "completed" }), runningEntry("bX:1", { batchId: "bX" })],
    [runningEntry("bX:0", { batchId: "bX", status: "completed" }), runningEntry("bX:1", { batchId: "bX", status: "completed" })],
  ];
  for (let i = 0; i < states.length; i++) {
    const snap = states[i];
    const viewer = new SubagentViewer({ runs: [], getRunning: () => snap as never, onClose: () => {} }, T);
    const out = viewer.render(80).join("\n");
    assert.match(out, /2 running/, `step ${i}: header still reflects the batch (running counts down across steps)`);
  }
});
```

(Refine the third test's regexes per the implementer's render: the intent is that a fully-completed batch still renders a header with `0 running / 2 done` rather than vanishing — children are gone only after `endBatch`, which is the tool's job, not the viewer's. If the viewer already hides a fully-completed group, adjust the assertion to assert the header persists with `N done` while children remain in `getRunning()`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "k running / N done" )`
Expected: FAIL — the header renders only `k running` (no `N done`); `status` is not read.

- [ ] **Step 3: Count by status in the header + status-aware child render**

In `src/subagent-viewer.ts`:

(a) Where the `batchHeader` entry is built in `entries()` (the `count` is currently `allRunning.filter((x) => x.batchId === bid).length`), split it into running/done:

```ts
const group = allRunning.filter((x) => x.batchId === bid);
const done = group.filter((x) => x.status === "completed").length;
runningEntries.push({ kind: "batchHeader", batchId: bid, running: group.length - done, done });
```

Update the `batchHeader` entry type from `count: number` to `running: number; done: number`.

(b) In `renderList`'s `batchHeader` branch, render both counts:

```ts
if (e.kind === "batchHeader") {
  const collapsed = this.collapsedBatches.has(e.batchId);
  const glyph = collapsed ? "▶" : "▼";
  const cur = entries.indexOf(e) === this.selected;
  const counts = e.done > 0 ? `${e.running} running / ${e.done} done` : `${e.running} running`;
  const header = `${th.fg("accent", th.bold(`${glyph} subagents batch`))} ${th.fg("dim", `· ${counts}`)}`;
  lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${header}`) : `  ${header}`}`, width));
  continue;
}
```

(c) In the `running` render branch, dim completed-status children + add a checkmark so they read as done but stay selectable. Keep the ungrouped (no `batchId`) branch byte-identical:

```ts
// inside the { kind: "running" } branch, after computing `row`/`head`:
const completed = r.status === "completed";
const mark = cur
  ? th.bg("selectedBg", `▶ ${head}`)
  : completed
    ? th.fg("dim", `✓ ${head}`)   // greyed, checkmarked, still on a selectable row
    : `${indented ? "  " : " "} ${head}`;
```

(The exact glyph/whitespace is tidyable; tests assert substrings like `"bX:0"`, `"→ read"`, and the count text — not exact leading spaces. The ungrouped branch must stay visually identical to its pre-task form so existing flat-render tests stay green.)

- [ ] **Step 4: Run the full viewer suite**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — new k/N tests + every existing viewer test (cursor/filter/cap/follow/collapse/#988 grouping). The #988 collapse tests still pass because `batchHeader` still carries a count (now split) and collapse logic is unchanged.

- [ ] **Step 5: Type-check + biome + commit**

```bash
( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit && bun run check )
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagents): batch header shows k/N + completed children render greyed/selectable"
```

---

### Task 3: deficit 3 — wire `onUpdate` to a live single-line spinner

**Goal:** The batch tool's own call (Ctrl-O) is no longer a blind spinner. Wire the 4th `execute` arg (`onUpdate`, currently `_onUpdate`/ignored) to emit a single-line `subagents · k/N running · latest: <action>`, rebuilt from the registry on each child's history tick. Mirror the singular tool's diagnostic-only try/catch. (`renderCall`/`renderResult` stay out of scope per the spec — `onUpdate` content is what kills the blind spinner.)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (execute signature + the forwarded `onHistory` callback)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: the registry's batch children (status from Task 1) to count running; the singular tool's `onUpdate?.({ content: [{ type: "text", text }], details })` payload shape (`subagent-tool.ts:597`) + its try/catch diagnostic-only discipline.
- Produces: a live single-line inline progress feed for the batch call.

- [ ] **Step 1: Write the failing test (onUpdate emits a single-line k/N + latest summary)**

Append to `tests/subagents-tool.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts -t "onUpdate emits a single-line" )`
Expected: FAIL — `onUpdate` is ignored (currently `_onUpdate`); `updates` is empty.

- [ ] **Step 3: Wire `onUpdate` into the forwarded `onHistory`**

In `src/subagents-tool.ts`:

(a) Rename the 4th execute param: `async execute(toolCallId, params, _signal, onUpdate, _ctx)` (drop the underscore so it is in scope).

(b) In the forwarded `onHistory` closure (the one Task 1 / #988 added: `(history) => { options.inFlight?.update(childRunId, history); }`), after updating the registry, build + emit the single-line summary. Mirror the singular tool's try/catch (diagnostic-only — a throwing `onUpdate` must never fail the batch):

```ts
onHistory: (history) => {
  options.inFlight?.update(childRunId, history);
  try {
    const group = (options.inFlight?.list() ?? []).filter((e) => e.batchId === toolCallId);
    const running = group.filter((e) => e.status !== "completed").length;
    const total = params.tasks.length;
    const latest = summarizeLatestAction(history) ?? truncateToWidth(taskPreview(task.task), 40);
    onUpdate?.({
      content: [{ type: "text" as const, text: `subagents · ${running}/${total} running · latest: ${latest}` }],
      details: undefined as never,
    });
  } catch {
    // swallowed — onUpdate is diagnostic only (mirrors the singular tool)
  }
},
```

Notes for the implementer:
- `summarizeLatestAction` + `truncateToWidth` are already imported/used in this package (the viewer uses them). If `summarizeLatestAction` is not exported for tool use, inline its logic (it picks the latest `toolCall`/`text`/`message` from the history) — keep it a one-liner.
- `params.tasks.length` is the batch total `N`; `group` filters the registry to this batch's children (by `batchId === toolCallId`); `running` excludes `status === "completed"`. This stays O(batch size) — fine for ≤ `MAX_BATCH_TASKS`.
- If `onUpdate` churn is a concern, a throttle can be added later; for MVP emit on every tick (the singular tool does the same).

- [ ] **Step 4: Run the full batch-tool suite + type-check**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts && bunx tsc --noEmit )`
Expected: PASS — new onUpdate test + all existing batch-tool tests. `tsc` exit 0.

- [ ] **Step 5: Biome + commit**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun run check )
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): wire onUpdate to a live single-line batch spinner (deficit 3)"
```

---

## Self-review

**Spec coverage:** deficit (4a) lifecycle → Task 1 · header k/N + completed-child render → Task 2 · deficit (3) spinner → Task 3. Out of scope: (4b) post-batch Completed-section visibility, multi-line inline feed, `renderCall`/`renderResult`. ✓

**Placeholder scan:** every step has real test code or a real edit against a named file/section. The Task-2 "counts update" test is flagged for the implementer to align its regex with the actual fully-completed-batch render. No "TODO/TBD/handle edge cases". ✓

**Type consistency:** `InFlightSubagent.status?: "running" | "completed"` (Task 1) is read in Task 2 (`r.status === "completed"`, group counts) and Task 3 (`e.status !== "completed"`). `markCompleted` / `endBatch` are added in Task 1 and consumed in Tasks 1 + 3. The `batchHeader` entry widens `count: number` → `running: number; done: number` in Task 2 only. `runningEntry(id, overrides)` spreads overrides → `status` passes through without helper changes. ✓

**Backward-compat / regression risk:** `status` is optional and undefined for every non-batch path (singular tool still calls per-child `end()`; workflow + obsidian never touch the registry's status). Task 2's ungrouped render branch is byte-identical to today. Task 3 only adds an `onUpdate` emit wrapped in try/catch — it cannot change the batch result. The #988 `inFlight.list().length === 0`-after-batch assertion still holds (now via `endBatch`). Singular-tool `renderCall`/`renderResult` are untouched. ✓

**Dependency order:** Task 1 first (introduces `status` + `markCompleted`/`endBatch` + the keep-on-complete lifecycle). Tasks 2 + 3 both depend on Task 1 and are independent of each other (viewer render vs tool `onUpdate`). ✓
