# Spec: `/subagents` viewer list-view redesign

## Problem Statement

When a session has dispatched many subagents, the `/subagents` viewer's list view
stops being useful for finding and understanding past runs. A user opening
`/subagents` to revisit what a subagent did faces:

- **No timestamp on completed runs.** A completed run's row shows only its ordinal
  (`#3`), status glyph, agent label, and a truncated task preview. There is no
  indication of *when* it ran, so a long list of runs is indistinguishable by
  recency — only their dispatch order (`#index`) is visible.
- **Sparse rows that hide available data.** The row omits model, elapsed time, and
  cost even though the reconstructed `SubagentRun` carries all three. A user
  cannot tell at a glance how long a run took or what it cost without opening it.
- **No way to search or filter.** The only navigation is ↑/↓ through every run on
  the branch. With 20–40 runs in a heavy session (e.g. an SDD pass over a
  multi-task plan), locating the one run that touched a specific task means
  scrolling and reading each preview.
- **No cap.** The whole session branch is reconstructed and rendered; the list
  grows without bound as the session accumulates dispatches.

(*Running jobs first* is **already** satisfied: the unified list renders a
`Running` section above `Subagent runs`, with a divider. This spec leaves it
unchanged.)

## Solution

Redesign the **completed-runs list view** of the `/subagents` viewer so a user can
tell runs apart, find the one they want, and not drown in volume:

1. **Timestamps.** Record each run's wall-clock start time and surface it — a
   glanceable **relative** time on the list row ("5m ago"), and an **absolute**
   time in the output-detail header ("14:32").
2. **Richer rows.** Show the model (short label), elapsed time, and cost in the
   completed row's meta line, alongside the relative timestamp — the data the
   reconstruction already collects.
3. **Inline search.** A fzf-style "type to filter" affordance in the list view:
   printable characters build a query that filters completed (and running) entries
   by task-preview and agent label; non-matches are hidden; `esc` clears the
   filter (a second `esc` closes the viewer).
4. **Cap with show-all.** By default the completed list shows the 20 most-recent
   runs, with a `showing 20 of N` footer and a key to reveal all. **The cap is
   suspended whenever a filter is active**, so searching never silently hides a
   matching run.

## User Stories

1. As a session driver, I want each completed subagent run to show when it ran, so
   I can tell recent work from older work at a glance.
2. As a session driver, I want the completed run's row to show its model, elapsed
   time, and cost, so I can judge a run without opening it.
3. As a session driver, I want to type a few characters and see the list filter to
   matching runs, so I can find the run that touched a specific task quickly.
4. As a session driver, I want `esc` to clear my filter before it closes the
   viewer, so I don't lose the view to a stray keypress.
5. As a session driver, I want the filter to match both the task preview and the
   agent label, so I can find runs by what they did or by who ran them.
6. As a session driver, I want non-matching runs hidden (not dimmed) while
   filtering, so the list shows only what I'm looking for.
7. As a session driver, I want the completed list capped to a manageable number by
   default, so a long session doesn't bury recent runs.
8. As a session driver, I want a visible `showing 20 of N` indicator and a way to
   reveal all, so I know the list is truncated and can expand it.
9. As a session driver, I want my search to see *all* matching runs even beyond the
   cap, so searching for an older run always finds it.
10. As a session driver, I want the output-detail view to show the run's absolute
    start time, so I have an exact reference when revisiting a run.
11. As a session driver, I want the `Running` section to stay on top and unchanged,
    so my live-work-first orientation is preserved.
12. As a session driver, I want relative times to update while the viewer is open,
    so "5m ago" doesn't go stale on a view I've left sitting.

## Implementation Decisions

- **Schema change — record wall-clock start.** Add an optional `startedAt?: number`
  (epoch milliseconds) field to the subagent tool-result details type. Populate it
  from the existing dispatch-start timestamp (`t0`) at the point the details object
  is assembled in the tool executor. This is backward-compatible (optional field;
  absence is tolerated). The run-reconstruction scan reads it onto the in-memory
  run record so both the list row and the detail header have a timestamp to render.
  ```ts
  // details type gains:
  startedAt?: number; // epoch ms — wall-clock dispatch start (for /subagents display)
  ```
- **Completed-row composition.** The list view currently builds each completed row
  from only `{ status, actor, badge: #index, detail: taskPreview }`. Extend the row
  builder input to also carry `startedAt` (relative), `model` (short label),
  `elapsedMs`, and `cost` — the shared activity-row renderer already supports all
  of these; the list simply was not passing them. The task preview remains the row
  tail.
- **Relative-time helper.** A small formatter mapping a delta to a glanceable label
  (`<60s → "just now"`, `<60m → "Nm ago"`, `<24h → "Nh ago"`, else a short
  date). Single source of truth; reused by the row.
