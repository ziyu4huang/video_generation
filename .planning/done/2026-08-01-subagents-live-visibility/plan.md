# subagents live-visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/subagents` show `subagents` batch-tool children live and grouped under a collapsible header, instead of N static orphan rows.

**Architecture:** Add an optional `batchId` to the in-flight registry; the batch tool sets it (its own `toolCallId`) and forwards each child's `onModelResolved`/`onHistory` to the registry; the viewer groups Running entries by `batchId` during render (Task 2 — cursor/filter untouched), then adds a selectable collapsible header (Task 3). Singular-tool runs have no `batchId` and stay flat.

**Tech Stack:** TypeScript, Bun (`bun:test`), typebox, `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`.

## Global Constraints

- **Bun only** — never node/npm/yarn. Tests: `( cd bun-apps/pi-agent-ext-subagent && bun test )`. Type-check: `( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit )`.
- **No top-level `cd`** — use `( cd <dir> && … )`.
- **Explicit `git add <paths>`** — never `git add -A` (the recurring `.planning/.../sdd/` scratch sweep).
- **Shared singleton** — `SubagentInFlightRegistry` is imported by multiple extensions. `batchId` is **optional**; singular-tool and workflow paths must compile and behave unchanged.
- **Read-only enforcement is unchanged** — this effort touches *visibility* only; `edit`/`write`/`bash` exclusion on batch children stays exactly as built.
- Biome is not CI-gated; `tsc --noEmit` must exit 0.

---

### Task 1: Batch tool forwards live callbacks + sets `batchId`

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts` (`InFlightSubagent` type)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (the per-child loop in `execute()`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `SpawnSubagentOptions.onModelResolved` / `onHistory` (already exist on `spawnSubagent`), `SubagentInFlightRegistry.updateModel(id, model)` / `update(id, history)`.
- Produces: `InFlightSubagent.batchId?: string` — consumed by Task 2's viewer grouping.

- [ ] **Step 1: Write the failing test (in-flight carries `batchId`)**

Append to `tests/subagent-in-flight.test.ts`:

```ts
test("start carries batchId through for batch-tool children; undefined for singular-tool runs", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "batch-1" });
  assert.equal(reg.get("c0")?.batchId, "batch-1");
  // singular-tool children omit it → undefined (backward compatible)
  reg.start({ id: "solo", model: "y", taskPreview: "u", startedAt: 0 });
  assert.equal(reg.get("solo")?.batchId, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: FAIL — TypeScript error: `batchId` does not exist on the `InFlightSubagent` literal passed to `start()`.

- [ ] **Step 3: Add `batchId` to the type**

In `src/subagent-in-flight.ts`, add the optional field to `InFlightSubagent` (after `resolvedModel`):

```ts
export interface InFlightSubagent {
  id: string;
  agent?: string;
  model: string;
  resolvedModel?: string;
  /** The batch tool's own toolCallId, set on every child of a `subagents` batch so
   *  the /subagents viewer can group them under one header. Undefined for singular
   *  `subagent` dispatches (flat, ungrouped) and workflow agents. */
  batchId?: string;
  taskPreview: string;
  startedAt: number;
  history?: AgentHistoryEntry[];
  invalidate?: () => void;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: PASS.

- [ ] **Step 5: Write the failing test (batch tool sets `batchId` + forwards callbacks)**

Append to `tests/subagents-tool.test.ts`. The fake spawn reads the callback opts and captures the registry mid-run:

```ts
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
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts -t "batch children get batchId" )`
Expected: FAIL — `batchId` undefined, `resolved` undefined, `historyLen` 0 (callbacks not forwarded).

- [ ] **Step 7: Forward callbacks + set `batchId` at the spawn call site**

In `src/subagents-tool.ts`, inside `execute()`'s `runWithConcurrency` callback, locate the block that builds `childOpts` and calls `spawn`. Two edits:

(a) Add `batchId` to the `inFlight.start` call:

```ts
options.inFlight?.start({
  id: childRunId,
  model: childModel,
  taskPreview: taskPreview(task.task),
  startedAt: childT0,
  batchId: toolCallId,
});
```

(b) Build the spawn opts with the callbacks spread in (they need `inFlight` + `childRunId`, which `mergeReadOnlyExclusion` does not have):

```ts
const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools });
// Forward live callbacks so /subagents shows each child's resolved model and
// activity trace (deficit 1). Added here — not in mergeReadOnlyExclusion — because
// the callbacks close over the registry + childRunId, which that pure helper lacks.
const childSpawnOpts: SpawnSubagentOptions = {
  ...childOpts,
  onModelResolved: (id) => options.inFlight?.updateModel(childRunId, id),
  onHistory: (history) => options.inFlight?.update(childRunId, history),
};
let result: SpawnSubagentResult;
try {
  result = await spawn(childSpawnOpts);
} finally {
  options.inFlight?.end(childRunId);
}
```

`AgentHistoryEntry` is the `onHistory` parameter type — it is already imported in `subagents-tool.ts`? Check: if not, the inferred type from `SpawnSubagentOptions.onHistory` makes the annotation unnecessary; drop the explicit param type and let it infer: `onHistory: (history) => options.inFlight?.update(childRunId, history)`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (new test + all existing batch-tool tests).

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts \
        bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): forward per-child live callbacks + set batchId on in-flight entries"
```

