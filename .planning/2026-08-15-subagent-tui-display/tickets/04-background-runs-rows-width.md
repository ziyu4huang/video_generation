---
type: task
status: open
blocking: 01
---
# 04 — Background-runs bottom-panel rows width-aware

## Question

How do the background-runs section rows honor the width they already receive?

## What to build

- The bottom-panel subagents section (background runs) starts consuming the width parameter its render signature already receives (currently discarded): run-row detail lines and quoted-activity lines truncate by terminal column at the real width.
- The shared row helpers (`renderActivityRow`, `renderRunRow`) gain an optional width defaulting to today's constants, so the detached viewer's output stays byte-identical unless a width is passed — nested fixed-cap leftovers stop undercutting the viewer's own width handling.

## Acceptance

- [ ] Section `render(theme, width)` rows respect width.
- [ ] Exact-row pins updated only where cap semantics intentionally change.
- [ ] Detached viewer pins unchanged.
- [ ] Dock hint line untouched.
