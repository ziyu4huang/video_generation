## Destination

Finish the tool-gating rollout: migrate the owner-declared `gating` field to every still-hardcoded extension, harden the multi-name fail-open trap, stand up a drift-guard + QA-harness regression net, fix the telemetry undercount, and finally **delete the hardcoded `GATES`/`CORE_TOOLS` fallback entirely** — so gating is owner-declared end to end with no legacy fallback.

## Notes

- **Domain**: pi-agent tool-gating. Owner package: `bun-apps/pi-agent-ext-tool-gate/` (`extensions/tool-gate.ts`). Architecture: `buildEffectiveGates()` hybrid-merges owner-declared `gating` (discovered via the existing `pi.getAllToolDefinitions()` patch) with the hardcoded fallback; `filterActive`/`updateSticky` are parameterized on the effective gates; `drift-guard.test.ts` + `schema-cost-agreement.test.ts` are the contract.
- **Skills every session should consult**: `grilling` + `domain-modeling` for decision tickets; the tool-gate test suite is the source of truth.
- **Standing preferences (from the migration)**: backward-compatible parameterization; no extension↔extension dependency; no new runtime patch (reuse the existing `getAllToolDefinitions` patch); TDD.
- **Fact freshness**: this branch is ~9 commits behind `origin/main`. Rebase before integration; the migration commits live on this branch, so the architecture facts are branch-accurate.

## Decisions so far

- **Migration complete & ready to merge** — owner-declared gating on 10 pilot tools (power-tool `inspect_*`, core-task `ask_user_question`/`todo`/`goal_complete`, tool-gate `enable_tool`); `buildEffectiveGates()` hybrid merge (zero regression for unmigrated); drift-guard scoped to 3 pilots; schema-cost agreement test. 9 commits `bb711e39..e0bb8559`, 1382 tests / 0 fail. (Detail: `../2026-08-02-taxonomy-gating-field-migration/`; full recap: `recall.md`.)
- **Rollout sequencing = incremental** — one task ticket per extension, each blocked by a drift-guard expansion that catches regressions (decided in charting).
- **Harden the fail-open trap before rollout** — the multi-name-gate resolution is ticket #1 and blocks all rollout; no fail-open window (decided in charting).
- [01 — Multi-name-gate hardening](tickets/01-multi-name-gate-hardening.md) — per-name resolution: partition each fallback gate's names, keep the gate for undeclared siblings; zero fail-open window during incremental rollout.
- [02 — Drift-guard rollout net](tickets/02-drift-guard-rollout-net.md) — migrated set parameterized as an extensible source; dead-gate rejection (#8) and augmentation-agreement test (#9) folded in. Rollout tickets append here.

## Not yet specified

- **Per-extension gating semantics** for each unmigrated extension (keywords, `requires`, single- vs multi-name) — graduates as each rollout ticket is scoped from the extension's current hardcoded `GATES` entry.
- **Minor hardening folds** — dead-gate `requires:{}` rejection and the augmentation-agreement test are folded into the drift-guard net (ticket 02) rather than standalone tickets.
- **Richer gating schema?** — rollout may surface a need for OR/AND keyword groups, negation, or priority. Graduates a schema-evolution ticket only if a real need appears.

## Out of scope

- **Upstream `gating` into `@earendil-works/pi-coding-agent`** (FOLLOWUPS #5) — the migration proved the per-pilot type augmentation suffices; upstreaming is a separate future effort, not part of finishing the rollout.
- **Residual `@deprecated delegate` sweep** (FOLLOWUPS #7) — internal cleanup of VALUE delegates (`estimateToolCost`/`checkToolContract`); not gating correctness.
