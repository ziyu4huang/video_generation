---
type: grilling
status: closed
superseded-by: 2026-07-19-a (ticket 06)
blocked by: 04
---

# 06 — Multi-plan representation

## Question

goal-todo has exactly ONE `/goal` and ONE todo list. When multiple plan files exist in `docs/superpowers/plans/` (parallel features in separate worktrees), how does the integration represent them?

[04 — Sync mapping](04-sync-mapping.md) baked a **one-active-plan** assumption into the singular signals (`__piSuperpowersPlan()` returns one plan; superpowers designates the active = most-recently-modified). This ticket decides whether that's sufficient or needs more:

- **Keep one-active-plan** (simplest; matches the methodology's largely-sequential nature) — inactive plans are simply not synced.
- **Aggregate** all plans into one namespaced todo list (e.g., `[plan-slug] step title` subjects) + rotate `/goal`.
- **Explicit active-plan selection** (a marker file / most-recent / user-designated).

**Lower priority** — the common case is one plan at a time. The singular signals from 04 work until this is revisited.

## Resolution

**Closed — folded into the unified effort.** The multi-plan question is carried
forward as
[2026-07-19-a/05 — multi-plan-representation](../../2026-07-19-a/tickets/05-multi-plan-representation.md).
The one-active-plan assumption this ticket noted (from sync-mapping) still
holds as the baseline; the multi-plan representation decision is a frontier
ticket there. See
[2026-07-19-a/06](../../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
