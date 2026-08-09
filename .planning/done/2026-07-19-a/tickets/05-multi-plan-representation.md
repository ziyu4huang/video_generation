---
type: grilling
status: closed
closed: 2026-07-20 (deferred by decision; reopen if multi-plan bites)
blocked by: 03
---

# 05 — Multi-plan representation

## Question

goal-todo has exactly ONE `/goal` and ONE todo list. When multiple plan files exist (parallel features in separate worktrees — both writing-plans outputs and wayfind efforts), is one-active-plan (older 04's assumption: most-recently-modified) sufficient, or aggregate into a namespaced todo list (`[plan-slug] step title`) + rotate `/goal`, or explicit active-plan selection (marker file / user-designated)?

Adopted + restated from the older effort's ticket 06.

### Context

- Lower priority — the common case is one plan at a time. The singular `__piPlan*` signals work until this is revisited.

## Resolution — DEFERRED (2026-07-20); closed — decision = defer

**Decision: defer.** The single active-effort heuristic (the coordinator discovers the most-recent `map.md` under `.planning/<effort>/` and aggregates its `plans/*.md`; `docs/superpowers/plans/` is a fallback) is sufficient for the common case — one plan at a time. The singular `__piPlan*` signal (one phases array, one summary, one incomplete flag) models this correctly. Multi-plan is a hypothetical until two parallel efforts actually need simultaneous coordination in one session.

**Trigger to reopen (spawn a new ticket/effort when ANY bites):**
- An agent works two efforts in parallel worktrees and the WRONG plan's phases surface (or the todo seeds from a stale effort).
- `/goal` + the plan widget disagree because two plans are "active."

**Options to evaluate THEN (not now — YAGNI):**
1. **Aggregate + namespace** — `__piPlanPhases` returns phases across all efforts, each tagged `[effort-slug]`; the todo namespaces steps; `/goal` rotates or pins. Most flexible; most complex (the goal/todo singletons become multi-plan-aware).
2. **Explicit active-plan selection** — a marker file (`.planning/.active`) or a `/plan switch <effort>` command designates the ONE active effort; the coordinator reads only that. Simpler; preserves the singleton model; needs a user action to switch.
3. **Status quo** — keep single-active-effort; the per-cwd cache already isolates parallel efforts into separate sessions. May be enough if parallel efforts rarely co-drive one session.

**Why defer is correct now:** the effort's Destination is met with one plan convention parsed both ways (writing-plans + wayfind). Multi-plan is an orthogonal capacity question with no current consumer. Building it now = speculative complexity (YAGNI). Re-evaluate at the first real collision.
