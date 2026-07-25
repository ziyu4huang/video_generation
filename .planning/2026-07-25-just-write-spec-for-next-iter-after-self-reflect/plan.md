# `/subagents` Viewer Resolved-Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/subagents` viewer's Running section show the resolved concrete model (short id) once the child has resolved, instead of staying frozen on the requested `tier:*`.

**Architecture:** Pure read-point change. The `InFlightSubagent` registry entry already carries `resolvedModel?: string` (added by the prior "resolved model on the call line" effort, set via `registry.updateModel(id, model)` during `onModelResolved`). The viewer's Running section currently reads only `entry.model` (the pre-resolution display string). Switch that one read to `entry.resolvedModel ?? entry.model`. The viewer's existing ~1s invalidate timer re-reads the registry each tick, so the row updates live with no new plumbing. The resolved value flows through the viewer's existing `shortModel()` shortening (strips `provider/`).

**Tech Stack:** TypeScript, Bun (`bun test`), the `pi-agent-ext-workflow` package. Viewer renders via `SubagentViewer.render(width)` against a plain identity theme in tests.

## Global Constraints

- **Single slot, not two:** the Running row's model position stays ONE meta item — it swaps from the tier to the resolved model. Do NOT add a second tier+model segment (call-line style). The viewer's dense `·`-meta row uses the short-id idiom throughout.
- **shortModel idiom preserved:** do not introduce full `provider/id` in the viewer. The resolved model passes through the same `shortModel()` the row already uses.
- **Backward compatible / additive:** this is an additive read of an optional field. Entries with no `resolvedModel` (pre-resolution, or older shapes) must behave exactly as today.
- **Done section untouched:** completed runs are reconstructed from persisted records whose stored `model` is already `resolvedModel ?? displayModelBeforeResolve`. No change there.
- **Out of scope:** workflow `agent()` rows; two-segment display; full provider/id; registry/tool/call-line changes (all done or separate).
- **Commits:** English commit messages. Run package tests from the package dir, never top-level `cd`.

---

## File Structure

- **Modify:** `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts` — the Running-section `ActivityRow` build inside `renderList()` (the `model: r.model` line). One line.
- **Test:** `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts` — append two cases modeled on the existing "Running section" test (the `getRunning` fixture pattern).

No new files. No new seam — the existing `subagent-viewer.test.ts` (`viewer.render(80).join("\n")` against an identity theme) is the highest and only seam.

---

## Task 1: Running section reads `resolvedModel ?? model`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts` — in `renderList()`, the Running-section loop, the line `          model: r.model,`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts` — append after the existing "viewer list shows a Running section with live elapsed…" test

**Interfaces:**
- Consumes: `InFlightSubagent.resolvedModel?: string` (re-exported by `@repo/pi-agent-ext-subagent`; already present from the prior effort — set in the live registry by `SubagentInFlightRegistry.updateModel(id, model)`, called from the subagent tool's `onModelResolved`). The viewer's `getRunning?: () => InFlightSubagent[]` already yields entries of this type.
- Produces: nothing new — the Running row's rendered model text changes. No downstream symbol is added; no neighbor task depends on a new name.

- [ ] **Step 1: Write the failing tests**

Append these two tests to `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts` (after the existing "viewer list shows a Running section with live elapsed when getRunning returns in-flight runs" test):

```typescript
test("viewer Running section shows the resolved model (short) once resolvedModel is set", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "tier:medium",
      resolvedModel: "google/gemma-4-12b-qat",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("gemma-4-12b-qat"), "running row shows the resolved model, shortened");
  assert.ok(!out.includes("tier:medium"), "running row no longer shows the stale requested tier once resolved");
});

test("viewer Running section falls back to the model field when resolvedModel is absent", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "tier:medium",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("tier:medium"), "pre-resolution row still shows the requested tier (unchanged behavior)");
});
```

- [ ] **Step 2: Run the tests to verify the expected failure**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )
```
Expected: the **first** new test FAILS (the row still shows `tier:medium`, so `!out.includes("tier:medium")` is false and `gemma-4-12b-qat` is absent). The **second** new test PASSES immediately — it is a regression guard for the unchanged pre-resolution behavior.

- [ ] **Step 3: Make the one-line change**

In `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`, inside `renderList()`'s Running-section loop, change:

```typescript
          model: r.model,
```

to:

```typescript
          model: r.resolvedModel ?? r.model,
```

(Leave the surrounding `ActivityRow` fields and the Done-section code untouched. `r` is typed `InFlightSubagent`, which already has `resolvedModel?: string`, so this typechecks with no import change.)

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )
```
Expected: PASS — both new tests pass, and all pre-existing viewer tests still pass.

- [ ] **Step 5: Run the full package gate**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bun run test )
```
Expected: PASS — this runs `check` (biome) + `build` + `test:unit`. Zero lint errors, build clean, all unit tests green.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(subagent-viewer): show resolved model in Running section"
```

---

## Self-Review

**1. Spec coverage.**
- "Running section reads the resolved model" → Task 1 Step 3. ✓
- "shortModel idiom preserved" → no change to `shortModel`; the resolved value enters the same `row.model` slot that already passes through `shortModel`. ✓
- "single slot, not two" → the edit swaps the slot value, adds no segment. ✓
- "live update already wired" → no code for it; noted in Architecture (1s timer). Verified the registry mutates `resolvedModel` in place and the viewer re-reads on each render. ✓
- "Done section needs no change" → explicitly untouched. ✓
- "backward compatible / additive" → `?? r.model` preserves the old value when `resolvedModel` is absent; pinned by the second test. ✓
- All 5 user stories reduce to the one observable: Running row shows resolved model when known, tier when not. Both covered. ✓

**2. Placeholder scan.** None — every step has exact code/commands; test code is complete and copy-pasteable; the failing/passing expectations name specific assertions.

**3. Type consistency.** `resolvedModel` is referenced identically in the fixture (`resolvedModel: "google/gemma-4-12b-qat"`), the source edit (`r.resolvedModel ?? r.model`), and the Interfaces block (`InFlightSubagent.resolvedModel?: string`). `r` is `InFlightSubagent` from `getRunning?: () => InFlightSubagent[]` (viewer line 75). No name drift.

No issues found. Plan is complete for its scope.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-07-25-just-write-spec-for-next-iter-after-self-reflect/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent for Task 1, review the result, commit. (For a single one-line task this is somewhat ceremonial, but it gives a clean review gate.)

**2. Inline Execution** — I run the steps in this session with executing-plans, checkpoint after the task.

Which approach? (Or: this is plan-only as requested — stop here.)
