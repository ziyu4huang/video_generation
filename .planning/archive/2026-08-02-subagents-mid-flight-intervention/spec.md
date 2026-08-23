# subagents per-child mid-flight abort (Frontier A) — spec

> Charted from `.planning/2026-08-02-subagents-mid-flight-intervention/map.md`.
> The live-visibility arc (#988 → #993 → #1008) shipped **user-facing live
> visibility** (Ctrl-O trace, `/subagents` Running section, always-on progress
> widget) but left the **intervention** half missing: the only mid-flight
> control is whole-turn Esc, which kills *every* in-flight child. This effort
> adds **per-child abort**.

## Goal

Let the user abort **one specific running subagent** from the `/subagents` list
view (cursor onto a Running entry → `x` → confirm y/N), without aborting its
siblings or the rest of the turn. The aborted child gets a distinct `aborted`
status, surfaces in the Completed section, and the parent model receives
`"Subagent aborted by user."` Works for **both** the singular `subagent` tool
and the `subagents` batch tool.

## Background — the fog, grounded in code

**Dispatch is synchronous/blocking to the parent model.** Both tools do
`await spawn(...)`; the parent LLM is suspended for the whole dispatch. So the
literal frontier label "parent-model live visibility" is ill-posed — the parent
can't act mid-flight. The tractable, valuable core is the **user's** missing
intervention lever (D0 reframe, confirmed).

**An abort primitive exists but is whole-turn only.** `externalSignal:
AbortSignal` flows: parent tool-call `signal` → `spawnSubagent`'s internal
`AbortController` (spawn-subagent.ts:223) → child `session.abort()`
(agent.ts:530). The singular tool passes `externalSignal: signal` (the parent
tool-call signal). The batch tool passes **no** signal to children at all
(`_signal` unused) — so **whole-turn Esc does not abort batch children today**.

**On signal-abort, spawn never throws.** `tryOnce()` catches the runner's
`Error("Subagent was aborted")`, `classifyError(_, signalAborted=true)` →
`{transient:true, timedOut:true}`, and returns `{exitCode:124, timedOut:true,
output:""}`; the retry guard `if (opts.externalSignal?.aborted) return
first.result` short-circuits. So a user-abort is today **indistinguishable from
a timeout** — `deriveSubagentStatus` maps `{exitCode:124, timedOut:true}` →
`"timedout"`. Detection must be post-hoc, not from the result shape.

## Decisions (resolved via grilling — all confirmed the recommendation)

- **D0 — Destination = per-child user abort (Reframe A).** The "parent-model
  live visibility" label is ill-posed under the synchronous model; the valuable
  core is the user's missing intervention lever. Live visibility is already
  shipped. Rejected non-blocking dispatch (Reframe C) — fundamental engine
  change, its own multi-effort arc.

- **D1 — Surface = `/subagents` list view + `x` key.** Cursor onto a Running
  entry → `x` (special-cased before the filter-input block, like `a`=showAll)
  → confirm y/N → abort that one child. Consistent with the existing
  select→follow interaction on Running rows. Rejected a widget-row affordance
  (widget isn't selectable) and a separate picker (new UI surface).

- **D2 — Status = new `aborted`, surfaced in Completed.** A distinct `aborted`
  status (vs done/failed/timedout/budget); aborted runs appear in the Completed
  section as `aborted` entries; the parent model gets result text
  `"Subagent aborted by user."` Clear provenance for both viewer and model.
  Rejected reuse-`failed` (conflates user-abort with a crash) and vanish
  (loses the audit trail).

- **D3 — Confirm guard = y/N before abort.** A confirm sub-state in the viewer
  (`Abort this subagent? y/N`); `y` aborts, `n`/Esc cancels. Cheap fat-finger
  guard — abort discards in-progress work (esp. partial edits for real-tree
  children).

## Design (grounded in the abort semantics above)

- **Per-child `AbortController` in both tools.** Each tool creates
  `const childAc = new AbortController()`, **fans in the parent `signal`**
  (so whole-turn Esc still aborts — for the batch tool this is a *new*, tested
  improvement), passes `externalSignal: childAc.signal` to `spawn`, and
  registers `abort: () => childAc.abort()` on the in-flight entry.
- **User-abort detection is post-hoc.** After `spawn` returns:
  `const userAborted = childAc.signal.aborted && !(signal?.aborted)`.
  - user abort → `childAc` aborted, parent `signal` not → `userAborted=true` →
    status `"aborted"`, output `"Subagent aborted by user."`
  - whole-turn Esc → parent `signal` aborted (fans into `childAc`) →
    `userAborted=false` → existing `timedout` path (unchanged).
  - timeout → spawn's *internal* controller aborts (not `childAc`) →
    `childAc.signal.aborted=false` → `userAborted=false` → `timedout` (unchanged).
- **`InFlightSubagent.abort?: () => void`** + **`registry.abort(id)`** calls it
  (distinct from `end()`, which removes the entry).
- **Viewer `x` key + confirm sub-state.** `x` on a Running entry sets a
  `confirmAbortId`; the next `y` calls `onAbort(id)` → `registry.abort(id)`,
  `n`/Esc cancels. An `onAbort?: (id: string) => void` viewer option is wired
  to `registry.abort` in `subagents-command.ts`.

## In scope

- **`src/subagent-in-flight.ts`** — `InFlightSubagent.abort?` field;
  `SubagentInFlightRegistry.abort(id)`.
- **`src/subagent-tool.ts`** — per-child `AbortController` (fan-in parent
  `signal`); `userAborted` detection → `"aborted"` status +
  `"Subagent aborted by user."` output; `SubagentToolDetails.status` gains
  `"aborted"`; `renderSubagentResult` `aborted` badge.
- **`src/subagents-tool.ts`** — per-child controller per dispatch; slot gains
  `"aborted"` status (task/model/elapsedMs already present from #1008);
  `renderBatchResult` `aborted` line; batch children now fan-in parent `signal`
  (tested behavior change — whole-turn Esc now aborts batch children).
- **`src/subagent-viewer.ts`** — `x` key handler (Running entries only,
  pre-filter block) + `confirmAbortId` sub-state + confirm footer line;
  `onAbort?` viewer option; Completed rendering of `"aborted"` badge.
- **`src/subagent-run-persistence.ts`** — `SubagentRunStatus` gains `"aborted"`
  (additive; aborted runs persist like done/failed/timedout).
- **`src/subagents-command.ts`** — wire `onAbort: (id) => registry.abort(id)`.
- **Tests** — in-flight (`abort(id)` fires the lever), singular tool
  (`userAborted` detection, whole-turn/timeout unaffected, `aborted` slot +
  text), batch tool (per-child abort, sibling unaffected, fan-in Esc,
  `renderBatchResult`), viewer (`x`→confirm→`y`/`n`, non-running ignores `x`,
  filter-active ignores `x`, Completed `aborted` badge), reconstruct
  (`aborted` surfaces for singular + batch).

## Out of scope (deferred — separate effort)

- **True non-blocking dispatch** (Reframe C) — parent model polls/intervenes
  mid-flight; fundamental engine change.
- **Auto-abort on loop/error heuristics** — a child that errors repeatedly is
  *visible* live (trace shows `⚠ error`); surfacing an auto-abort signal is a
  follow-on once manual abort exists.
- **Worktree rollback on abort** — a real-tree child's partial edits remain
  (detection only, like `commitScope`); a worktree child's teardown already
  runs in the `finally`. No automatic rollback this effort.

## Implementation surface

| File | Change |
|------|--------|
| `src/subagent-in-flight.ts` | `InFlightSubagent.abort?`; `registry.abort(id)` |
| `src/subagent-tool.ts` | per-child controller + fan-in; `userAborted` detection; `"aborted"` status + text + badge |
| `src/subagents-tool.ts` | per-child controller + fan-in per dispatch; slot `"aborted"`; `renderBatchResult` line |
| `src/subagent-viewer.ts` | `x` key + confirm sub-state + footer; `onAbort?`; Completed `aborted` badge |
| `src/subagent-run-persistence.ts` | `SubagentRunStatus` += `"aborted"` |
| `src/subagents-command.ts` | wire `onAbort` → `registry.abort` |
| `tests/*` | 3 TDD tasks (registry+tool / batch / viewer+reconstruct) |

## Acceptance criteria

1. From the `/subagents` list view, cursor on a **Running** entry + `x` shows a
   `Abort this subagent? y/N` confirm; `y` aborts only that child; `n`/Esc cancels.
2. Aborting one batch child does **not** abort its siblings — they keep running.
3. An aborted child leaves the Running section and the parent receives
   `"Subagent aborted by user."` with `details.status === "aborted"`.
4. Aborted runs surface in the **Completed** section with an `aborted` badge
   (both singular and batch children).
5. **Whole-turn Esc** still aborts everything (singular unchanged); it now also
   aborts batch children (fan-in improvement). A **timeout** still reports
   `timedout` (not `aborted`) — detection distinguishes them.
6. `x` is a no-op on non-Running entries and when a filter is active; a stray
   `x` never aborts without the y/N confirm.
7. All existing viewer / reconstruct / tool tests stay green; new tests cover
   the lever, detection (3 paths), batch isolation, confirm flow, and Completed
   surfacing.

## Footguns (carry into the plan)

- **Detection is post-hoc signal inspection, not the result shape.** spawn
  returns `{exitCode:124, timedOut:true}` for *any* signal abort — the ONLY way
  to tell user-abort from timeout is `childAc.signal.aborted &&
  !signal.aborted`. The test must pin all three branches (user / whole-turn /
  timeout) explicitly.
- **Fan-in order matters.** Create `childAc`, wire `signal → childAc.abort`
  listener, THEN pass `childAc.signal` to spawn. If the parent signal is
  already aborted at dispatch, abort `childAc` immediately (mirror spawn's own
  guard) so the run never starts.
- **Batch tool's `_signal` becomes `signal`.** Today unused; wiring the fan-in
  is a tested behavior change (Esc now aborts batch children). Do NOT also
  change the soft budget gate ("never aborts in-flight") — that's a different
  axis.
- **Confirm sub-state must short-circuit other keys.** While `confirmAbortId` is
  set, only `y`/`n`/Esc are handled; nav/filter/enter are ignored so the user
  can't accidentally follow or filter mid-confirm.
- **The registry `abort(id)` is a no-op after `end()`** (entry gone) — mirrors
  `update()`/`updateModel()`. An abort that races with natural completion must
  not throw.
- **`renderSubagentResult` / `renderBatchResult` byte-stability.** The new
  `aborted` branch is purely additive; existing done/failed/timedout/budget
  rendering is byte-identical. Pin with before/after snapshot tests.
- **Shared singleton unaffected.** `abort(id)` is a new method on the existing
  process-local registry; the singleton plumbing is unchanged.
