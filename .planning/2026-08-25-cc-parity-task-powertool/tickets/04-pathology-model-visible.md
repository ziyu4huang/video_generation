# Ticket 04 — Pathology findings can reach the model (opt-in)

Status: done (PR #2113, squash `0a8fe360`, merged CLEAN 2026-08-28)

## Why

CC surfaces repeated identical failures TO THE MODEL to force a strategy
change. s2's pathology warnings are status-line-only by design (warning.ts:74;
CONTEXT.md "Proactive warning … never injects into the model context") —
the agent in the loop cannot learn it is looping; only the user can, via
`inspect_pathology`. Two adjacent bugs: the warning count freezes at its
first-warn value (`×3` while the loop grows to `×8`), and `STATUS_KEY` is
global so an in-process subagent child overwrites the parent's warning line.

## Scope

1. **Opt-in injection seam** (D2): env `BUN_PI_PATHOLOGY_INJECT=1` enables a
   once-per-episode (check, tool) note at the next turn boundary — phrased
   like CC's compact-summary trust model: "system note: bash called 4× with
   identical args; change strategy or call inspect_pathology". Default OFF
   preserves the documented non-invasive contract. Investigate the seam
   first: pi turn-boundary injection vs `before_agent_start` prompt prefix
   (map fog) — pick the one that cannot fire mid-stream.
2. **Dedup**: one injection per episode even if the detector keeps firing;
   episode clearing re-arms (reuse the warner's per-(check,tool) episode
   map, keyed per sessionId like the accumulator).
3. **Warning count refresh**: re-set the status text with the current
   magnitude on each evaluation while keeping one-time-notify semantics.
4. **Per-session status key**: `STATUS_KEY` becomes sessionId-qualified so
   children and parents render their own lines.
5. Tests: injection fires once per episode when enabled, never when unset;
   count refresh; per-session key isolation; CONTEXT.md "Proactive warning"
   entry updated to describe the opt-in.

Not in scope: new detectors (ticket 08); threshold configurability on the
warner; TUI rendering changes beyond the key split.

## Done-when

- [x] With the env set, a live retry-loop episode produces exactly one
      model-visible note and the model's next turn sees it (faux-transport
      or real-session receipt). — faux-transport receipt pinned in
      `src/pathology/__tests__/inject.test.ts` ("factory wiring"): the
      captured `tool_execution_end` handler is driven 3× with identical
      calls, then the captured `before_agent_start` handler returns
      `{ message: { customType: "pathology-note", content, display: true } }`
      ONCE; the second boundary returns `undefined`.
- [x] With the env unset, zero model-visible output — status line only
      (test-pinned; existing behavior unchanged). — "env unset through the
      FULL factory path" test: same wiring, `before_agent_start` returns
      `undefined`; plus `injectionEnabled()` pins `=1` as the only enabling
      value ("true" is not).
- [x] Count refresh + per-session key landed with tests. —
      `warning.test.ts` "count refresh" (×3→×4→×6 text updates) +
      `statusKey`/per-session isolation tests; key `pi-pathology:<sid>`,
      per-session episode maps mirror the accumulator.
- [x] Canonical gates green; PR merged CLEAN. — `bun run test` 262 pass,
      `tsc --noEmit` clean, devops `local_ci` pass 88s; PR #2113
      mergeState CLEAN (squash `0a8fe360`).

Implementation notes (seam decision): both candidate seams were
investigated — `before_agent_start` returning `{ message }` vs
`ctx.sendMessage(..., { deliverAs: "nextTurn" })`. Picked
`before_agent_start`: the SDK emits it in `agent-session.js` after the
user message is queued and before the agent loop starts, so it cannot
fire mid-stream, and it needs no action surface (no `triggerTurn` risk).
Pending notes are armed at detection time, dropped on episode end
(re-arm), and the take at the boundary is destructive. Print mode (no
UI) still arms + delivers — the note is model-visible, not UI-visible.
