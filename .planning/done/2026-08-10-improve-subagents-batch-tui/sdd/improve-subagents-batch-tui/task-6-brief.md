### Task 6: Running-header aggregate + `runningUsage` map + `onUpdate` rewrite

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`execute()` — declare `runningUsage`; `dispatchChild`'s `childSpawnOpts` — wire `onUsage`; the `onHistory` closure's `onUpdate` text)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (new tests + UPDATE the existing `"onUpdate emits a single-line 'k/N running · latest'…"` test to the new multi-line contract)

**Interfaces:**
- Consumes: `SpawnSubagentOptions.onUsage` (Task 1); `buildLiveTable` (Task 5); `sumUsage` (Task 2); `options.inFlight.list()` filtered by `batchId === toolCallId`.
- Produces: a local `const runningUsage = new Map<string, AgentUsage>()` in `execute()` (keyed by `childRunId`); `onUsage: (u) => { runningUsage.set(childRunId, u); }` on `childSpawnOpts`; and a rewritten `onUpdate` text = header line `subagents · running/total running · Σtok · $Σ` (Σ from `runningUsage`) + `\n` + `buildLiveTable(batchEntries)`.

**Render-target cell (running-live header):** `subagents · N/M running · Σtok · $Σ` (Σ omitted when zero). The collapsed view shows this header line only; ctrl-o (expanded) shows header + live table — both handled by `renderSubagentsResult`'s existing `isPartial` branch (`text.split("\n")[0]` vs full), which is unchanged.

- [ ] **Step 1: Write the failing tests (and update the existing onUpdate test)**

In `tests/subagents-tool.test.ts`, REPLACE the existing test body:

```ts
test("onUpdate emits a single-line 'k/N running · latest' as children progress", async () => { … });
```

with this updated-contract version (the live header is now multi-line: header + live table; `latest:` is gone from the header):

```ts
test("onUpdate emits a multi-line header + live table: `subagents · k/N running · Σtok · $Σ` then one row per child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const updates: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    updates.push(u.content.map((c) => c.text).join(""));
  };
  const spawn = async (opts: {
    task: string;
    onUsage?: (u: AgentUsage) => void;
    onHistory?: (h: { kind: string; toolName?: string; text?: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onUsage?.(U(500, 0.05));
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "r" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
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
  const firstHeader = first.split("\n")[0] ?? "";
  assert.match(firstHeader, /^subagents · \d+\/2 running/, "header shows `subagents · k/N running`");
  // child #0 already reported usage (500 tok) before this tick → aggregate present
  assert.match(firstHeader, /500 tok · \$0\.050/, "header carries the Σtok · $Σ aggregate (tokens first)");
  assert.ok(!firstHeader.includes("latest:"), "the old `latest:` label is gone from the header");
  assert.ok(first.includes("[0]"), "the live table row for child #0 is present (multi-line)");
});
```

Then ADD these new tests:

```ts
test("runningUsage map is fed by onUsage and drives the live-header Σ across children", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const headers: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    headers.push((u.content.map((c) => c.text).join("").split("\n")[0] ?? ""));
  };
  let i = 0;
  const usages = [U(1000, 0.1), U(2000, 0.2)];
  const spawn = async (opts: { task: string; onUsage?: (u: AgentUsage) => void }): Promise<SpawnSubagentResult> => {
    const idx = i++;
    opts.onUsage?.(usages[idx] ?? U(0, 0));
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute("batch-sig", { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 }, NO_SIGNAL, onUpdate as never, NO_CTX);
  const lastHeader = headers[headers.length - 1] ?? "";
  assert.match(lastHeader, /3000 tok · \$0\.300/, "Σ accumulates across both children's onUsage");
});

test("onUpdate is try/caught: a throwing buildLiveTable path never fails the child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  // Sabotage list() to throw mid-onUpdate; the child must still complete.
  const badList = () => {
    throw new Error("boom");
  };
  inFlight.list = badList as never;
  let completed = false;
  const spawn = async (opts: { task: string; onHistory?: (h: { kind: string }[]) => void }): Promise<SpawnSubagentResult> => {
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  const res = await tool.execute("batch-throw", { tasks: [{ task: "#0" }] }, NO_SIGNAL, undefined, NO_CTX);
  completed = (res.details.results[0] as { status: string }).status === "done";
  assert.equal(completed, true, "child completed despite a throwing inFlight.list() during onUpdate");
});
```

