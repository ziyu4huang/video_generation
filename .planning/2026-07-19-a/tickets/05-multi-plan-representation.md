---
type: grilling
status: open
blocked by: 03
---

# 05 — Multi-plan representation

## Question

goal-todo has exactly ONE `/goal` and ONE todo list. When multiple plan files exist (parallel features in separate worktrees — both writing-plans outputs and wayfind efforts), is one-active-plan (older 04's assumption: most-recently-modified) sufficient, or aggregate into a namespaced todo list (`[plan-slug] step title`) + rotate `/goal`, or explicit active-plan selection (marker file / user-designated)?

Adopted + restated from the older effort's ticket 06.

### Context

- Lower priority — the common case is one plan at a time. The singular `__piPlan*` signals work until this is revisited.
