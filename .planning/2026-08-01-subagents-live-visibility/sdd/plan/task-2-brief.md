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

