# 02 — Sharpen the two wayfind skill descriptions (discriminator + entry-path)

---
type: task
status: closed
---

## Question

Express the boundary rules at the **skill-discovery layer**: sharpen the two
this-repo-owned wayfind skill `description` frontmatters so triggers stop
colliding, and fix `to-spec`'s body claim that was never true.

## What to build

Two edits in `bun-apps/pi-agent-ext-wayfind/skills/`:

1. **`to-spec/SKILL.md`** —
   - `description`: add that it's for use **only after** a decide-phase
     (`grilling`/`wayfinder`) has settled the decisions — synthesis, not
     exploration. (Counterpart: `brainstorming` is the pre-decide exploration
     entry.)
   - **body**: the line claiming "this is the same `spec.md` superpowers'
     brainstorming writes" is false (brainstorming writes
     `docs/superpowers/specs/`). Replace with: both converge on
     `.planning/<effort>/spec.md` via the bootstrap path-override (ticket 01),
     but they are separate entry paths, not a shared artifact.

2. **`wayfinder/SKILL.md`** — `description`: make **fog (plan-writability)**
   the explicit primary discriminator ("can I write a plan now?"), with size as
   the secondary threshold picking `grilling` (small) vs `wayfinder` (huge /
   multi-session). Currently it bundles "huge AND foggy" without signaling that
   huge-but-clear is `writing-plans` territory.

Do NOT touch `brainstorming`/`writing-plans` (upstream-verbatim, ADR-0004) —
the deferral note for those lives in the bootstrap (ticket 01).

## Acceptance

- [ ] `to-spec` `description` states the post-decide-only trigger
- [ ] `to-spec` body no longer claims a shared spec.md; points to the bootstrap
      path-override as the convergence mechanism
- [ ] `wayfinder` `description` states the fog/plan-writability discriminator
      + the size sub-threshold
- [ ] No edit to any superpowers `skills/` file (verbatim preserved)
