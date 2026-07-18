# 04 — Sync mapping

## Question

How does a parsed plan map onto goal-todo? Decide:

- **Todo granularity:** one todo per plan step (checkbox)? Subject = step title; what goes in the description?
- **`/goal`:** does the coordination layer set the active goal to the plan's `# [Feature] Implementation Plan` header (or a dedicated goal line)? One goal per plan?
- **Sync direction:** one-way (plan→todo; the plan file is source of truth, todos are a derived view) OR bidirectional (checking a todo writes back into the plan file)? This single sub-decision resolves the **conflict/ownership** fog on the map.
- **Identity/stability (the open problem deferred from [01](01-plan-convention.md)):** the adopted checkbox format is **ordinal only** (`- [ ] **Step N**`) — it has no stable step ID. How do plan steps map to stable todo IDs across re-parses, so a re-sync doesn't duplicate or reorder existing todos? (Options: match by ordinal+title hash, by a synthetic id derived from title, or push back on [01] to require IDs.)

Resolving this **graduates** the *conflict/ownership* and *multi-plan representation* patches from the map's **Not yet specified** into either fresh tickets or closed scope.

### Context (from [01 — Plan convention](01-plan-convention.md), closed)

- Format is fixed: `# [Feature] Implementation Plan` header → `/goal`; `- [ ] **Step N: …**` checkboxes → todos.
- Stable step-ID was explicitly deferred HERE — it is this ticket's hardest sub-decision.
- **Mutation channel (settled by [02](02-cross-ext-store-access.md)):** goal-todo mutates its OWN store on a globalThis signal — superpowers does NOT import the store (jiti dual-instance) and CANNOT invoke the `todo` tool (no API). So this ticket also settles: (i) **pull vs push** — goal-todo reads a superpowers-published getter (like `__piPlanIncomplete`) vs goal-todo exposes a `__piTodoSync` write-seam (like `addSection`); (ii) the **published signal's shape/contract** (what superpowers exposes: goal string + ordered steps with a stable key). (iii)–(iv) below are the mapping + ID.
- **Reusable precedent:** goal-todo already gates `goal_complete` by reading `__piPlanIncomplete` (`goal.ts:985`) — the goal_complete-gating fog on the map has a ready mechanism; this ticket decides whether to use it.

type: grilling
claimed: pi-agent
blocked by: 01 (Plan convention), 02 (Cross-ext store access)
status: closed

## Resolution (closed 2026-07-18)

**Bidirectional sync with a clean master-split; title-derived step IDs; `goal_complete` gated on plan-completion.**

- **Sync direction = bidirectional** (plan ↔ todo). Forward plan→todo (goal-todo pulls); reverse todo→plan (write-back).
- **Reconciliation / master-split (the key — no real conflict):** the two sides own DIFFERENT dimensions:
  - **Structure** (step add/remove/reorder) → **plan is master** → flows plan→todo (goal-todo re-syncs structure from the plan on each pull).
  - **Completion** (checked) → **todo is master** → flows todo→plan.
- **Signals (all `globalThis`, per [02](02-cross-ext-store-access.md)):**
  - Forward: superpowers publishes `__piSuperpowersPlan(): { goal: string, steps: [{ id, title, detail, done }] }` — goal-todo pulls on `session_start` / `tool_execution_end`.
  - Reverse: superpowers exposes `__piApplyTodoToggle(stepId, checked)` — goal-todo calls it on detecting a toggle (diff its OWN store); superpowers writes `- [ ]`↔`- [x]` back into the plan file (**plan-file ownership stays in superpowers**; goal-todo never touches plan paths).
  - Gating: superpowers publishes `__piSuperpowersPlanIncomplete(): boolean` — goal-todo reads it to gate `goal_complete`, exactly mirroring `__piPlanIncomplete` (`goal.ts:985`).
- **Stable step-ID = title-derived hash.** id = hash of the step title; both directions match by title, ordinal as tie-break; a title edit ⇒ new identity (old todo orphaned). Zero burden on format/agent. Escalate to an embedded persistent id (via [03](03-bootstrap-soft-instruction.md)) only if title collisions bite.
- **Todo field mapping:** subject = `step.title`; description = `step.detail`; status from `step.done`.
- **`goal_complete` gating = plan-completion** (all steps checked via `__piSuperpowersPlanIncomplete`). verification-before-completion is NOT machine-enforced — it's conversational with no plan artifact under this convention, so it stays a soft skill (agent judgment). (Original destination said "gated on verification"; refined to the detectable proxy.)
- **One-active-plan assumption** baked into the singular signals: superpowers designates the active plan (most-recently-modified in `docs/superpowers/plans/`). Multi-plan representation graduates to [06](06-multi-plan-representation.md).
