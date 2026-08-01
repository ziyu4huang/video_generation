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
