---
type: grilling
status: closed
claimed: claude
---

# 03 — Workflow / background data source for the unified box

## Question

Ticket 01 found `workflow` (foreground AND background) never writes into the shared `SubagentInFlightRegistry` — so a unified box reading `registry.list()` is blind to background workflow runs, the category that needs visibility most. Does the destination cover background workflows at all, and if so how? Fork:

- **A — box covers `subagent`/`subagents` only (registry scope, = today's B).** Background workflows stay invisible (as today). Smallest lift; honest "remove B + unify formatting."
- **B — box also covers background workflows.** Bigger lift. Two sub-options (decide after picking B): (b1) merge the workflow manager's live `WorkflowAgentSnapshot` snapshots (`pi-agent-ext-workflow/src/display.ts:25`, status `queued|running|done|error|skipped`) into the box alongside the registry; or (b2) make the `workflow` path register into the shared registry (thread `getSubagentInFlightRegistry()` through `createWorkflowTool` -> `WorkflowManager` -> `WorkflowAgent.run`, start before `startInBackground` returns the runId, end on detached completion) — but `InFlightSubagent`'s shape lacks workflow's richer status model.

Decide: A (workflows out of scope) vs B (cover them, then b1 vs b2).

**blocked by:** 01 (closed)


## Resolution

**Decided 2026-08-07 (grilling). Shape B + b2.**

- **B — box covers background workflows.** The unified box (02) shows background `workflow` runs alongside `subagent`/`subagents`, closing the gap 01 found (workflows register nowhere today -> invisible everywhere).
- **b2 — workflow registers into the shared `SubagentInFlightRegistry`.** Thread `getSubagentInFlightRegistry()` through `createWorkflowTool` -> `WorkflowManager` -> `WorkflowAgent.run` (and the `agent()` runner); `start` BEFORE `startInBackground` returns the runId; `end`/`markCompleted` on (detached) completion.
- **Consistency win:** because BOTH the new box AND the existing `/subagents` viewer read the same registry, workflow runs appear in both automatically — single data source, unified everywhere.
- **Trade-offs accepted:** (1) the workflow ENGINE is touched (more invasive than b1); (2) `InFlightSubagent`'s shape lacks workflow's richer status (`queued|done|error|skipped`) -> map to running/completed/error or minimally extend the shape (build-time, see map Not-yet-specified).

**Graduating fog (build-time, from this decision):** registration GRANULARITY (per-workflow aggregate vs per-agent individual — affects box density); InFlightSubagent shape extension; whether foreground (`background:false`) workflows also show in the box or only inline (interacts with 02's current-turn-exclusion). Logged in the map's Not-yet-specified.