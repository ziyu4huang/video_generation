---
type: research
status: closed
claimed: wayfinder-chart
---

# 01 — Research: subagent-display wiring, TUI placement, registry population

## Question

What are the exact render seams for the three subagent display surfaces (A inline transcript, B below-editor widget, C `/subagents` viewer), what persistent placement does the TUI offer for an always-on unified box, and which execution paths (`subagent`, `subagents`, `workflow` foreground/background) actually write into the shared `SubagentInFlightRegistry` a unified box would read? (Unblocks the design tickets 02 and 03.)

## Resolution

**Answered 2026-08-07 (charting-session research pass; two subagents, Q1-Q4).**

**Render seams.**
- Surface A (inline `subagent ▸ ... ▸ ... ▸ "..."` + indented `↳` tool tree) rides the standard pi tool-contract, NOT an activity stream: `renderCall` (`subagent-tool.ts:764` -> `renderSubagentCall:325`) for the header; `onUpdate` partials from the `onHistory` callback (`:610-624` -> `formatSubagentLive:313`) for the live tree; drawn by core `ToolExecutionComponent.updateDisplay()` (`tool-execution.js`). Lives in the scrolling transcript; per-tool-call; persists as history when done.
- Surface B reads `SubagentInFlightRegistry.list()` each tick.
- A's richness is funded entirely by the tool-contract; a widget gets none of it — it must re-invoke the exported helpers itself. Formatting reusable; render slot NOT shared.

**Placement.** `ui.setWidget` placement accepts exactly `"aboveEditor" | "belowEditor"` — both persistent, in the editor dock (outside the scrolling transcript), collapse to ~0 when idle. No third placement. Factory overload `(tui,theme)=>Component` is uncapped. Register once, then `requestRender()` per tick (re-`setWidget` reorders).

**Registry population (the make-or-break):**

| Path | Registers in shared registry? | Visible to a `registry.list()` box? |
|---|---|---|
| `subagent` (singular) | YES (`subagent-tool.ts:574` start / `:760` end) | YES |
| `subagents` (fan-out) | YES, each child batched (`subagents-tool.ts:277` start / `:326` markCompleted / `:416` endBatch) | YES |
| `workflow` foreground | NO (no `inFlight` in `workflow-tool.ts` / `WorkflowManager` / `WorkflowAgent`) | NO |
| `workflow` background (default) | NO | NO |

-> A unified box reading `registry.list()` today sees concurrent `subagent`/`subagents` runs but is **blind to background `workflow` runs** — the category that needs visibility most. Closing that gap is ticket 03's fork.

**Refresh.** 1000ms `setInterval -> tui.requestRender()` + `render()` re-reads `list()` live; registry exposes no push/subscribe (polling only). Pattern reusable as-is.