(`U`, `NO_SIGNAL`, `NO_CTX`, `AgentUsage`, `SpawnSubagentResult` are already in scope in the test file — `U` is the helper added in Task 2; `AgentUsage` is imported in Task 2's test additions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — the updated onUpdate test still expects the old single-line `latest:` format; the new Σ-header + live-table tests fail because `onUsage` is not wired on `childSpawnOpts` and the onUpdate text is unchanged.

- [ ] **Step 3: Write minimal implementation**

In `execute()`, declare the running-usage map near the other batch state (`acc`, `gateTripped`, etc.):

```ts
      // Per-child final usage, captured via the additive onUsage callback
      // (fires once at each child's completion). Feeds the running (live)
      // header's Σtok/$Σ. NOTE: onUsage is completion-triggered, so the Σ is
      // "sum over children completed so far" — not a per-token live ticker.
      const runningUsage = new Map<string, AgentUsage>();
```

In `dispatchChild`, inside the `childSpawnOpts` object literal, add an `onUsage` alongside the existing `onModelResolved` / `onModelFallback` / `onHistory`:

```ts
          onUsage: (u) => {
            runningUsage.set(childRunId, u);
          },
```

Then replace the body of the `onHistory` closure's `try { … onUpdate?.(…) }` block. The new text is a header line + a live table (multi-line). Replace the existing block:

```ts
            try {
              const group = (options.inFlight?.list() ?? []).filter((e) => e.batchId === toolCallId);
              const running = group.filter((e) => e.status !== "completed").length;
              const total = params.tasks.length;
              const agg = sumUsage(runningUsage.values());
              const aggStr = agg.total > 0 ? ` · ${agg.total} tok · $${agg.cost.toFixed(3)}` : "";
              const header = `subagents · ${running}/${total} running${aggStr}`;
              const table = buildLiveTable(group);
              const text = table ? `${header}\n${table}` : header;
              onUpdate?.({
                content: [{ type: "text" as const, text }],
                details: undefined as never,
              });
            } catch {
              // swallowed — onUpdate is diagnostic only (mirrors the singular tool)
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — the updated onUpdate test + both new tests green; all other tests green. (The existing `renderSubagentsResult isPartial+collapsed shows a compact single-line; expanded shows full` test stays green because it feeds a literal string and only asserts the renderer's line-splitting, which is unchanged.)

- [ ] **Step 5: Full package gate, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build && bun test )`
Expected: biome clean, tsc clean, ALL unit tests green (including every pre-existing subagent/subagents test).

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): running header Σtok/$Σ + multi-line live table via onUsage

execute() keeps a runningUsage Map<runId,AgentUsage> fed by the additive
SpawnSubagentOptions.onUsage (Task 1). The onHistory→onUpdate text is now a
header (`subagents · k/N running · Σtok · $Σ`) + buildLiveTable rows. Stays
try/caught (diagnostic only). Mirrors the single card's per-run meta in the
running state."
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

