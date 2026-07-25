## Question

The fork's SDD workspace is **effort-scoped** (`.planning/<effort>/sdd/`, from the W2c patch); upstream's rework is **plan-scoped** (`.superpowers/sdd/<plan-slug>/`). These are different identity axes. How do they compose?

Candidates:
- **(a) nest** — `.planning/<effort>/sdd/<plan-slug>/` (effort ⊃ plan); preserves both identities; an effort can carry multiple plans without collision.
- **(b) replace** — drop the effort-axis, use plan-axis only (`.planning/<plan-slug>/sdd/`?); loses the effort grouping.
- **(c) keep effort-only** — ignore upstream's plan-scoping; risks intra-effort cross-plan collision (the very bug upstream fixed).

**Recommended: (a) nest.** An effort legitimately spans multiple plans (the brainstorm→plan→execute flow produces one effort with N plans), so the plan-axis adds real identity the effort-axis lacks. Nesting preserves the convergence invariant (everything under `.planning/<effort>/`) while gaining per-plan isolation.

**type:** grilling (HITL)
**claimed:** _(open)_
**blocked by:** — (informed by 02)
