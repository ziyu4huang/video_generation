---
type: grilling
claimed: pi-agent (autonomous — user pre-agreed, option B)
status: closed
---

# 02 — Per-tracer-bullet plan files: plan.md → plans/<NN>-<slug>.md

## Question

superpowers `writing-plans` writes ONE plan per effort: **`.planning/<effort>/plan.md`** (singular). The user wants per-tracer-bullet plan files under **`.planning/<effort>/plans/<NN>-<slug>.md`** — mirroring `tickets/<NN>-<slug>.md`, one plan per ② tracer-bullet — so the implementation plan for each slice lives beside its ticket.

**Decide:** adopt plural `plans/<NN>-<slug>.md` (one per ②), or keep singular `plan.md`?

### Recommendation

**Adopt plural `plans/<NN>-<slug>.md`.** Reasons:

- **Symmetry with `tickets/`:** `tickets/<NN>-<slug>.md` (the ② slice) sits beside `plans/<NN>-<slug>.md` (that slice's implementation plan). One slice → one ticket → one plan, all under the same effort, all numbered in lockstep.
- `writing-plans` already contemplates this: *"If the spec covers multiple independent subsystems… suggest breaking this into separate plans — one per subsystem."* Plural files make that first-class instead of an exception.
- Removes the naming-collision risk with wayfind's `task_plan.md` (the phase spine): `task_plan.md` (singular, wayfind seed) vs `plans/*.md` (plural, superpowers) are now visually distinct, instead of `plan.md` vs `task_plan.md`.

### Sub-decisions to grill (resolve in order)

1. **Reader-site updates.** Two skills hardcode the singular path and must follow the change:
   - `requesting-code-review/SKILL.md:60` — `PLAN_OR_REQUIREMENTS: Task 2 from .planning/<effort>/plan.md`
   - `subagent-driven-development/SKILL.md:277` — `[Read plan file once: .planning/<effort>/plan.md]`

   Both become `.planning/<effort>/plans/<NN>-<slug>.md` (the plan for the slice under review / being executed).

2. **Numbering / linking.** Does `plans/<NN>-<slug>.md` reuse the **same `NN`** as its `tickets/<NN>-<slug>.md` (so `tickets/03-foo.md` → `plans/03-foo.md`), or renumber independently? Recommendation: **same NN** — the plan is the ② ticket's expansion, so they share identity.

3. **Effort-discovery** (the fog patch — see map *Not yet specified*). How does `writing-plans` know which `<effort>` to write into? Today `<effort>` is agent-inferred. Decide whether a prose convention ("the effort handed to you by `/wayfind seed` — read from `task_plan.md`'s location") is enough, or whether wayfind should record an active-effort marker. Recommendation: **prose convention first** — `writing-plans` resolves `<effort>` from the `task_plan.md` it was handed (the hand-off already implies the effort); add a marker only if a real SDD run proves the ambiguity bites.

### On resolution

Edit `pi-agent-ext-superpowers/skills/{writing-plans,requesting-code-review,subagent-driven-development}/SKILL.md` prose to the new path + reader updates. That edit is the superpowers execution hand-off.

## Resolution (closed 2026-07-19 — autonomous, user pre-agreed with recommendation)

**Adopt plural `plans/<NN>-<slug>.md`** — one implementation-plan file per ② tracer-bullet, under `.planning/<effort>/plans/`.

**Sub-decisions resolved:**

1. **Reader sites:** `requesting-code-review/SKILL.md:60` + `subagent-driven-development/SKILL.md:277` → `.planning/<effort>/plans/<NN>-<slug>.md` (the plan for the slice under review / being executed).
2. **Same-NN linking:** `plans/<NN>-<slug>.md` reuses the **same `NN`** as its `tickets/<NN>-<slug>.md` — the plan is the ② ticket's expansion, shared identity. (`tickets/03-foo.md` ↔ `plans/03-foo.md`.)
3. **Effort-discovery = prose convention** (fog graduated + resolved): `writing-plans` resolves `<effort>` from the `task_plan.md` it was handed — the `/wayfind seed` hand-off already implies the effort dir. **No active-effort marker** unless a real SDD run proves the ambiguity bites.

**Hand-off edits** (`pi-agent-ext-superpowers/skills/`):
- `writing-plans/SKILL.md` — `.planning/<effort>/plan.md` → `.planning/<effort>/plans/<NN>-<slug>.md` (lines 18, 160).
- `requesting-code-review/SKILL.md` — line 60 path.
- `subagent-driven-development/SKILL.md` — line 277 path.
→ see change-list in map close.
