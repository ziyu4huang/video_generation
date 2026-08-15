---
ticket: 04-panel-lifecycle
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: [05]
---
# 04 — Panel lifecycle: idle behavior, ordering, affordances, max rows

## Question

When does the views panel show/collapse (P2 idle-collapse analog — but views don't "run"), how
are rows ordered, what affordances does each row carry, and what is the max row count?

## Options — idle behavior

Views have no running/idle state like subagents, so "idle" must be defined by window or count:

- **(A) time-window** — show entries newer than e.g. 24h; collapse/hide the panel when the
  window is empty. (Session-lifetime framing: "this session's renderings".)
- **(B) last-N only** — keep the newest N entries (e.g. 8), collapse when zero. Simple,
  deterministic, but an unbounded day can churn old entries out invisibly.
- **(C) both** — newest-first list of last-24h capped at N (e.g. 8); empty ⇒ collapsed.

### Sub-fork 1 — ordering

Newest-first (matches toast arrival; re-render of an old view floats it to top) vs stable
first-open order vs grouping (today vs earlier). Newest-first is the near-obvious lean; stable
order is defensible if re-renders should not reshuffle.

### Sub-fork 2 — per-view affordances

- `open` (row click → same action as the 03 toast click — shared handler, decided by 03)
- `copy URL` (navigator.clipboard — loopback origin is a secure context, so the API works)
- `dismiss` row (client-side removal from the panel list)
Minimal set = open only; copy URL is cheap and high-value for sharing; dismiss needs a
per-row remove rule consistent with 02's data source (if server-listed, dismiss is
client-side-only overlay).

### Sub-fork 3 — max rows

8 vs 12 vs unbounded-in-memory (panel scrolls). Toast cap (03) is separate and smaller; the
panel is a persistent list so a larger cap + scroll is fine.

## Acceptance

- Idle rule (window/cap/both), ordering, affordance set, and max rows decided; each maps to a
  testable shell behavior for ticket 05.
- Collapse state persistence (e.g. localStorage, `btw-panel-collapsed` precedent) decided or
  explicitly rejected.

## Decision (2026-08-16)

**C** — panel = newest-first, entries <24h old, capped 8; empty ⇒ collapsed. Re-open floats
the entry to top. Row affordances: open / copy URL / dismiss (dismiss is client-side-only).
Collapse state persisted in localStorage (`btw-panel-collapsed` precedent).
See `../spec.md` §Decisions · 04.