---

### Task 2: Viewer renders grouped batch headers (expanded-by-default)

Cursor / filter / cap / follow stay byte-identical — `entries()` is **unchanged** (still a flat selectable list). Grouping happens **during render**: a `▼ subagents batch · k running` header is drawn before each `batchId` group; the group's children are indented. Ungrouped runs (no `batchId`) render flat, exactly as today.

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (`renderList` Running-section loop)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: `InFlightSubagent.batchId` (from Task 1), and the now-live `resolvedModel` / `history` (deficit 1, fixed in Task 1) so child rows show real activity.
- Produces: the grouped Running-section render.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagent-viewer.test.ts`. Reuse the file's existing `T` theme and `runningEntry` helper; extend `runningEntry` is unnecessary — pass `batchId` via the overrides spread it already supports:

```ts
test("viewer groups batch children under one header in the Running section", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX" }),
    runningEntry("batchX:1", { batchId: "batchX" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  // exactly one batch header for the group
  const headers = out.split("\n").filter((l) => /subagents batch/.test(l));
  assert.equal(headers.length, 1, "one header for the whole batch");
  assert.match(out, /2 running/, "header shows the running count");
  assert.ok(out.includes("doing batchX:0") && out.includes("doing batchX:1"), "both children present");
});

test("ungrouped running entries (no batchId) render flat — no batch header", () => {
  const running = [runningEntry("solo1"), runningEntry("solo2")];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("subagents batch"), "no header for ungrouped runs");
  assert.ok(out.includes("doing solo1") && out.includes("doing solo2"));
});

