---
effort: 2026-07-19-goal-todo-handoff-stopgap
superseded-by: 2026-07-19-a
---

# Map — Goal/Todo hand-off stopgap (Option A)

## Destination

Drive the two WORKING TUI layers (`/goal` + `todo`) **manually at the skill
layer** at the planning→execution hand-off, recording the missing middle layer
as a deferred ADR. **(Shipped as PR #678; superseded — see Out of scope.)**

## Notes

This effort was spec-driven (no tickets): `spec.md` (the 4-step hand-off
protocol) + `plans/01-goal-todo-handoff-stopgap.md`. ADR-0003
(`pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md`)
is the diagnostic companion.

## Decisions so far

- Shipped as **PR #678** (manual skill-layer protocol) + **ADR-0003** recording
  the deferred middle layer (the "plan coordinator" — designed but never built).

## Not yet specified

_(none)_

## Out of scope

- **⚠️ SUPERSEDED by [`2026-07-19-a`](../2026-07-19-a/map.md)** — the manual
  skill-layer convention injections this stopgap shipped (PR #678) are **reverted
  by 2026-07-19-a/01** (restore skill fidelity: byte-identical to upstream except
  pi-port glue), and the missing middle layer is built properly as the **unified
  coordination layer inside goal-todo** (2026-07-19-a decisions 02+03; build =
  2026-07-19-a/09). ADR-0003 stands as the diagnosis. This effort is retained for
  history; its `spec.md` / `plans/` are the record of "what was tried and
  superseded". See
  [2026-07-19-a/06](../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
