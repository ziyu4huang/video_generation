# Always-on subagent progress widget

## Problem

When one or more subagents are running — especially several at once via the
`workflow` tool's `parallel()` — the parent session has **no passive,
always-visible** view of their real-time progress. Today the only live signals
are:

- the **call line** (spinner + `subagent ▸ agent ▸ model ▸ task` — no progress text),
- the **result area** collapsed (a 2-line header; the full ≤100-line activity
  trace only appears via a manual `Ctrl-O` expand),
- the **`/subagents` viewer's Running row** (one line, but only visible while
  that modal is open).

To answer "what are my running subagents doing right now?" the user must either
remember to expand the right result block with `Ctrl-O` or open `/subagents` —
both are **active, modal** actions that interrupt the main conversation. There
is no glanceable, always-present surface.

## Solution

A persistent **below-editor widget** (`ctx.ui.setWidget`) that mirrors the
`/subagents` Running row but is always visible while ≥1 subagent is in-flight,
and renders nothing (zero screen footprint) when idle. It reads the existing
**shared in-flight registry singleton** that the `subagent` tool already writes
to — no new data path. Re-render is driven by a 1 s timer calling
`tui.requestRender()` (the same mechanism the `/subagents` viewer already uses),
deliberately avoiding the widget-reorder flicker that re-calling `setWidget`
every tick would cause.

It lives in `pi-agent-ext-workflow` (same package as the `/subagents`
viewer/command), mounted once at `session_start`, and reuses the existing
`renderActivityRow` + `summarizeLatestAction` helpers so each row is visually
identical to the viewer's Running row.

## User stories

1. **Glance while working** — while a subagent runs and I keep typing/reading in
   the main view, I see a live line per running agent below the editor: agent ▸
   model ▸ latest action ▸ elapsed ▸ tool count. No key press needed.
2. **Many at once** — when `parallel()` dispatches N agents, I see all N rows
   updating in place, and can tell which are still running vs. which finished (a
   row disappears on completion).
3. **Zero noise when idle** — when no subagent is running, the widget renders
   nothing; it never reserves screen space.
4. **Consistent with `/subagents`** — the row shown in the widget is the same
   shape/text as the Running row in `/subagents`, so there is no second mental
   model.
5. **Non-interfering** — the widget captures no input, does not reorder other
   widgets (goal/todo/wayfind stay put), and coexists keyed under `"subagents"`.

## Implementation decisions

- **Approach**: widget strip (Option 1), not an overlay panel. Always-on,
  zero-toggle.
- **Placement**: `belowEditor` — the workflow package's own default in
  `display.ts`; keeps it off the crowded above-editor region where
  goal/todo/wayfind live.
- **Density**: one line per running agent + one compact header line
  (` N subagent(s) running`) shown only when ≥1 is active.
- **Row content**: built with the same `ActivityRow` shape the viewer's Running
  row uses, via `renderActivityRow` + `summarizeLatestAction` — so the format is
  identical to `/subagents`'s Running row, not a bespoke literal. Illustratively
  one line carrying agent ▸ model ▸ latest-action ▸ elapsed ▸ tool-count, e.g.
  `▸ implementer ▸ gemma-4-12b-qat ▸ edit src/x.ts ▸ 3.2s · 4 tools`.
- **Visibility**: `registry.list()` empty → `render` returns `[]` → invisible
  (mirrors `createWidgetWorkflowDisplay`'s `snapshot ? lines : []`).
- **Re-render trigger (v1)**: a 1 s `setInterval` → `tui.requestRender()`, with
  the `tui` ref captured from the factory's `_tui` argument. The factory is
  registered **once**; we do NOT re-call `setWidget` each tick —
  re-registration reorders the widget to the end of the widget list (per the
  `status-widget.ts` note), and `requestRender` avoids that. **Pitfall (plan must
  address)**: `_tui` is only available once the app invokes the factory, and the
  app may invoke it more than once (e.g. theme change) — so the timer must start
  exactly once (idempotent guard) and stay session-scoped; the exact lifecycle
  mechanics are plan territory.
- **Lifecycle**: mount once at `session_start` in `extensions/workflow.ts`
  (where the viewer/command already wire the shared singleton); the widget reads
  `getSubagentInFlightRegistry().list()` live on each render. No explicit unmount
  is needed (session-scoped).
- **Ownership boundary preserved**: lives in `pi-agent-ext-workflow`; does NOT
  move the viewer into the subagent package (the `display.ts ⟹ workflow.ts`
  cycle constraint from ADR 0001 stands). The subagent package is untouched in
  v1.
- **Trigger v2 (deferred)**: if the 1 s cadence feels laggy, add an additive
  `subscribe(cb)` to `SubagentInFlightRegistry` (called in
  start/update/updateModel/end) and have the widget subscribe → `requestRender`.
  Pure addition; not needed for v1.

## Test seam

- **Pure class** `SubagentProgressWidget` (mirrors `SubagentViewer`):
  constructor takes `{ getRunning: () => InFlightSubagent[], theme }`; exposes
  `render(width): string[]` (cached on width, `invalidate()` clears). No TUI, no
  `ctx`. Unit-test:
  - idle → `[]`,
  - one running agent → header + one row, content matches `renderActivityRow`,
  - N agents → header + N rows,
  - resolved-model swap is reflected (passes `resolvedModel`),
  - every line ≤ `width` (truncation),
  - `invalidate()` rebuilds (theme change).
- **Wiring** `createSubagentProgressWidget`: a fake `setWidget`-capturing ctx
  (mirror `tool-gate-banner.test.ts` / `status-widget.test.ts`): assert
  `setWidget` is called once with key `"subagents"`, `placement: "belowEditor"`;
  the factory's `render` reads the registry live and returns `[]` when empty; the
  timer calls the captured `requestRender`. Assert it is a safe no-op when `ctx`
  has no `setWidget` (headless/RPC mode) — same guard as the existing widgets.

## Out of scope (v1)

- Overlay drill-in panel (Options 2/3) — deferred; the widget's 1-line summary is
  v1, the overlay is an additive follow-up if it proves too terse.
- Surfacing completed runs' full transcript in the widget (Done runs already show
  final output in `/subagents`; the persisted history JSON stays inspection-only).
- Per-agent multi-line trace inside the widget (use `Ctrl-O` result expand or
  `/subagents` for that).
- Token-level streaming (history is per-turn, throttled — unchanged).
- Touching the subagent package (the registry `subscribe` is a v2 refinement
  only).

## Open questions

None remaining for v1 — trigger = timer (A), header = included; both confirmable
at spec review.
