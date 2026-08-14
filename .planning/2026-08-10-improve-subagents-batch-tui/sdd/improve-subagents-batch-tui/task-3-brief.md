### Task 3: Done header Σ + done-collapsed per-slot meta

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`renderSubagentsResult` — header build + collapsed branch, ~line 660-720)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `formatSlotMeta`, `formatUsage`, `sumUsage` (Task 2); the existing `batchStatusBadge` + `BATCH_BADGE_WIDTH` (unchanged).
- Produces: `renderSubagentsResult` now (a) appends ` · $Σ · Σtok` to the done header when aggregate usage > 0, and (b) renders each collapsed per-slot line as `[i] (id) badge · <formatSlotMeta> · "task"` (meta replaces the inlined model+elapsed; quoted task preview).

**Render-target cell (done-collapsed):** `[i] (id) ✓ model · elapsed · $cost · Ntok · "task"` — `✓` = the fixed-width padded status badge (kept).

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
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
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(collapsed, /— 3\.0s · \$0\.300 · 3000 tok/);
});

test("done header omits the aggregate suffix when no slot carries usage (byte-stable)", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "a", status: "done", index: 0, task: "t0", model: "zai/glm-5.2", elapsedMs: 1000 },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1000,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(collapsed, /— 1\.0s$/m); // no trailing ` · $… · … tok`
  assert.doesNotMatch(collapsed, /tok/);
});

test("done collapsed: per-slot line shows `badge · model · elapsed · $cost · Ntok · \"task\"` (with usage)", () => {
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
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  const slot0 = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(slot0, /\(alpha\)/);
  assert.match(slot0, /✓ done/); // fixed-width badge kept
  assert.match(slot0, /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/);
  assert.match(slot0, /"audit the parser"/); // quoted task preview
  assert.ok(!slot0.includes("zai/glm-5.2"), "provider prefix dropped on the collapsed line");
});

test("done collapsed: fallback slot shows `requested → actual` in the meta segment", () => {
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
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(collapsed, /claude-opus-4-1 → glm-5\.2 · 1\.0s · \$0\.001 · 10 tok/);
});

test("done collapsed: per-slot meta degrades (no usage → `model · elapsed · \"task\"`)", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "", status: "aborted", index: 0, id: "x", task: "t-aborted", model: "zai/glm-5.2", elapsedMs: 500 },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 500,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  const slot0 = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(slot0, /⊘ aborted/);
  assert.match(slot0, /glm-5\.2 · 0\.5s · "t-aborted"/);
  assert.doesNotMatch(slot0, /tok/);
});

test("done collapsed: null (failed) slot still renders the terse failed line (no meta)", () => {
  const details: SubagentsToolDetails = { results: [null], dispatched: 0, skipped: 0, elapsedMs: 10 };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  const line = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(line, /✗ failed/);
  assert.match(line, /child failed/);
  assert.doesNotMatch(line, /· .*s ·/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — header has no aggregate suffix; collapsed per-slot line still uses the old inlined `model  ·  elapsed  ·  task` (no cost/tokens, no quotes).

- [ ] **Step 3: Write minimal implementation**

In `renderSubagentsResult`, replace the header build and the collapsed branch. First, the header — after computing `done`/`aborted`/`failed`, compute the aggregate and append it:

```ts
  // Aggregate usage across non-null slots that carry usage → header Σtok/$Σ
  // (mirrors the single card's `$cost · Ntok`, appended after elapsed).
  const slotUsages: AgentUsage[] = [];
  for (const s of d.results) {
    if (s && (s as { usage?: AgentUsage }).usage) slotUsages.push((s as { usage: AgentUsage }).usage);
  }
  const agg = sumUsage(slotUsages);
  const aggStr = agg.total > 0 ? ` · $${agg.cost.toFixed(3)} · ${agg.total} tok` : "";
  const header =
    `subagents batch (${done} ok` +
    (aborted ? ` · ${aborted} aborted` : "") +
    ` · ${failed} failed` +
    ` · ${d.skipped} skipped) — ${(d.elapsedMs / 1000).toFixed(1)}s${aggStr}`;
```

Then, in the `!options.expanded` (collapsed) branch, replace the inlined per-slot model+elapsed+task construction. The new per-slot line uses `formatSlotMeta` for the `model · elapsed · usage` segment and appends a quoted task preview. Replace the existing `lines.push(\`  ${…[i]} ${idTag}${badge}  ${model}  ·  ${elapsed}  ·  ${taskPreview60}\`);` with:

```ts
      const meta = formatSlotMeta(
        slot as { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
        theme,
      );
      const taskPreview60 = truncateToWidth((slot as { task: string }).task ?? "", 60);
      const idTag = slot.id ? `${theme.fg("dim", `(${slot.id})`)} ` : "";
      lines.push(`  ${theme.fg("dim", `[${i}]`)} ${idTag}${badge}  ${meta}  ·  ${theme.fg("dim", `"${taskPreview60}"`)}`);
```

Leave the null-slot branch (`[i] ✗ failed  ·  (child failed)`) and the `!slot` continue-guard unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all six new collapsed tests green AND every pre-existing `renderSubagentsResult collapsed` test still green (their fixtures omit `usage` → `formatUsage` returns `""` → lines differ only by the quoted task preview + `formatSlotMeta` separator, which the loose-regex assertions still satisfy; the ticket-05 finding-6 badge-alignment test still passes because `formatSlotMeta`'s model segment still starts right after the padded badge at a consistent offset for the id-less fixture).

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): done header Σtok/$Σ + collapsed per-slot meta (model · elapsed · cost · tokens)

renderSubagentsResult collapsed now uses formatSlotMeta (fallback-aware),
appends quoted task preview, and the header carries the aggregate usage.
Mirrors the single subagent card's per-run meta. Null slot unchanged."
```

---

