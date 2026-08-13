### Task 5: `buildLiveTable` — pure live-row builder

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (add exported `buildLiveTable` + `childDispatchIndex` helpers near `formatSlotMeta`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `InFlightSubagent` (the registry entry type), `formatModelSeg` (Task 2), `summarizeLatestAction` + `truncateToWidth` (both already imported in `subagents-tool.ts`).
- Produces:
  - `childDispatchIndex(id: string): number` — extracts the trailing `:N` dispatch index from a batch child runId (`${batchId}:${index}`); `NaN` → sorts last.
  - `buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string` — one row per entry, sorted ascending by dispatch index, each `[i] slot ⏱/✓ liveElapsed · currentAction`. Empty input → `""` (header-only, per spec error-handling). PLAIN text (no theme — execute has no Theme; rendered dim by `renderSubagentsResult`'s isPartial branch).

**Render-target cell (running-live per-child row):** `[i] slot ⏱/✓ liveElapsed · currentAction` — `(id)` caller tag omitted (Plan-time decision #3; `InFlightSubagent` has no caller-tag field).

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
import { buildLiveTable, childDispatchIndex } from "../src/subagents-tool.js";
import type { InFlightSubagent } from "@repo/pi-agent-ext-core-runtime";

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

test("buildLiveTable: completed child shows ✓ glyph + the same meta", () => {
  const rows = buildLiveTable(
    [live({ id: "batch-call:1", model: "zai/glm-5.2", startedAt: 9000, status: "completed" })],
    NOW,
  );
  assert.equal(rows, "[1] glm-5.2 ✓ 1.0s · pt");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `buildLiveTable` / `childDispatchIndex` not exported.

- [ ] **Step 3: Write minimal implementation**

In `subagents-tool.ts`, add these two helpers (place them right after `formatSlotMeta`):

```ts
import type { InFlightSubagent } from "@repo/pi-agent-ext-core-runtime";
```

(Add `InFlightSubagent` to the existing `@repo/pi-agent-ext-core-runtime` import line at the top of the file — it is exported from the same module as `SubagentInFlightRegistry`.)

```ts
/** Extract the trailing `:N` dispatch index from a batch child runId
 *  (`${batchId}:${index}`). NaN for ids without a numeric suffix (sorts last). */
export function childDispatchIndex(id: string): number {
  const idx = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isFinite(idx) ? idx : NaN;
}

/** Pure live-table builder for the running (isPartial) batch view. One row per
 *  in-flight child, sorted ascending by dispatch index:
 *    `[i] slot ⏱/✓ liveElapsed · currentAction`
 *  - `slot` via {@link formatModelSeg} (fallback-aware; resolved model once known).
 *  - glyph ⏱ while `status !== "completed"`, ✓ once completed (kept in the
 *    registry until endBatch so a finished child still shows its final elapsed).
 *  - `liveElapsed` = `(now - startedAt)/1000` with 1-decimal.
 *  - `currentAction` from {@link summarizeLatestAction}(history), falling back to
 *    the task preview (truncated to 40) when there is no history yet.
 *  PLAIN text (no theme — `execute()` has no Theme; rendered dim by the isPartial
 *  branch of `renderSubagentsResult`). Empty input → "" (header-only). */
export function buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string {
  const sorted = [...entries].sort((a, b) => {
    const ia = childDispatchIndex(a.id);
    const ib = childDispatchIndex(b.id);
    return (Number.isNaN(ia) ? Infinity : ia) - (Number.isNaN(ib) ? Infinity : ib);
  });
  const rows = sorted.map((e) => {
    const idx = childDispatchIndex(e.id);
    const idxLabel = Number.isNaN(idx) ? "?" : String(idx);
    const slot = formatModelSeg(
      e.resolvedModel ?? e.model ?? "default",
      e.requestedModel,
      e.fellBack,
    );
    const glyph = e.status === "completed" ? "✓" : "⏱";
    const elapsed = `${((now - e.startedAt) / 1000).toFixed(1)}s`;
    const action = summarizeLatestAction(e.history) ?? truncateToWidth(e.taskPreview ?? e.workIntent ?? "", 40);
    return `[${idxLabel}] ${slot} ${glyph} ${elapsed} · ${action}`;
  });
  return rows.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all seven `buildLiveTable` tests green.

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): add pure buildLiveTable for the running (isPartial) batch view

One row per in-flight child: `[i] slot ⏱/✓ liveElapsed · currentAction`,
sorted by dispatch index. Plain text (execute has no Theme). Empty → \"\".
Fallback-aware slot via formatModelSeg; action via summarizeLatestAction."
```

---

