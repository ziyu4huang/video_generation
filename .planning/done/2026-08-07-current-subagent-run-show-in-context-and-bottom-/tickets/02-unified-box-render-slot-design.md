---
type: grilling
status: closed
claimed: claude
---

# 02 — Unified box: render-slot design + Surface A's fate

## Question

The unified box must be a persistent widget (`setWidget`, placement `aboveEditor`/`belowEditor`) that renders Surface A's rich format (reusing `renderSubagentCall`/`formatSubagentLive`/`renderSubagentResult`) for all running subagents from the registry. But A's inline transcript block and the persistent widget are DIFFERENT render slots. What happens to A's inline block, and what are the box's placement + rendering rules? Three shapes:

- **α — single persistent rich box for ALL runs (incl current turn), suppress A's inline block.** True single home; trade-off: the scrolling transcript loses A's inline live block AND its persisted rich history (only `/subagents` shows completed-run history).
- **β — A stays inline for the current-turn call (live + persisted history); persistent box shows ONLY background/concurrent runs (not the current turn).** No duplication; preserves inline history; the box is empty when the only run is the current turn's call.
- **γ — both kept.** Active call shown in both -> duplication returns (rejected by the original complaint).

Decide: α vs β (γ ruled out); the box's placement (`aboveEditor` vs `belowEditor`); and the rich-vs-compact rule (does the current-turn call in the box get the full tool tree, or a compact line like B had?).

**blocked by:** 01 (closed)

## Resolution

**Decided 2026-08-07 (grilling). Shape β.**

- **A stays inline, unchanged** — Surface A's `renderCall`/`onUpdate`/`renderResult` keep rendering the current-turn subagent call in the scrolling transcript (live + persisted scrollback history).
- **New persistent box replaces B** — one `setWidget("subagents", factory, { placement: "aboveEditor" })`, reading the shared `SubagentInFlightRegistry` live (reuse the 1000ms `setInterval -> tui.requestRender()` + `render() reads list()` pattern). Renders ONLY runs A doesn't show (background/concurrent); when the only running subagent is the current turn's call, the box is empty -> collapses to ~0 -> no duplication.
- **Rendering: rich header + collapsible tool tree, collapsed by default** — reuse `renderSubagentCall` (header) + `formatSubagentLive` (tree); default collapsed, expand on key. (A keeps full-rich for the current turn; `/subagents` keeps the rich interactive full view.)
- **Surface B removed** — delete `subagent-progress-widget.ts` + the `installSubagentProgressWidget` call + its tests; its role is absorbed by the new box.

**Graduating fog (implementation, not a product decision):** the box must EXCLUDE the current turn's active subagent tool call so it doesn't duplicate A. The registry has no foreground flag, and the widget factory can't see core's `pendingTools`/active ToolExecutionComponent. Resolving this (e.g. a foreground flag on registry runs, or a way for the widget to learn the active toolCallId) is an implementation detail to settle at build time — likely interacts with 03's data-model. Logged in the map's Not-yet-specified.