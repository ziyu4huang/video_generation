# t02 — Steer in the tool-execution window: honest state, guaranteed delivery

Effort: 2026-09-10-self-arc-22-subagent-steer-deploy · map D4/D6/D7
Packages: `bun-apps/s2-agent-core-runtime` + `bun-apps/s2-agent-ext-subagent`
Status: open

## Problem

Steering a background child 15s into a `sleep 90` tool call (session
`2026-09-09T22-17-23-960Z_…jsonl`, steer toolCall 22:17:56Z) returned
`steered:false` → "ran as a fresh turn", and the fresh turn never reached the
child's output — the child completed and reported without the guidance
("had just gone idle" reading at 22:19:01Z). The verb is both dishonest (it cannot
see the tool window) and ineffective (the fallback path drops the text).

Code facts (read 2026-09-10, this worktree):

- `core-runtime/src/persistent-agent.ts:89` — `LiveAgentStatus = "running" | "idle"`
  only; `send()` (:208-226) maps running → `session.steer` + `{steered:true}`,
  idle → `session.prompt` under a per-exchange timeout; `_status = "idle"` at
  exchange end (:288). No tool-phase state exists.
- `ext-subagent/src/subagent-runs-tool.ts:349-373` — steer action reply branches
  only on `r.steered`; leverless runs → `"not steerable"` (:368).
- `ext-subagent/src/child-dispatch.ts:82-86,190` — the steer lever is wired only
  for named live agents (correct boundary, arc-19 D6 — unchanged here).

## Work

1. **Surface the tool-running state (map D4).** Add a third live-agent state
   (tool-window busy) driven by the exchange subscription's tool-call events — the
   state MUST be distinguishable from both model-exchange "running" and true
   "idle" (hard constraint from the queue head). First verify what the pi session
   API exposes to core-runtime (Fog-of-war item); if tool-phase events are absent,
   find or add the seam in core-runtime's session ownership.
2. **Guaranteed queued delivery.** When tool-running, deliver the steer text as a
   queued user turn that provably runs after the current exchange completes:
   - Preferred: pi's own session queue, IF t02 proves it drains (unit test with a
     fake long-running tool asserting the queued marker reaches the child's next
     model input).
   - Fallback (makes the guarantee ours): a LiveAgent-held pending-steer queue
     drained at the exchange-end idle transition (:288) before the agent reports
     idle. The receipt's void must be impossible by construction.
3. **Honest 3-way reply** in `subagent-runs-tool.ts` steer action — exactly one of:
   steered-into-current-exchange / queued-runs-after-current-tool / child-idle-ran-
   immediately (with a reply snippet). Update the `steer` param docs (:56) and tool
   description (:255, :257) to state the three outcomes. Keep the "not steerable"
   boundary text.
4. **tui-drive steer drill scenario** (`ext-subagent/scripts/tui-drive.ts` +
   `scripts/lib/tui-drive-lib.ts`): background child with a long tool call → steer
   mid-tool with a distinctive marker → assert the child's final output CONTAINS
   the marker (use UI_VOCAB + boot gate + provenance discipline from arc-19 t01;
   glm-5.3 child, flash excluded by name — map D6).

## Tests

- Core-runtime unit test: fake tool sleeping N ms; steer mid-tool → assert
  (a) the state read at steer time is the tool-window state, (b) the marker
  reaches the child's next exchange input (drain proof), (c) the steer result
  reports the queued outcome.
- Ext-subagent test: the 3-way reply text per outcome (extend the fake-run
  harness pattern from arc-19 t02's tests).
- tui-drive drill compiles into the scenario set without regressing the existing
  vocab/hardening tests (`tests/tui-drive-vocab.test.ts`,
  `tests/tui-drive-hardening.test.ts`).
- **Schema-cost delta generated and cited in the PR body** (map D7):
  `bun bun-apps/s2-agent/src/cli.ts tools-metrics --schema-cost --json`
  (before/after numbers for `list_subagent_runs`).

## Done when

The mid-tool steer unit test passes (state + drain + honest reply); both packages'
canonical gates green (`core-runtime` and `ext-subagent`: their `bun run check` /
`bun test` per package scripts); schema-cost delta cited; drill scenario present
(live receipt happens in t03 — not this ticket's done-gate).

## Risks

- The pi session queue may not expose tool-phase events — the LiveAgent-held queue
  fallback must then also cover the model-exchange window (a steer arriving during
  a model turn already works via `session.steer`; do not regress it).
- Tool-description growth inflating schema cost — keep the outcome vocabulary
  tight; cite the delta either way.