test("mixed: ungrouped runs flat, batch children grouped under one header", () => {
  const running = [
    runningEntry("solo"),
    runningEntry("batchX:0", { batchId: "batchX" }),
    runningEntry("batchX:1", { batchId: "batchX" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing solo"), "ungrouped run stays flat");
  assert.match(out, /subagents batch.*2 running/, "batch grouped under one header");
});

test("a batch child is still selectable + followable (cursor unaffected by the header)", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX" }),
    runningEntry("batchX:1", { batchId: "batchX" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  // entries() is flat: [batchX:0, batchX:1]. Cursor starts at 0 (first child).
  viewer.handleInput("\x1b[B"); // down → second child (batchX:1)
  viewer.handleInput("\r"); // enter → follow
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("→ read"), "follow streams the selected child's live trace");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "batch children under one header" )`
Expected: FAIL — no `subagents batch` header rendered (children currently flat).

- [ ] **Step 3: Group during render in `renderList`**

In `src/subagent-viewer.ts`, replace the Running-section rendering loop inside `renderList`. The current code filters `entries()` to `running` and renders each flat. Insert a transition-based header + indent children with a `batchId`. Precompute group counts first (children churn as they start/finish, so count = in-flight members of the batch at render time):

```ts
const running = entries.filter((e) => e.kind === "running") as Array<{ kind: "running"; ref: InFlightSubagent }>;
if (running.length > 0) {
  const runningTitle = th.fg("accent", th.bold(" Running "));
  lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
  // Count in-flight children per batchId (for the header's "k running").
  const batchCounts = new Map<string, number>();
  for (const e of running) {
    const bid = e.ref.batchId;
    if (bid) batchCounts.set(bid, (batchCounts.get(bid) ?? 0) + 1);
  }
  let lastBatch: string | undefined;
  for (const e of running) {
    const r = e.ref;
    const cur = entries.indexOf(e) === this.selected;
    const bid = r.batchId;
    if (bid) {
      // New batch group → render a (visual, non-selectable) header before its first child.
      if (bid !== lastBatch) {
        const k = batchCounts.get(bid) ?? 0;
        const header = `${th.fg("accent", th.bold("▼ subagents batch"))} ${th.fg("dim", `· ${k} running`)}`;
        lines.push(truncateToWidth(`  ${header}`, width));
        lastBatch = bid;
      }
      // Indented child row.
      const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
      const row: ActivityRow = {
        status: "running",
        actor: r.agent ?? "general-purpose",
        model: r.resolvedModel ?? r.model,
        elapsedMs: Date.now() - r.startedAt,
        toolCalls,
        latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
      };
      const head = renderActivityRow(row, th);
      lines.push(truncateToWidth(`    ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
    } else {
      // Ungrouped (singular-tool) run — flat, exactly as before. Reset batch tracking.
      lastBatch = undefined;
      const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
      const row: ActivityRow = {
        status: "running",
        actor: r.agent ?? "general-purpose",
        model: r.resolvedModel ?? r.model,
        elapsedMs: Date.now() - r.startedAt,
        toolCalls,
        latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
      };
      const head = renderActivityRow(row, th);
      lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
    }
  }
  lines.push("");
}
```

Note the two render branches intentionally keep the ungrouped branch byte-identical to the original (same `ActivityRow`, same ` ${cur ? … : …}` prefix) so existing Running-section tests stay green.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — new grouping tests + every existing viewer test (cursor/filter/cap/follow/Running-section) unchanged.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagents): group batch children under a header in /subagents Running section"
```

---

### Task 3: Collapsible batch header (enter toggles collapse)

Make the header a **selectable** entry. When collapsed, the batch's children are excluded from `entries()` (hidden + non-selectable); the header shows `▶ … k running`. Enter on the header toggles. This is the only place `entries()` shape changes.

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (`entries()` shape, `renderList`, `handleInput`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: Task 2's render grouping.
- Produces: collapse/expand affordance.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagent-viewer.test.ts`:

```ts
test("batch header is selectable; enter collapses its children, enter again expands", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX" }),
    runningEntry("batchX:1", { batchId: "batchX" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  let out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing batchX:0"), "expanded by default — children visible");
  assert.match(out, /▼/, "expanded glyph");
  // cursor starts on the header (first entry); enter collapses
  viewer.handleInput("\r");
  out = viewer.render(80).join("\n");
  assert.ok(!out.includes("doing batchX:0") && !out.includes("doing batchX:1"), "collapsed — children hidden");
  assert.match(out, /▶/, "collapsed glyph");
  assert.match(out, /2 running/, "count still shown when collapsed");
  viewer.handleInput("\r"); // expand again
  out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing batchX:0"), "expanded again");
});

test("collapsed batch children are skipped by the cursor (down jumps header→next)", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX" }),
    runningEntry("batchX:1", { batchId: "batchX" }),
    runningEntry("solo"), // ungrouped, after the batch
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  // entries: [header(batchX), solo] once collapsed (children excluded)
  viewer.handleInput("\r"); // collapse the header (cursor on header)
  viewer.handleInput("\x1b[B"); // down → solo
  viewer.handleInput("\r"); // enter on solo (running) → follow
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("→ read"), "landed on solo's follow, not a hidden child");
});

test("collapsing one batch does not collapse another", () => {
  const running = [
    runningEntry("bA:0", { batchId: "bA" }),
    runningEntry("bB:0", { batchId: "bB" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("\r"); // collapse bA (header is entry 0)
  let out = viewer.render(80).join("\n");
  assert.ok(!out.includes("doing bA:0"), "bA collapsed");
  assert.ok(out.includes("doing bB:0"), "bB still expanded");
});
```

Also **update** the Task-2 test `"a batch child is still selectable + followable"` — with a selectable header, the cursor now starts on the header (entry 0), so reaching the first child needs one `down` first:

```ts
// updated: header is entry 0; down → first child (batchX:0); enter → follow
viewer.handleInput("\x1b[B"); // down → first child
viewer.handleInput("\r"); // enter → follow
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "collapses its children" )`
Expected: FAIL — header is not selectable; enter does nothing (children stay visible).

- [ ] **Step 3: Make the header selectable + track collapse state**

In `src/subagent-viewer.ts`:

(a) Add a collapse-state field to `SubagentViewer` (per-`batchId`):

```ts
private collapsedBatches = new Set<string>();
```

(b) Introduce a header entry kind in `entries()`. Group running children by `batchId` (preserving registry order); for each batch present, emit a `batchHeader` entry, and — only when **not** collapsed — its child entries after it. Ungrouped runs and completed runs stay as today:

```ts
private entries(): Array<
  | { kind: "running"; ref: InFlightSubagent }
  | { kind: "batchHeader"; batchId: string; count: number }
  | { kind: "completed"; ref: SubagentRun }
> {
  const q = this.filter.trim().toLowerCase();
  const matches = (agent: string | undefined, preview: string): boolean =>
    !q || (agent ?? "").toLowerCase().includes(q) || preview.toLowerCase().includes(q);
  const allRunning = (this.getRunning?.() ?? []).filter((r) => matches(r.agent, r.taskPreview));

  // Preserve registry order; emit one header per batch at its first child, then
  // the children (unless collapsed). Ungrouped runs emit flat.
  const runningEntries: Array<{ kind: "running"; ref: InFlightSubagent } | { kind: "batchHeader"; batchId: string; count: number }> = [];
  const seenBatches = new Set<string>();
  for (const r of allRunning) {
    const bid = r.batchId;
    if (bid) {
      if (!seenBatches.has(bid)) {
        const count = allRunning.filter((x) => x.batchId === bid).length;
        runningEntries.push({ kind: "batchHeader", batchId: bid, count });
        seenBatches.add(bid);
      }
      if (!this.collapsedBatches.has(bid)) {
        runningEntries.push({ kind: "running", ref: r });
      }
    } else {
      runningEntries.push({ kind: "running", ref: r });
    }
  }

  const allCompleted = this.runs.filter((r) => matches(r.agent, r.taskPreview));
  const capped = !q && !this.showAll ? allCompleted.slice(-COMPLETED_CAP) : allCompleted;
  return [...runningEntries, ...capped.map((ref) => ({ kind: "completed" as const, ref }))];
}
```

(c) In `handleInput`, handle `enter` on a `batchHeader` (toggle collapse) — add this branch before the existing running/completed `enter` handling:

```ts
} else if (matchesKey(data, Key.enter) && entries.length > 0) {
  const e = entries[this.selected];
  if (!e) return;
  if (e.kind === "batchHeader") {
    if (this.collapsedBatches.has(e.batchId)) this.collapsedBatches.delete(e.batchId);
    else this.collapsedBatches.add(e.batchId);
    // Keep the cursor on the header after toggling (its index is stable: it precedes its children).
    this.selected = Math.min(this.selected, entries.length - 1);
    this.invalidate();
    return;
  }
  if (e.kind === "running") {
    this.enterFollow(e.ref.id);
  } else {
    this.outputRun = e.ref;
    this.view = "output";
    this.invalidate();
  }
}
```

(d) In `renderList`, render the `batchHeader` entry (it now appears in `entries()`, so the Task-2 transition-based header logic is replaced by an explicit branch per entry kind). Collapsed → `▶`; expanded → `▼`. Remove the Task-2 `lastBatch`/`batchCounts` precompute (the header is now an entry); keep the indented-child rendering for `{kind:"running"}` entries that carry a `batchId`, and the flat rendering for those without.

```ts
for (const e of entries) {
  if (e.kind === "batchHeader") {
    const collapsed = this.collapsedBatches.has(e.batchId);
    const glyph = collapsed ? "▶" : "▼";
    const cur = entries.indexOf(e) === this.selected;
    const header = `${th.fg("accent", th.bold(`${glyph} subagents batch`))} ${th.fg("dim", `· ${e.count} running`)}`;
    lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${header}`) : `  ${header}`}`, width));
    continue;
  }
  if (e.kind !== "running") continue; // completed handled in the completed block below
  const r = e.ref;
  const cur = entries.indexOf(e) === this.selected;
  const indented = Boolean(r.batchId);
  const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
  const row: ActivityRow = {
    status: "running",
    actor: r.agent ?? "general-purpose",
    model: r.resolvedModel ?? r.model,
    elapsedMs: Date.now() - r.startedAt,
    toolCalls,
    latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
  };
  const head = renderActivityRow(row, th);
  const prefix = indented ? "    " : " ";
  const mark = cur ? th.bg("selectedBg", `▶ ${head}`) : `${indented ? "  " : " "} ${head}`;
  lines.push(truncateToWidth(`${prefix}${mark}`.replace(/\s+\s/, " "), width));
}
```

(The exact whitespace/prefix can be tidied; the tests assert on substrings like `"doing batchX:0"`, the `▼`/`▶` glyph, and the count — not exact leading spaces. Keep the ungrouped branch visually matching the pre-Task-2 render so its tests stay green.)

- [ ] **Step 4: Run the full viewer test suite**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — new collapse tests + the updated Task-2 follow test + all pre-existing viewer tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagents): collapsible batch header in /subagents (enter toggles)"
```

---

## Self-review

**Spec coverage:** deficit (1) callbacks → Task 1 · deficit (2) grouping → Task 2 · collapsible header (D2) → Task 3 · correlation `batchId` (D3) → Task 1. Deficits (3) and (4) explicitly out of scope. ✓

**Placeholder scan:** every step has real test code or a real edit against a named file/section. The Task-3 render whitespace is flagged as tidyable (tests assert substrings, not exact spaces). No "TODO/TBD/handle edge cases". ✓

**Type consistency:** `InFlightSubagent.batchId?: string` (Task 1) is read in Task 2 (`r.batchId`) and Task 3 (`e.batchId`, `r.batchId`). The `entries()` return type is extended in Task 3 only; Task 2 leaves it unchanged. `runningEntry(id, overrides)` already spreads overrides, so `batchId` passes through without helper changes. ✓

**Regression risk:** Task 2 keeps `entries()` flat (render-only change); the ungrouped render branch is byte-identical to the original. Task 3 is the only `entries()` shape change — its tests cover collapse + cursor-skip + per-batch independence, and it updates the one Task-2 test whose cursor offset shifts. The singular-tool path never sets `batchId` → stays flat throughout. ✓
