---
effort: 2026-09-06-self-arc-9
created: 2026-09-07
last: 2026-09-07
status: in-progress
---

# Wayfinder map: 2026-09-06-self-arc-9 — planner-led arc: live modelSeg, pack seam, batch abort

## Destination

The first PLANNER-LED iteration (user directive, 2026-09-07: every new
hands-on loop OPENS by dispatching a GLM 5.3 planning subagent through the
repo's own spawn machinery — `scripts/arc-plan.ts`, agentType
`hard-problem`, explicit `zai/glm-5.3`, never flash). The planner read the
tree and delivered the execution plan for the parity-ledger queue
(`output/arc-plan-self-arc9/plan.md`); this arc executes it.

## Planner findings (all read in-tree by the child)

- t01 is TWO stacked defects: (B) `renderCall` read the RunView ONCE outside
  the composer closure — violating RunView's per-tick contract; the frozen
  `v` meant `updateModel`'s invalidate re-ran the composer but it kept
  projecting the renderCall-time snapshot. (A) the frozen value was the
  literal `default` because `getMainModel` is never wired in production.
- t02: the /agents viewer ALREADY renders pack rows read-only (labels,
  refusals, collision guards) — there is no pack-dir PRODUCER anywhere, and
  pi has no pack concept. Smallest honest fix: an explicit env seam.
- t03: the viewer's x-branch only handled `kind === "running"`; a batch
  header fell through to the filter (per the F-ui-1-designed fallthrough).

## Shipped

- **t01 — live modelSeg**: view + `bindInvalidate` moved INSIDE the composer
  closure (renderCall; renderResult's two paths read fresh per render too —
  batch children linger terminal-but-present until endBatch). `renderSubagentCall`
  omits the placeholder `"default"` segment in BOTH branches (no provider id
  is literally "default"). Regression test renders the SAME component across
  an `updateModel` — fails on the pre-fix code. Receipt: latched
  `liveModelSlot` (+ `sawTaskLine`) judged LINE-BY-LINE (only the line
  carrying the trailing `spawn_subagent` segment can be the call line —
  transcript prose can't fake it).
- **t02 — pack visibility**: `resolvePackDirs(cwd, env)` (`S2_AGENT_PACK_DIRS`,
  colon-separated, relative resolved against cwd) feeds `loadAgentRegistry`
  AND the write-collision refusal; `createAgentsCommand` accepts explicit
  `packDirs` (tests) with the env as the production source. Viewer unchanged
  (already correct). End-to-end unit: env→registry→viewer row labeled
  `extension pack`, e/d refuse, file untouched.
- **t03 — batch abort**: `SubagentInFlightRegistry.abortBatch(batchId)` fires
  every non-terminal child's lever, returns the count fired. Viewer:
  `confirmAbortBatchId` state (Esc/n cancel; y fires `onAbortBatch`), x on a
  RUNNING batch header (running > 0) opens the confirm `Abort all N running
  children? y/N`; all-done headers follow the F-ui-1 fallthrough (x filters —
  by design). `subagents-command` wires `onAbortBatch → abortBatch`.
  `--scenario swarm`: task 1 carries `sleep 10` (a real abort window); the
  gesture fires on the FIRST CHILD evidence (`k/3 running` or a live Task row
  — the parent's spinner fires long before dispatch, receipted), stays in
  the OPEN viewer, latches `batchAbortConfirmed` (confirm gone + terminal
  evidence) and `allChildrenTerminal` with the no-reopen discipline.

## Tickets

- [x] t01 — live modelSeg (closure fix + placeholder honesty + regression + receipt check)
- [x] t02 — pack env seam + end-to-end tests
- [x] t03 — abortBatch + viewer confirm + wiring + swarm drive extension

## Findings

- Planner economics: the first planner run exhausted 24 turns on repo
  reading (2.1M cache-read tokens, zero output) — the fix was an explicit
  READ BUDGET in the prompt (~12 reads, then WRITE) + maxTurns 40. Second
  run: 334s, ~400k tokens, plan delivered with file:symbol citations.
- Receipt-vs-gesture timing: a "running" heuristic keyed on the PARENT's
  spinner fires before any child exists — the viewer opened on an empty
  registry ("No subagent runs on this branch"). Gate gestures on CHILD
  evidence, not parent activity.
- `abortBatch` counts only levers actually fired (an entry without a lever
  is skipped, mirroring abort()'s `?.` semantics) — the first test draft
  counted no-lever children and the count assertion caught it.

## Receipts

- source: `output/self-arc9-dispatch-src-20260907/` (10 checks incl.
  liveModelSlot), `output/self-arc9-swarm-src2-20260907/` (8 checks incl.
  batchAbortFlow/Confirmed + allChildrenTerminal; snap-09 shows `Abort all 3
  running children? y/N`, snap-10 shows `0 ok · 3 aborted` with three
  `⊘ aborted glm-5.3` rows).
- deployed: pending post-merge.
