**ID:** `ADR-superpowers-0005` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# The superpowers ↔ wayfind boundary is parallel coexistence, expressed at the injection layer

Superpowers and Wayfind are two **parallel, non-connecting pipelines** that share
the `.planning/<effort>/` layout but do not share a flow:

- **Wayfind** (decide-phase): `grilling`/`wayfinder` → `to-spec` → `to-tickets`
  → `/wayfind seed` → `task_plan.md` → the `core-task` goal coordinator.
- **Superpowers** (plan/execute-phase): `brainstorming` → `writing-plans` →
  `subagent-driven-development`.

They never meet: `to-tickets`' next stop is `/wayfind seed` (the coordinator),
not `writing-plans`; `brainstorming`'s next stop is `writing-plans`. A prior
version of the docs described a single linear chain (wayfind → superpowers) and
claimed `to-spec` and `brainstorming` write "the same `spec.md`" — both were
aspirational, never true (`to-spec` writes `.planning/<effort>/spec.md`;
`brainstorming` writes the upstream `docs/superpowers/specs/`).

The **discriminator** for which pipeline to enter is plan-writability — *can I
write a plan right now from what's already settled?* Yes (spec in hand) →
Superpowers; no (decisions open) → Wayfind (`wayfinder` if huge/multi-session,
else `grilling`). Size is a secondary threshold within the Wayfind branch only.

The **decomposition skills cannot merge**: `to-tickets` ↔ `core-task`
coordinator and `writing-plans` ↔ `subagent-driven-development` are coupled
decomposition+execution stacks — each skill's output shape is dictated by its
executor's contract. Merging would require unifying the execution models.

**Where the boundary is expressed.** Upstream-ported Superpowers skills stay
byte-identical to upstream (ADR-0004). All local divergence — artifact-home
convergence (`docs/superpowers/{specs,plans}/` → `.planning/<effort>/`) and
entry-path routing (the plan-writability discriminator + the
`brainstorming`-defers-to-`to-spec` rule) — lives in the **`using-superpowers`
bootstrap** (`src/superpowers.ts` `piBoundaryOverrides()`), injected at runtime.
This respects ADR-0004: the prior attempt to converge homes by patching verbatim
skill bodies (the now-removed `migrations/unified-planning-dir.patch`) was never
applied because it would re-inject exactly the repo conventions commit `4fc140be`
reverted and ADR-0004 guards against. That patch, its `scripts/apply-patches.sh`
applier, and the call that invoked it from `scripts/update-superpowers.sh` were
removed (ticket 04, `.planning/2026-08-04-improve-superpowers-wayfind`), leaving
the boundary-layer approach as the sole sanctioned divergence point. Local
differences belong at the boundary layer, never inside pinned upstream assets.

Related: ADR-0004 (skill fidelity positive pin) — this ADR's "express divergence
at the injection layer" is the operating consequence of ADR-0004's "don't fork
verbatim bodies". See
`.planning/2026-07-21-review-bun-apps-pi-agent-ext-superpowers-see-if-/tickets/02,03,04.md`
for the grilled boundary decisions, and
`.planning/2026-07-21-land-superpowers-wayfind-boundary/` for the execution that
landed it.

**Superseded clause:** the "when an effort is active" qualifier on the
no-upstream-path rule is removed by [ADR-0007](./0007-unconditional-artifact-home.md);
this ADR's disjoint-subpath layout is unchanged.
