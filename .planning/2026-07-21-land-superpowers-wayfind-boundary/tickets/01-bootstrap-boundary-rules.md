# 01 — Bootstrap carries the boundary rules (path-override + routing)

---
type: task
status: closed
---

## Question

Land the superpowers ↔ wayfind boundary at the **injection layer**: make the
`using-superpowers` bootstrap the single runtime place where (a) artifact-home
convergence and (b) the entry-path routing rule are expressed — without forking
any upstream-verbatim skill body (ADR-0004).

## What to build

Edit `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` — extend the
bootstrap payload assembled by `getBootstrapContent()` (the existing
`piToolMapping()` section is the model) with a new **"## Path & routing
overrides"** block carrying two rules the agent follows at runtime:

1. **Path override** — when a Superpowers skill says to write a spec to
   `docs/superpowers/specs/`, write it to `.planning/<effort>/spec.md` instead;
   when it says `docs/superpowers/plans/`, write to
   `.planning/<effort>/plan.md`. (This converges the homes the wayfind family
   already uses — the convergence `unified-planning-dir.patch` tried to do by
   forking verbatim bodies; doing it here respects ADR-0004.)
2. **Routing / deferral** — the discriminator is *"can I write a plan now from
   what's settled?"*: yes → `brainstorming`→`writing-plans` (superpowers
   pipeline); no → `grilling`/`wayfinder` (wayfind pipeline). And when a wayfind
   decide-phase has already run, `brainstorming` defers to `to-spec` (don't
   re-explore what grilling settled).

The skill bodies (`brainstorming`/`writing-plans`) stay byte-identical to
upstream. The `_resetBootstrapCacheForTests()` escape hatch already exists for
test freshness.

## Acceptance

- [ ] `getBootstrapContent()` output contains both the path-override rule and
      the routing/deferral rule (add an assertion to the existing
      `tests/bootstrap.test.ts` pattern)
- [ ] No edit to any file under `skills/` (the 14 SKILL.md stay verbatim)
- [ ] `bun run check` + `bun test` green; `tests/skills-fidelity.test.ts` still
      15/15 pass (the convergence did NOT touch verbatim bodies)
- [ ] `cachedBootstrap` is invalidated correctly across the change
