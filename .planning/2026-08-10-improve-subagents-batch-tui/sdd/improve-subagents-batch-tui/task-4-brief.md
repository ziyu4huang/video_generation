### Task 4: Done-expanded per-child meta line

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`renderSubagentsResult` expanded branch, ~line 720-745)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `formatSlotMeta` (Task 2); the slot variants' fields (`model`/`requestedModel`/`fellBack`/`elapsedMs`/`usage` on done/timedout/aborted/budget; absent on null).
- Produces: the expanded branch prepends a `formatSlotMeta` line above each child's output, for every slot variant that carries `model` + `elapsedMs` (done/timedout/aborted/budget). Null (failed) slots are unchanged (no meta line).

**Render-target cell (done-expanded):** `### [i] (id) status` + meta line `model · elapsed · $cost · Ntok` + output.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
test("done expanded: prepends a `model · elapsed · $cost · Ntok` meta line above each child output", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "Full audit report\nLine two",
        status: "done",
        id: "a",
        index: 0,
        task: "audit",
        model: "zai/glm-5.2",
        elapsedMs: 34500,
        usage: U(15715, 0.0004),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 34500,
  };
  const expanded = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: true }, THEME);
  const lines = expanded.split("\n");
  assert.match(lines[1] ?? "", /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/, "meta line sits directly under the ### header");
  assert.ok(expanded.includes("Full audit report"), "output preserved under the meta line");
});

test("done expanded: budget + aborted slots get a meta line too (no usage → model · elapsed only)", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        status: "budget",
        source: "child" as const,
        exhaustion: { kind: "tokens" as const, limit: 1000, actual: 2000 },
        index: 0,
        task: "t-budget",
        model: "zai/glm-5.2",
        elapsedMs: 800,
      },
      { output: "", status: "aborted", index: 1, task: "t-aborted", model: "zai/glm-5.2", elapsedMs: 300 },
    ],
    dispatched: 2,
    skipped: 1,
    elapsedMs: 1100,
  };
  const expanded = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: true }, THEME);
  assert.match(expanded, /glm-5\.2 · 0\.8s[\s\S]*skipped/);
  assert.match(expanded, /glm-5\.2 · 0\.3s[\s\S]*aborted/);
});

test("done expanded: null (failed) slot has NO meta line (unchanged failed body)", () => {
  const details: SubagentsToolDetails = {
    results: [null, { output: "ok", status: "done", index: 1, task: "t", model: "zai/glm-5.2", elapsedMs: 100 }],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 100,
  };
  const expanded = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: true }, THEME);
  const failedBlock = expanded.split("### [1]")[0];
  assert.match(failedBlock, /### \[0\] failed/);
  assert.doesNotMatch(failedBlock, /· .*s ·/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — the expanded branch emits no meta line above the output.

- [ ] **Step 3: Write minimal implementation**

In the expanded branch of `renderSubagentsResult`, the `.map((slot, i) => { … })` currently builds per-slot blocks. Add a meta line to the `done`/`timedout`/`aborted` case AND the `budget` case. Replace the existing `return` for the normal (done/timedout/aborted) case with one that prepends `formatSlotMeta`, and add a meta line to the budget case. Concretely, rewrite the map body:

```ts
    .map((slot, i) => {
      if (slot === null)
        return `${theme.bold(`### [${i}] failed`)}
${theme.fg("dim", "_(null — child failed; re-run via the singular `subagent` tool to see the error)_")}`;
      // Meta line shared by every variant that carries model + elapsedMs
      // (done/timedout/aborted/budget). usage optional → formatSlotMeta degrades.
      const metaLine = formatSlotMeta(
        slot as { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
        theme,
      );
      if (slot.status === "budget") {
        const label = slot.source === "child" ? "child budget" : "batch budget";
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped`)} — ${theme.fg("warning", `${label}: ${slot.exhaustion.kind} ${slot.exhaustion.actual} > ${slot.exhaustion.limit}`)}
${metaLine}`;
      }
      if (slot.status === "aborted") {
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} aborted`)}
${metaLine}
${theme.fg("dim", "_(user-aborted mid-flight)_")}`;
      }
      const output = slot.output || "_(empty output)_";
      return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} ${slot.status}`)}
${metaLine}
${theme.fg("toolOutput", output)}`;
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all three new expanded tests green AND the pre-existing `"renderSubagentsResult expanded"` test still green (its `### [0] (a) done` header + output remain; the new meta line is additive and its fixture has no usage → `flash · 3.5s`, which the existing loose assertions don't contradict).

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): done-expanded prepends per-child meta line (model · elapsed · cost · tokens)

Every slot variant carrying model+elapsedMs (done/timedout/aborted/budget)
gets a formatSlotMeta line above its output. Null (failed) slots unchanged."
```

---

