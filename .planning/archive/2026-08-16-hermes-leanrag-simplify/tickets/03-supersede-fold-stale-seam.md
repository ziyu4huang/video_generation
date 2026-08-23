---
ticket: 03
status: done
blocked-by: [01]
---

## Goal

Fold `memory_supersede` into the `memory` tool as an action; turn `grill_decision` and `planning_stale` into internal handlers.

## Scope

- Demote the three tools; wire supersede as an action on `memory`.
- MUST keep publishing the `__piHermesStaleCheck` seam — the wayfind graduation reads it.

## Acceptance

- Seam tests green (knowledge-pipeline-seam + wayfind stale-seam contract).
- Tool count reduced accordingly.
