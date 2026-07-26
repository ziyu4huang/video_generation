---
type: task
blocked by: 05, 06
status: open
---

# 07 — Task: acceptance + test harness for the interactive component

## Question

How do we verify an interactive TUI component that resists unit-testing? Stand up: a render-snapshot test of the isolated component (deterministic input → expected lines), a manual test script / keybinding matrix (↓/↑/Enter/Esc/type-to-filter/empty-state), and the acceptance checklist the component must pass.

## What resolving it looks like

A test harness + acceptance checklist committed; the component's done-ness becomes machine-checkable, not eyeball-only.
