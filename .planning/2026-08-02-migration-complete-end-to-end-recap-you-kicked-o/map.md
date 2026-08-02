## Destination

Finish the tool-gating rollout: migrate the owner-declared `gating` field to every still-hardcoded extension, harden the multi-name fail-open trap, stand up a drift-guard + QA-harness regression net, fix the telemetry undercount, and finally **delete the hardcoded `GATES`/`CORE_TOOLS` fallback entirely** — so gating is owner-declared end to end with no legacy fallback.

## Notes

- **Domain**: pi-agent tool-gating. Owner package: `bun-apps/pi-agent-ext-tool-gate/` (`extensions/tool-gate.ts`). Architecture: `buildEffectiveGates()` hybrid-merges owner-declared `gating` (discovered via the existing `pi.getAllToolDefinitions()` patch) with the hardcoded fallback; `filterActive`/`updateSticky` are parameterized on the effective gates; `drift-guard.test.ts` + `schema-cost-agreement.test.ts` are the contract.
- **Skills every session should consult**: `grilling` + `domain-modeling` for decision tickets; the tool-gate test suite is the source of truth.
- **Standing preferences (from the migration)**: backward-compatible parameterization; no extension↔extension dependency; no new runtime patch (reuse the existing `getAllToolDefinitions` patch); TDD.
- **Fact freshness**: this branch is ~9 commits behind `origin/main`. Rebase before integration; the migration commits live on this branch, so the architecture facts are branch-accurate.
- **Rebasing this worktree:** the branch lives in a git WORKTREE (of `video_generation`), so a stale rebase state dir sits at `<main-repo>/.git/worktrees/<worktree-name>/rebase-merge` — NOT `.git/rebase-merge` inside the worktree (there `.git` is a file, so that check is a false negative). A stale dir blocks `git rebase` ("It seems there is already a rebase-merge directory"); clear with `git rebase --quit` (NOT `--abort` — `--abort` resets to the recorded `ORIG_HEAD` and can discard commits if it's stale). A dirty tracked file also blocks rebase — `git stash push -- <file>`, rebase, `git stash pop` (untracked files don't block).

## Decisions so far

- **Migration complete & ready to merge** — owner-declared gating on 10 pilot tools (power-tool `inspect_*`, core-task `ask_user_question`/`todo`/`goal_complete`, tool-gate `enable_tool`); `buildEffectiveGates()` hybrid merge (zero regression for unmigrated); drift-guard scoped to 3 pilots; schema-cost agreement test. 9 commits `bb711e39..e0bb8559`, 1382 tests / 0 fail. (Detail: `../2026-08-02-taxonomy-gating-field-migration/`; full recap: `recall.md`.)
- **Rollout sequencing = incremental** — one task ticket per extension, each blocked by a drift-guard expansion that catches regressions (decided in charting).
- **Harden the fail-open trap before rollout** — the multi-name-gate resolution is ticket #1 and blocks all rollout; no fail-open window (decided in charting).
- [01 — Multi-name-gate hardening](tickets/01-multi-name-gate-hardening.md) — per-name resolution: partition each fallback gate's names, keep the gate for undeclared siblings; zero fail-open window during incremental rollout.
- [02 — Drift-guard rollout net](tickets/02-drift-guard-rollout-net.md) — migrated set parameterized as an extensible source; dead-gate rejection (#8) and augmentation-agreement test (#9) folded in. Rollout tickets append here.
- [03 — Rollout: deploy](tickets/03-rollout-deploy.md) — owner-declared gating on pi_deploy/pi_verify; removed from GATES; deploy in the drift-guard net. (Also: taught `qa/evaluate.ts` to reconstruct migrated gates from owner-declared gating so the L1 probe corpus stays live post-migration — scales to 04–12 with no probe edits.)
- [04 rollout file2md](tickets/04-rollout-file2md.md) — file2md+vision_ask owner-declare gating; hardcoded GATES entry removed; drift-guard migrated; tests green

## Not yet specified

- **Per-extension gating semantics** for each unmigrated extension (keywords, `requires`, single- vs multi-name) — graduates as each rollout ticket is scoped from the extension's current hardcoded `GATES` entry.
- **Minor hardening folds** — dead-gate `requires:{}` rejection and the augmentation-agreement test are folded into the drift-guard net (ticket 02) rather than standalone tickets.
- **Richer gating schema?** — rollout may surface a need for OR/AND keyword groups, negation, or priority. Graduates a schema-evolution ticket only if a real need appears.
- **enable_tool sibling co-activation under per-tool owner-declared gating** — migrating a multi-name gate (e.g. deploy's `pi_deploy`/`pi_verify`, workflow's group) splits it into single-name gates. Keyword/`requires` firing still co-activates siblings (identical predicates), but `enable_tool({name:X})` no longer co-activates its former siblings (the old shared gate did). No assertion covers it; latent across all multi-name rollouts. Revisit only if the escape-hatch UX matters — would need a grouping mechanism in owner-declared gating (a schema change = new effort).

## Out of scope

- **Upstream `gating` into `@earendil-works/pi-coding-agent`** (FOLLOWUPS #5) — the migration proved the per-pilot type augmentation suffices; upstreaming is a separate future effort, not part of finishing the rollout.
- **Residual `@deprecated delegate` sweep** (FOLLOWUPS #7) — internal cleanup of VALUE delegates (`estimateToolCost`/`checkToolContract`); not gating correctness.
