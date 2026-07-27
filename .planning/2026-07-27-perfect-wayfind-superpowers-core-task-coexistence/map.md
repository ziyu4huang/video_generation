## Destination

A state where `pi-agent-ext-wayfind`, `pi-agent-ext-superpowers`, and the adjacent `pi-agent-ext-core-task` coexist as **parallel, non-connecting pipelines** (per superpowers ADR-0005) but every seam is seamless: no unpushed reversal lingering, no unguarded cross-extension contract that silently drifts, no shared-state collision surface left unaddressed. The destination is *decisions* (how to formalize each seam) plus one concrete ship (the unpushed ADR-0004), not new features.

## Notes

- **Domain**: the three-package coexistence contract. Skills every session should consult: `grilling` + `domain-modeling` (wayfind) for the decision tickets.
- **Key ADRs already decided** (do not re-litigate):
  - superpowers ADR-0005 — parallel non-connecting pipelines; divergence expressed at the injection layer, never inside pinned upstream skill bodies.
  - superpowers ADR-0006 — superpowers↔subagent is instructional-only, no code import.
  - wayfind ADR-0004 — status widget read via `globalThis`, no core-task build dep (reverses ADR-0002 Decision 1).
- **The seam surface is globalThis-based by necessity** — jiti loading means module identity isn't guaranteed across extensions, so cross-extension singletons MUST live on `globalThis`. Any formalization must respect this constraint (existence-checked, never `instanceof`).
- **Fork is settled**: perfect the coexistence, NOT reconnect the pipelines (ADR-0005 holds).
- This map is **planning** — each ticket resolves a decision or ships one prerequisite; it does not deliver the destination itself.

## Decisions so far

<!-- charting resolves nothing; filled as tickets close -->

- [Ship the unpushed wayfind ADR-0004 reversal](tickets/01-ship-unpushed-wayfind-adr-0004.md) — PR #895 merged (`6af421b5`); wayfind drops its core-task build dep, reads the status widget via `globalThis`. The seam 02 builds on is now the landed state.
- [Formalize the status-widget cross-extension contract](tickets/02-formalize-status-widget-contract.md) — repo-level source-analysis guard (`bun-apps/tests/seam-contract.test.ts`, run via `test:seam` in `regression gates`) turns the 3-site key + shape drift loud. Template for ticket 03’s full `__pi*` sweep; **resolves fog #1** (no shared module — a guard, not a package).

## Not yet specified

- ~~**Shared contract module vs inline tests.**~~ **RESOLVED by ticket 02** — neither: a repo-level source-analysis guard (`bun-apps/tests/seam-contract.test.ts`), no shared module, no inline-per-package tests. See Decisions so far.
- **Scope of superpowers' coexistence awareness.** superpowers is currently zero-globals, purely instructional. If the seam formalization (03) makes the `__pi*` surface a published contract, there's an open question of whether superpowers should gain *any* awareness of it (today it has none). Depends on 03.

## Out of scope

- **Reconnecting the pipelines** (challenging ADR-0005's "never meet") — ruled out by the destination fork (perfect coexistence, not merge). Resurface only if a later effort redraws the destination.
- **Upstream fidelity catch-up** (porting new Primer Radiant / Matt Pocock versions) — a different destination; this map is about the *seams between* the local ports, not their freshness vs upstream.
- **Tool-schema cost reduction** — both packages register zero LLM-facing tools; already lean on that axis.
