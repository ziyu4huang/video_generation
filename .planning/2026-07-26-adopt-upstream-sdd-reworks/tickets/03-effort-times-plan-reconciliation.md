## Question

The fork's SDD workspace is **effort-scoped** (`.planning/<effort>/sdd/`, from the W2c patch); upstream's rework is **plan-scoped** (`.superpowers/sdd/<plan-slug>/`). These are different identity axes. How do they compose?

Candidates:
- **(a) nest** — `.planning/<effort>/sdd/<plan-slug>/` (effort ⊃ plan); preserves both identities; an effort can carry multiple plans without collision.
- **(b) replace** — drop the effort-axis, use plan-axis only (`.planning/<plan-slug>/sdd/`?); loses the effort grouping.
- **(c) keep effort-only** — ignore upstream's plan-scoping; risks intra-effort cross-plan collision (the very bug upstream fixed).

**Recommended: (a) nest.** An effort legitimately spans multiple plans (the brainstorm→plan→execute flow produces one effort with N plans), so the plan-axis adds real identity the effort-axis lacks. Nesting preserves the convergence invariant (everything under `.planning/<effort>/`) while gaining per-plan isolation.

**type:** grilling (HITL)
**claimed:** agent-session (2026-07-26)
**blocked by:** — (informed by 02)

## Resolution (2026-07-26)

**Decision: (a) Nest** — `.planning/<effort>/sdd/<plan-slug>/` (effort ⊃ plan). Confirmed by the user.

**Rationale:** an effort legitimately spans multiple plans (brainstorm→plan→execute produces one effort with N plans), so the plan-axis adds real identity the effort-axis lacks. Nesting preserves the convergence invariant (everything under `.planning/<effort>/`) while gaining per-plan isolation.

**Feeds ticket 06:** `sdd-workspace` takes `PLAN_FILE` (upstream interface) AND reads `PI_PLANNING_EFFORT` → resolves `.planning/<effort>/sdd/<plan-slug>/`. `<plan-slug>` = plan filename basename (upstream's convention). Routing rule 1 + `bootstrap.test.ts` path expectations update for the plan-slug dimension.

**Fog graduated:** the "existing-state migration" fog resolves **forward-only** — existing single-plan efforts need no migration (the plan-slug is simply their one plan's basename). Folded into 06's acceptance.

**status:** closed