- **Absolute-time helper.** A `HH:MM` (local) formatter for the detail header.
- **Inline filter — viewer state + input routing.** The viewer gains a `filter`
  string. In the list view, printable characters append to it, `backspace` pops,
  and `esc` follows precedence: non-empty filter → clear it (stay in list); empty
  filter → close the viewer (existing behavior). The filter is case-insensitive
  substring over each entry's task preview **and** agent label. **Matches only**:
  non-matching entries are excluded from the selectable list (hidden, not dimmed).
  The empty-filter case restores the full (capped) list.
- **Filter status line.** When the filter is non-empty, render a one-line status
  (e.g. `filter: "auth" — 3 matches`) so the user sees their query and result
  count. It replaces the plain nav-hint line while active.
- **Cap — 20 most-recent + show-all.** When the filter is empty, the completed
  entries are limited to the 20 most-recent (by start time / ordinal). The footer
  renders `showing 20 of N` when truncating. A dedicated key (e.g. `a`) toggles
  "show all" for the session. **When the filter is non-empty, the cap is
  suspended** — all matches are shown, because the user is deliberately narrowing.
- **Detail-view header.** The output view's header line gains the absolute start
  time (`HH:MM`), adjacent to the existing status/elapsed/usage.
- **Live-renders for filter staleness.** The existing live-render timer already
  ticks when the view has live content. A relative-time label on a static
  completed list does go stale; rather than re-render every static list every
  second (the flicker the current code deliberately avoids), keep the existing
  "re-render only on input" behavior for the completed list — relative times
  refresh on the next keypress. (A periodic refresh of a *static* list every minute
  is a possible follow-up, not in scope here.)

## Testing Decisions

- **Primary seam: the viewer, via injection — no new seam.** The existing
  `subagent-viewer.test.ts` harness drives `SubagentViewer` with an identity theme,
  injected runs / `getRunning`, and asserts on `render(width).join("\n")` output
  and `handleInput` effects. All new behavior is testable through this same seam:
  feed runs, drive input, assert rendered lines.
- **Relative/absolute time formatters** — pure-function unit tests (boundary cases:
  just-now, minutes, hours, day rollover).
- **Timestamp propagation** — the run-reconstruction scan test asserts
  `details.startedAt` flows onto the in-memory run record; absence (old/legacy
  branch entries) yields no timestamp column rather than a crash.
- **Filter behavior** — type narrows the visible set; backspace widens; `esc` clears
  before closing (precedence); matches both task-preview and agent; case-
  insensitive; non-matches hidden.
- **Cap behavior** — empty filter caps at 20 with the footer; `show-all` reveals the
  rest; a non-empty filter suspends the cap and shows every match. The cursor is
  clamped to the visible set.
- **Row composition** — a completed run with `startedAt`/`model`/`cost`/`elapsed`
  renders all of them; a run missing optional fields degrades gracefully (omits
  the absent meta, no `undefined` leaking).
- Prior art: the existing viewer/command tests for the rendering + input-routing
  pattern; the shared activity-row renderer's existing tests for meta formatting.

## Out of Scope

- **Output-text search** (searching inside a run's full output, not just its
  preview) — heavier; deferred.
- **Virtualized / viewport rendering** — the session-scoped list rarely exceeds
  ~50 runs; a cap suffices.
- **Cross-session history** — loading persisted runs from `~/.pi/subagents/runs/`
  into the viewer (it currently reconstructs the current session branch only).
- **Group-by-status sections** for completed runs.
- **The `follow` (live-stream) view and the `output` view's body** — untouched
  except the output *header* gaining an absolute time.
- **Other slash commands** — only `/subagents` is in scope.
- **A periodic refresh of the static completed list** for fresh relative times
  (see Implementation Decisions; possible follow-up).

## Further Notes

- *Running jobs first* is already implemented (top `Running` section + divider) and
  is explicitly a no-op here; confirmed against `subagent-viewer.ts`.
- The viewer's injection-based design means **all four changes are testable through
  the existing seam** — no host-TUI or live-subagent test is required.
- Filter-and-cap compose by design: an active filter suspends the cap, so the two
  never fight over which runs are visible.
- Vocabulary from `pi-agent-ext-subagent/CONTEXT.md`: the in-memory run record
  (`SubagentRun`), the tool-result details, the in-flight registry, the session
  branch reconstruction. The shared activity-row renderer is the one visual
  language across the task panel, `/workflows`, and `/subagents`.
- Natural next step after this spec: slice into tracer-bullet tickets (`to-tickets`)
  and into the plan coordinator's execution substrate (Superpowers
  brainstorm → writing-plans → SDD).
