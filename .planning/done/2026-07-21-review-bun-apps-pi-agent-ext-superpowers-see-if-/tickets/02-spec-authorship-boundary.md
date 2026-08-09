# 02 — Spec authorship boundary: to-spec vs brainstorming

---
type: grilling
blocked by: 01
status: closed
claimed: pi-session (2026-07-21)
---

## Question

`to-spec` (wayfind) and `brainstorming` (superpowers) **both write**
`.planning/<effort>/spec.md` — by design, they share the artifact. But their
*process* differs: `to-spec` is no-interview synthesis of what's already on the
table (invocation-only via `/wayfind spec`); `brainstorming` is interactive
intent/requirements/design exploration (model-invocable).

**Concrete finding (from 01):** the share is currently *aspirational, not real*.
`brainstorming` still writes to the upstream path `docs/superpowers/specs/`
because `unified-planning-dir.patch` (which would fork it to
`.planning/<effort>/spec.md`) is **not applied**. So `to-spec`'s claim that
"this is the same `spec.md` brainstorming writes" is false today. Resolving this
ticket must decide both the *trigger boundary* AND whether the fix is simply
"run the patch" (converge the homes) versus a deeper ownership call.

Resolve the division of labor. Are the current trigger conditions clear enough
that the agent picks the right one, or do they collide (the agent reaches for
`brainstorming` to re-explore what grilling already settled, or reaches for
`to-spec` before anything's been discussed)? Decide between:

- **Keep both, sharpen triggers** — make the "interview done → to-spec;
  interview not started → brainstorming" rule explicit in both descriptions.
- **Unify** — one skill owns spec authorship; the other refers to it.
- **Reassign** — spec authorship belongs wholly to one phase (decide or plan).

Grill one question at a time. Consult ticket 01's finding on what upstream does
at this phase before settling.

## Resolution

**Parallel coexistence, not a shared artifact.** `to-spec` and `brainstorming`
are two independent, each-complete pipelines that happen to both produce a
spec — they are NOT two steps in one flow, and they never actually connected
(to-spec's next stop is `to-tickets`, not `writing-plans`).

Three settled decisions:

1. **Relationship — parallel coexistence.** `to-spec` serves the entry path
   where a decide-phase (`grilling`/`wayfinder`) has already run; `brainstorming`
   serves standalone creative work with no prior decide-phase. The two flows
   stay separate. `to-spec`'s false claim ("this is the same `spec.md`
   brainstorming writes") is corrected to "same unified layout, different entry
   paths."

2. **Home — converge via the stalled patch.** Apply `unified-planning-dir.patch`
   (run `scripts/apply-patches.sh`) so `brainstorming`/`writing-plans` write
   under `.planning/<effort>/` like the rest of the repo. Rationale: layout
   consistency is a repo-wide convention; the fork cost is already paid
   (idempotent patch, re-applied on every upstream sync). This also resolves
   the headline finding from ticket 01 (the patch was written but never
   converged).

3. **Trigger — entry-path mutual exclusion, minimal fork.** The rule:
   `brainstorming` = decide-phase not yet run; `to-spec` = decide-phase already
   settled. State it ONLY in this-repo-owned surfaces — sharpen `to-spec`'s
   `description` ("use ONLY after grilling/wayfinder has settled the decisions")
   and add a one-line deferral note to the `using-superpowers` bootstrap
   ("when a wayfind decide-phase has run, brainstorming defers to to-spec").
   Do NOT fork `brainstorming`'s verbatim upstream body (keeps ADR-0004 fidelity
   surface minimal).

**Execution handoff (out of this map's decision-scope — downstream effort):**
the concrete work this decision implies is (a) run `apply-patches.sh` to
converge the homes, (b) edit `to-spec`'s description, (c) add the bootstrap
deferral note. That execution graduates as a downstream task once ticket 03
(decomposition boundary) is decided too — the patch convergence is shared
across both. NOTE for 03: the "parallel coexistence" framing and the
writing-plans home convergence are now pre-decided by this resolution.
