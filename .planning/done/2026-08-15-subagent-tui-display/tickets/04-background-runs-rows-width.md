---
type: task
status: closed
blocking: 01
---
# 04 — Background-runs bottom-panel rows width-aware

## Question

How do the background-runs section rows honor the width they already receive?

## What to build

- The bottom-panel subagents section (background runs) starts consuming the width parameter its render signature already receives (currently discarded): run-row detail lines and quoted-activity lines truncate by terminal column at the real width.
- The shared row helpers (`renderActivityRow`, `renderRunRow`) gain an optional width defaulting to today's constants, so the detached viewer's output stays byte-identical unless a width is passed — nested fixed-cap leftovers stop undercutting the viewer's own width handling.

## Acceptance

- [x] Section `render(theme, width)` rows respect width.
- [x] Exact-row pins updated only where cap semantics intentionally change.
- [x] Detached viewer pins unchanged. (row-helpers bullet implemented as section-level whole-line guard — helpers live in core-runtime which has no pi-tui dep; observable behavior identical)
- [x] Dock hint line untouched.

## Resolution

- Section-level `fit()` guard via pi-tui `truncateToWidth`/`visibleWidth` applied to header/rows/trace/quote lines at `subagents-section.ts:101/104/119/131`.
- Quote line also feeds width-4 into the `latestMessageLine` ticket-01 helper.
- Dock hint exempt.
- core-runtime `agent-row-display` untouched — zero new deps, no reverse dep.
- Tests: width-40 long-action/CJK/quote cases + wide-120 constant-binds + dock-exemption + byte-identical pins.
- Gates: 799 pass / 0 fail + typecheck clean.
