---
type: task
status: closed
blocked by:
findings: M4, M6, M8
resolved: 2026-08-12 — shipped in #1061 — error glyph ✗; all-done panel; overlay + response-envelope TDD suites
---

# 09 — Todo render correctness + overlay/envelope test suite (TDD)

## Problem

The entire overlay/render/envelope layer is **untested**, and it has two real UX bugs: (M4) `renderTodoResult` shows a green ✓ for **failed** operations; (M6) when every task is completed and subsequently hidden, the whole panel vanishes (early return before the heading).

## Evidence

- M4: `core-task/src/todo/view/format.ts:123-147` — no `details.error` check; fallback `return new Text(theme.fg("success", "✓"))` at `:147`. `buildToolResult` sets `details.error` (`tool/response-envelope.ts:55`). Failed create/get/delete → empty/unchanged `details.tasks` → `✓`.
- M6: `core-task/src/todo/overlay.ts:111` `if (overlayTasks.length === 0) return [];` fires **before** the heading (`:124-128`).
- M8: `stealth-trim.test.ts` asserts only that `promptSnippet`/`promptGuidelines` are undefined; `todo.test.ts` covers reducer/graph/schema only. Grep for `TodoOverlay.render` / `hideCompletedTasksFromPreviousTurn` / `renderTodoResult` / `selectOverlayLayout` in `*.test.ts` = **zero** todo hits.

## Approach (TDD)

1. **Write the test suite first** — `overlay.test.ts` (drive `TodoOverlay` through create→complete→`agent_start`→hide; golden-string renders at narrow widths; the all-completed-hidden case) + `response-envelope.test.ts` (`formatContent`/`renderTodoResult` incl. the error case). Both new tests should **fail** (red), proving the bugs.
2. **Fix M6** — compute counts first; if `counts.total > 0` but `overlayTasks` is empty, still emit the heading (optionally "✓ all done") before returning.
3. **Fix M4** — at the top of `renderTodoResult`, check `details?.error` and render `theme.fg("error", "✗ Error")` before the status switch.
4. Tests go green.

## Acceptance

- [ ] `overlay.test.ts` + `response-envelope.test.ts` added; both bugs reproduced-then-fixed by them.
- [ ] Failed todo op renders an error glyph, not ✓.
- [ ] All-completed-hidden still shows the heading.
