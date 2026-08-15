## Question

What is the scope of this map — which loop(s) does it chart?

## type: grilling

## Resolution

**Loop 2 (`/list` queue) only.** Loop 3 (metric-driven forever-loop) is deferred to fog (Not yet specified) — it graduates after Loop 2 lands, mirroring the reference's v0.2→v0.3 sequencing. Standing-architecture (superpowers-status / vault-root / inspect / deploy-binary) is out of scope entirely — a separate map.

**Rationale:** the reference proved loops 1+2 consolidate into ONE state machine (DESIGN.md Decision 7), so Loop 2 is the natural, lower-risk next step that reuses the hardened single-goal machine #814+#818 just delivered. Loop 3 is a different beast (metric-driven, no auditor, optional branch mode) — bundling it would couple unrelated decisions and bloat the map. Feasibility is already established (reference shipped it), so this map designs the *adaptation* of Loop 2 to core-task's constraints, not raw feasibility.

**Closed:** 2026-07-25.
