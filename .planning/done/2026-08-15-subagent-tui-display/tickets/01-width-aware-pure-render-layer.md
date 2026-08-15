---
type: task
status: closed
---
# 01 — Width-aware pure render layer + shared truncation helper prefactor

## Question

How do all pure render/phrase functions become terminal-column-aware without changing default behavior?

## What to build

- Extract a shared width-aware truncation helper module as a prefactor: one surface wrapping the terminal-UI library's width utilities (column- and East-Asian-aware), enforcing a single trailing ellipsis inside the column budget whenever content is cut, a minimum-width floor, and graceful degradation to a clean short line at degenerate widths — never an empty or crashing render.
- Convert the five width-blind pure render helpers — `taskPreview`, `workIntentPreview`, `describeLastActivity`, `latestMessageLine`, `formatHistoryLine` — plus the settled-collapsed one-liner (today hardcoded 60) to truncate by an explicit width through the shared helper.
- Turn today's fixed constants (80 / 60 / 60 / 80 / 200, and the hardcoded settled-collapsed 60) into upper bounds: the effective cap is min(constant, width-derived available space).
- Default width keeps today's exact behavior — every existing caller and its pinned tests pass unchanged.
- Include phrase-shaper adoption in the shared tool-action-label module (optional width defaulting to today's constants, upper-bound min() semantics when passed). Flagged: split to its own ticket during implementation if this adoption balloons.

## Acceptance

- [ ] Unit assertions at widths 40 / 80 / 120 / 200 for every converted helper.
- [ ] CJK double-width strings never exceed the requested width (measured in terminal columns).
- [ ] Ellipsis placement pinned: one trailing ellipsis inside the column budget whenever content is cut.
- [ ] At wide width the constant binds, so existing pins pass unchanged.
- [ ] The previously bare no-ellipsis slices now ellipsize.
- [ ] Row-count caps (streaming expanded tail) explicitly unchanged.
- [ ] Zero new dependencies.

## Resolution

- Helper module `render-width` (`ellipsizeToWidth` / `capWidth`) extracted as the shared truncation surface.
- Five pure functions (`taskPreview`, `workIntentPreview`, `describeLastActivity`, `latestMessageLine`, `formatHistoryLine`) + the settled-collapsed line are now width-aware via pi-tui width utils (CJK-correct).
- Constants become upper bounds `min(constant, width)`; default width keeps legacy behavior.
- Bare-slice sites now ellipsize.
- Streaming row caps untouched (`STREAMING_EXPANDED_TAIL=16`, `maxTraceLines=100`).
- Phrase-shaper adoption in core-runtime DEFERRED (split candidate — map fog note).
- Gates: 604 pass / 0 fail + typecheck clean.
