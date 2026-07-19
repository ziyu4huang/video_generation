---
type: research
status: closed
superseded-by: 2026-07-19-a (ticket 06)
blocked by: 01, 04
---

# 05 — Sync timing & lifecycle

## Question

**When** does the coordination layer parse the plan and sync, and **how do auto-managed todos survive session lifecycle?** Decide / investigate:

- **Parse trigger:** `session_start` (initial full sync)? A file-watch on the plan path (live updates)? `tool_execution_end` after a write to a plan path? Some combination?
- **Lifecycle:** across `session_compact` / `session_tree` / branch-switch, goal-todo already reconstructs state via `replayFromBranch(ctx)` (`src/todo/state/replay.ts`) and swallows stale-ctx errors. Do auto-synced todos replay from the **plan file** (re-parse) or from goal-todo's **own store**? Must avoid clobbering the agent's in-flight todo edits.
- **Concurrency:** other sessions may edit the plan dir concurrently (cf. the wayfinder map). Is re-sync idempotent and merge-safe?

### Context (pre-gathered)

- goal-todo hooks: `session_start/compact/tree` → `replaceState(replayFromBranch(ctx))`; `tool_execution_end` → refresh on `todo` tool success; `agent_start` → hide prior-turn completed. Stale-ctx errors swallowed via `isStaleCtxError`.
- **To verify during research:** what `tool_execution_end` exposes beyond `toolName` + `isError` (does it carry the tool args / output path needed to detect a plan write?), and whether pi offers any file-watch primitive to extensions.
- **From [04](04-sync-mapping.md) (closed) — the timing surface is now TWO-SIDED:** (a) **superpowers** re-parses `docs/superpowers/plans/` + republishes `__piSuperpowersPlan()` / `__piSuperpowersPlanIncomplete()` — *when*? (session_start? file-watch? `tool_execution_end` after a write into the plan path?); (b) **goal-todo** pulls the signal on its hooks AND detects todo toggles by **diffing its own store** on `tool_execution_end` → calls `__piApplyTodoToggle(stepId, checked)`. The lifecycle crux: goal-todo's `replaceState(replayFromBranch(ctx))` on compact/tree reconstructs ITS store — does it **re-pull the plan after replay** (so synced todos survive) or does replay clobber them? Define the ordering (replay first, then re-sync from plan).

## Resolution

**Closed — folded into the unified effort.** The timing/lifecycle decision this
ticket was to research is carried forward as
[2026-07-19-a/04 — sync-timing-and-lifecycle](../../2026-07-19-a/tickets/04-sync-timing-and-lifecycle.md)
under the unified `__piPlan*` seam contract (2026-07-19-a/03: one-way
goal-todo→wayfind; goal-todo self-consumes via internal call). The two-sided
parsing model this ticket assumed (superpowers publishes + goal-todo
subscribes) was superseded by the single-publisher-in-goal-todo design. The
timing decision itself is deferred to the build (2026-07-19-a/09). See
[2026-07-19-a/06](../../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
