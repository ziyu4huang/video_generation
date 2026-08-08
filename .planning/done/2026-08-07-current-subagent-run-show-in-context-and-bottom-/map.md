---
effort: 2026-08-07-current-subagent-run-show-in-context-and-bottom-
created: 2026-08-07
last: 2026-08-07
status: complete
---

# Wayfinder map: 2026-08-07-current-subagent-run-show-in-context-and-bottom-

## Destination

A single persistent "subagent context" box — a `ui.setWidget` widget in the `aboveEditor` slot — that live-renders ALL currently-running subagent activity that ISN'T already shown inline by Surface A: background/concurrent `subagent`/`subagents` runs AND background `workflow` runs (the latter newly wired in via 03). It renders Surface A's rich format (header + collapsible tool tree, collapsed by default, reusing `renderSubagentCall`/`formatSubagentLive`). It replaces today's separate below-editor progress widget (Surface B). Surface A (inline current-turn rendering) stays unchanged; `/subagents` stays as the on-demand interactive viewer (and now also shows workflow runs via the shared registry). All pre-build DECISIONS are resolved (01-03); remaining items are build-time impl details.

## Notes

- Three display surfaces today: **A** = inline transcript block (`bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`, `renderCall`/`onUpdate`/`renderResult`; current-turn only; persists as history); **B** = always-on below-editor widget (`subagent-progress-widget.ts`, reads `SubagentInFlightRegistry`); **C** = `/subagents` full-screen viewer (`subagent-viewer.ts`).
- TUI has exactly TWO render slots: inline-transcript (per tool-call, scrolls) and persistent-widget (`setWidget` placement `aboveEditor`|`belowEditor`, in the editor dock, collapses to ~0 idle).
- Formatting helpers `renderSubagentCall`/`formatSubagentLive`/`renderSubagentResult` reusable; render slot NOT shared.
- Registry write reality (01): `subagent`/`subagents` register in the shared `SubagentInFlightRegistry`; `workflow` (both modes) does NOT today — 03=b2 closes this.
- Refresh: 1000ms `setInterval -> tui.requestRender()` + `render() reads list()`; no push/subscribe (poll only).
- Packages: `bun-apps/pi-agent-ext-subagent/` and `bun-apps/pi-agent-ext-workflow/`.
- Charted on dead branch `feat/rate-limit-...` (rebased to main tip 0664059d, 0/0); files uncommitted. Implementation MUST start from a fresh branch off main.

## Decisions so far

- [01 — Research: subagent-display wiring, TUI placement, registry population](tickets/01-research-subagent-display-wiring.md) — answered: 2 render slots; formatting helpers reusable; only `subagent`/`subagents` register, `workflow` does NOT.
- [02 — Unified box: render-slot design + Surface A's fate](tickets/02-unified-box-render-slot-design.md) — DECIDED β: A stays inline (unchanged) for the current turn; a new `aboveEditor` persistent box (replacing B) renders background/concurrent runs only, rich header + collapsible tree collapsed by default.
- [03 — Workflow / background data source for the unified box](tickets/03-workflow-background-data-source.md) — DECIDED B+b2: box covers background workflows; workflow path registers into the shared `SubagentInFlightRegistry` (so box AND `/subagents` both show workflow runs).

## Not yet specified

Build-time impl decisions (resolve while implementing, not pre-build grilling):
- How the box EXCLUDES the current turn's active subagent tool call (no duplication with A): registry has no foreground flag; widget can't see core's `pendingTools`. (From 02.)
- Registration GRANULARITY for workflows (b2): per-WORKFLOW (one InFlightSubagent per run, aggregate progress) vs per-AGENT (each `agent()` call registers). Affects box density. (From 03.)
- `InFlightSubagent` shape: how to represent workflow's richer status (`queued|done|error|skipped`) — minimal field extension vs status mapping. (From 03.)
- Foreground workflow (`background:false`) also registers (per 03); it blocks the turn — does it appear in the box too, or only inline? Interacts with the exclusion item above.

Deferred prizes (candidate FUTURE efforts, out of this one's scope):
- Make the unified box INTERACTIVE (selectable rows -> jump into `/subagents` follow).
- Add a push/subscribe API to the registry (replace 1000ms polling; perf).

## Out of scope

- Surface C (`/subagents` viewer) — stays as on-demand interactive view; not merged/removed (though it now also surfaces workflow runs for free via 03=b2).
- The workflow package's own TaskPanel — untouched.