- **Render targets table (3 states):**
  - Running-live header `subagents · N/M running · Σtok · $Σ` → Task 6 (`onUpdate` rewrite).
  - Running-live per-child row `[i] slot ⏱/✓ liveElapsed · currentAction` → Task 5 (`buildLiveTable`) + Task 6 (wired into `onUpdate`). *(`(id)` caller tag intentionally omitted — Plan-time decision #3; `InFlightSubagent` has no caller-tag field.)*
  - Done-collapsed header `batch (X ok · Y failed · Z skipped) — Ts · $Σ · Σtok` → Task 3 (header `aggStr`).
  - Done-collapsed per-child `[i] (id) ✓ model · elapsed · $cost · Ntok · "task"` → Task 3 (`formatSlotMeta` + quoted task). *(`✓` = fixed-width padded badge, preserved — decision #5.)*
  - Done-expanded header (same) → Task 3 (shared header build).
  - Done-expanded per-child `### [i] (id) status` + meta `model · elapsed · $cost · Ntok` + output → Task 4.
- **Components 1–6:** ① `formatUsage` → Task 2. ② `formatSlotMeta` (+ shared `formatModelSeg`) → Task 2. ③ `renderSubagentsResult` rewrite (header + collapsed + expanded) → Tasks 3 + 4. ④ `buildLiveTable` → Task 5. ⑤ `onUpdate` rewrite → Task 6. ⑥ `runningUsage` map + `onUsage` wiring → Task 6 (map/wiring) + Task 1 (the exposed callback). ✅ No gap.
- **Data flow:** Done path (`BatchResultSlot` fields → `formatSlotMeta`, no new plumbing) → Tasks 2–4. Running path (`inFlight.list()` filtered by `batchId` → `buildLiveTable`; aggregate from `runningUsage`) → Tasks 5–6. ✅
- **Error handling:** builders defensive (`formatUsage`/`formatSlotMeta`/`buildLiveTable` degrade; null/budget/aborted preserved — Tasks 3–4) ✅; `buildLiveTable` empty → header-only (Task 5) ✅; `onUpdate` stays try/caught (Task 6 has an explicit throwing-list test) ✅.
- **Testing section:** unit tests for `formatUsage`/`formatSlotMeta`/`buildLiveTable` (Tasks 2, 5) ✅; `renderSubagentsResult` collapsed + expanded across slot variants done/failed(null)/budget/aborted × {with,without usage} × {with,without id} × {fallback,no fallback} (Tasks 3, 4) ✅; existing tests kept green except the one updated in-task (Task 6) ✅.
- **Out of scope:** SDD/commit-scope/watchdog tags — not added (correct, N/A for read-only batch) ✅. Single `subagent` card — untouched ✅.

**2. Placeholder scan** — searched for TBD / TODO / "add appropriate" / "similar to Task" / undefined-type references: **none found.** Every code step contains concrete code; every type referenced (`AgentUsage`, `InFlightSubagent`, `BatchResultSlot`, `SubagentsToolDetails`, `Theme`) is defined in the repo or in an earlier task. The float-sum `0.30000000000000004` in the `sumUsage` test is asserted verbatim (JS float arithmetic), not hand-waved.

**3. Type consistency** — checked names/signatures across tasks:
- `formatUsage(u: AgentUsage | undefined): string` — defined Task 2, used Tasks 2 (inside `formatSlotMeta`) only. ✅
- `formatModelSeg(model, requestedModel?, fellBack?)` — defined Task 2, used by `formatSlotMeta` (Task 2) and `buildLiveTable` (Task 5) with identical arg order. ✅
- `formatSlotMeta(slot, theme)` — defined Task 2, consumed Tasks 3 + 4 with the same slot-shape cast. ✅
- `sumUsage(values): { total; cost }` — defined Task 2, consumed Task 3 (done header) + Task 6 (live header). ✅
- `buildLiveTable(entries, now?)` + `childDispatchIndex(id)` — defined Task 5, consumed Task 6 (`buildLiveTable(group)`). ✅
- `SpawnSubagentOptions.onUsage?: (u: AgentUsage) => void` — defined Task 1, wired Task 6. ✅
- `runningUsage: Map<string, AgentUsage>` — declared Task 6, keyed by `childRunId` (same id used in `inFlight.start({ id: childRunId, … })`). ✅

**Issues found & fixed inline during review:** none required — the plan-time decisions (#1–#6) were encoded up front precisely because they resolve spec/code tensions (one-shot `onUsage`, missing caller-tag field, no-Theme-in-execute, badge-width preservation, Σ order). The single existing test whose contract changes (`onUpdate` single-line) is explicitly updated in Task 6 rather than left to break.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-08-10-improve-subagents-batch-tui/plans/improve-subagents-batch-tui.md`. Two execution options:

**1. Subagent-Driven Development (recommended)** — dispatch a fresh subagent per task (6 tasks), review between tasks. Best fit here: the tasks are tightly sequential (Task 6 depends on 1 + 5; Tasks 3–4 share a file and a function with 2), pure-render tasks 2–5 are fast isolated cycles, and a per-task review gate catches any drift in the exact meta string format before it compounds.

**2. Inline Execution** — execute the tasks in this session via executing-plans, with checkpoints after Task 1 (the shared-options change) and Task 4 (done-view complete) before the running-view Task 6.

Which approach?
