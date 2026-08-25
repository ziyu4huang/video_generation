**ID:** `ADR-subagent-0007` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# 0007 — Background dispatch decouples the child run from the parent turn

**Status:** accepted
**Date:** 2026-08-22

## Context

A foreground `subagent` tool call blocks the parent turn for the child's whole
life, and the parent's turn-abort fans into every live child:
`dispatchChild` (`src/child-dispatch.ts`) arms an abort listener on
`request.parentSignal`, so a whole-turn Esc (or the turn simply ending) kills
the in-flight child along with it. That coupling is correct for a foreground
call — the result IS the turn's next input — but it makes long recon/write
dispatches hold the parent turn hostage, and it means a background dispatch
would be a contradiction in terms: a run that "survives the turn" cannot be
wired to the turn's abort signal.

The requirement for `background:true` (matching claude-code's background
dispatch): a background run must survive parent-turn end AND whole-turn Esc.
The tool call returns immediately (run id + `"running"`), the dispatch+finalize
lifecycle continues in-process tracked by `BackgroundRunManager`, and the
parent is woken by a `<task-notification>` followUp message on completion —
none of which is compatible with the child dying when the dispatching turn
ends.

## Decision

1. **Background dispatches pass NO `parentSignal` to `dispatchChild`.** The
   fan-in simply never arms: `child-dispatch.ts` sees `parentSignal` undefined,
   skips the abort listener, and the child's abort controller is driven only by
   explicit stops. The registry entry registers `foreground:false` +
   `background:true` so the dock/notify/viewer still observe the run through
   `RunView`.
2. **The kill paths are exactly three:** `list_subagent_runs` with
   `{action:"stop"}` (the LLM-facing lever), the dock/viewer abort lever (the
   human lever), and the child's own timeout/budget/turns fuse (the
   self-limiting lever). Nothing else can end a background run early.
3. **`executionMode: "sequential"` is retained.** The serialization promise is
   about tool calls that OCCUPY the turn; a background `subagent` call returns
   immediately, so it does not hold the turn and the mode costs nothing.
4. **The wake is the followUp seam.** `wireBackgroundDeliverer(pi)` sends the
   notification as a CustomMessage with `{ deliverAs: "followUp",
   triggerTurn: true }` — queued into the running turn while the parent is
   busy, a fresh turn when idle (without `triggerTurn` an idle parent is never
   woken).

## Consequences

- A runaway background run needs an EXPLICIT stop — it will not die with the
  turn, with Esc, or with the parent moving on. The timeout/budget fuse
  backstops this, but an operator (or model) must choose to stop a run that is
  merely unwanted, not stuck.
- **In-process means session death kills runs silently.** Persistence writes
  at completion only, so a session that dies mid-run leaves no record and
  delivers no notification; the slot dies with the process. The Task 05
  **Detached** escape hatch (ADR-0004's mid-flight handoff to an OS
  subprocess) does NOT apply here: `alt+s` / in-viewer `ctrl+b` select
  foreground runs only (`ctrl-b.ts` `foregroundRunIds()` filters
  `views({foreground: true})`, and background runs register
  `foreground:false`; `convertToBackground` refuses already-background runs),
  so a background run cannot be detached later. Its kill paths remain exactly
  the three from Decision 2 — `list_subagent_runs` stop, the dock/viewer
  abort lever, and the timeout/budget/turns fuse.
- The cap fails fast rather than queueing (`SUBAGENT_MAX_BACKGROUND`, default
  4): an over-cap dispatch returns an error naming the running ids and the
  wait/stop levers, instead of accumulating invisible queued work.
- `aborted` on a background run now means "someone chose stop", never
  "the parent turn went away" — the ambiguity the fan-in created is gone by
  construction.
