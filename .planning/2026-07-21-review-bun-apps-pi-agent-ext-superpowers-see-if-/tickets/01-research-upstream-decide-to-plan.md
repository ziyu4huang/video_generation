# 01 — How does upstream obra/superpowers handle the decide→plan transition?

---
type: research
blocked by:
status: closed
---

## Question

The boundary collisions (tickets 02, 03) hang on one fact we don't yet have
sharp: **how does upstream `obra/superpowers` itself go from a fuzzy idea to an
executing plan?** Concretely:

- Does upstream have *anything* at a "decide" phase — an interview/spec/tickets
  step — or does it go straight from `brainstorming` into `writing-plans`?
- What artifact(s) does upstream use at each phase, and where do they live?
- Is `to-spec` / `to-tickets` / `grilling` purely *this repo's* addition (the
  Matt Pocock wayfind suite), with no upstream analogue?

This is research, not a decision: resolve it by reading the checked-out
`../superpowers/` (README, skills/, .pi/, hooks/, docs/) — the upstream is
local, so no web search needed. The finding feeds the spec-authorship (02) and
decomposition (03) tickets by establishing what upstream's "normal" path is, so
the boundary decision knows what it's diverging from.

## Resolution

**Upstream has a single linear pipeline with NO separate decide-phase.**
`brainstorming` IS the decide phase — it does the one-question-at-a-time
interview, proposes 2-3 approaches, presents the design in chunks, gets user
approval, and handles sub-project decomposition itself. Then `writing-plans`
turns the approved spec into a bite-sized TDD task plan, then execute. The
pipeline is strictly sequential with a hard gate ("The terminal state of
brainstorming is invoking writing-plans; do NOT invoke any other skill").

**`to-spec`, `to-tickets`, `grilling`, `wayfinder` are ALL purely this-repo's
wayfind additions** — no upstream analogue exists. Upstream folds decide +
spec + decomposition into `brainstorming` alone.

**HEADLINE FINDING — a stalled convergence.**
`migrations/unified-planning-dir.patch` was written to fork the superpowers
skills from upstream paths (`docs/superpowers/specs/`, `docs/superpowers/plans/`)
to the unified `.planning/<effort>/{spec,plan}.md` layout — the SAME home wayfind
uses. **But the patch is NOT currently applied.** The port skills still carry
the upstream paths (zero `.planning` references in `pi-agent-ext-superpowers/skills/`).
Consequence: `to-spec`'s claim that "this is the same `spec.md` superpowers'
brainstorming writes" is **currently false** — brainstorming writes to
`docs/superpowers/specs/`, to-spec writes to `.planning/<effort>/spec.md`.
Same divergence for writing-plans vs to-tickets. The unification migration
exists but hasn't converged — most likely an `update-superpowers.sh` re-sync
reverted the skills and `apply-patches.sh` was never re-run.

**Implication for the boundary tickets:** the collision is not merely
conceptual overlap — it's a *concrete artifact-home contradiction*, and the
mechanism to fix it (the patch) is half-built. Tickets 02 and 03 now carry this
finding.
