---
tracer-bullet: 4
ticket: 09
status: done
depends on: [01, 02]
---

# 04 — Drive the todo from the plan (plan-master seeding)

## Why (ticket 02)

Ticket 02 (closed) settled **structure = plan-master** (plan → todo): the plan is the source of truth for *structure*, the todo tracks *execution*. Tracer-bullet 4 makes the plan seed the todo so the agent sees the roadmap as its primary checklist — but only when the todo has nothing to replay, so it never clobbers in-session work.

## Design (conservative MVP)

**`buildTodoFromPhases(phases, nextId) → TaskState`** — PURE. Each `PlanPhaseInfo` (plan Task ≡ phase) → one `Task`:
- `subject` = phase title; `status` = phase status (pending/in_progress/completed — a subset of `TaskStatus`, assignable directly).
- `description` = `"<done>/<total> steps"` (+ ticket ids if present); `metadata.planPhaseId` = phase id (the `task-<N>`).
- Fresh numeric ids from `nextId`.

**`seedTodoFromPlan(cwd) → boolean`** — reads the coordinator cache; **seeds only when the todo is empty** (`getTodos().length === 0`), so replay-from-branch / prior in-session work is never overwritten. No-op (returns false) when no plan or todo already populated.

**Wiring** — `extensions/core-task.ts` `session_start`, after `refreshPlan` + `replaceState(replayFromBranch)`: `if (getTodos().length === 0) seedTodoFromPlan(ctx.cwd)`. So a fresh session with a plan gets the phases as its todo; a session with prior todo entries keeps them.

## Scope / deferred

- **Granularity = phases** (one Task per plan Task). Step-level seeding (`- [ ]` → Task) deferred — the parser counts steps but doesn't surface them; revisit if step-level tracking is wanted.
- **One-way** (plan → todo on seed). Bidirectional sync (todo completion → plan phase completion, the old `__piApplyTodoToggle` idea) is deferred (ticket 03 explicitly dropped it; the coordinator re-parses the plan file on `tool_execution_end`, so editing the plan stays the source of truth).
- **Id reconciliation**: fresh numeric ids on seed; safe because seed only fires on an empty todo.

## Verification

- `src/plan/__tests__/todo-seed.test.ts`: pure `buildTodoFromPhases` (id/subject/status/description/nextId mapping) + `seedTodoFromPlan` (seeds when empty+plan; no-op when populated; no-op when no plan).
- full `pi-agent-ext-core-task` suite green; `bun run typecheck` exit 0.
