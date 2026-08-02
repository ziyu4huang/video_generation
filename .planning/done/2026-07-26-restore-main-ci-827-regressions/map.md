# Wayfinder map: 2026-07-26-main-827-feat-subagent-unified-model-role-resolv

## Destination

`origin/main` is green again — the biome regressions #827 introduced in `pi-agent-ext-subagent` are resolved, and the FU-1 baseline typecheck error in `pi-agent-ext-core-task` (`auditor.ts:24` undeclared `@earendil-works/pi-ai`) is resolved — so CI passes and PRs can merge. The subagent-package migration and the orphan-WIP reconciliation are **not** part of this destination.

## Notes

- **Domain:** pi-agent monorepo CI hygiene (biome + tsc gates across `bun-apps/*`). Two packages in scope: `pi-agent-ext-subagent` (#827 regressions) and `pi-agent-ext-core-task` (FU-1).
- **Skills every session should consult:** `grilling` + `domain-modeling` — both tickets turn on a small design call, not bulk implementation.
- **Don't do the work in this worktree.** `video_generation__core_task` sits on `chore/wayfind-core-task-list-loop`, which orphans once #820's line lands and the branch is deleted. Branch the fix off `origin/main` from the `video_generation` (main) worktree.
- **Convention (load-bearing for FU-1):** `pi-agent-ext-core-task` deliberately avoids a `@earendil-works/pi-ai` runtime dep (Bun isolated-linker). `overflow.ts` ("Inlined to avoid a Bun-isolated-linker dependency on pi-ai"), `goal.ts`, and `todo/tool/types.ts` all inline/recreate the needed pi-ai types locally. `auditor.ts` is the lone holdout still importing `Model` from pi-ai — that *is* the FU-1 baseline error. Fix by following the precedent (inline), not by adding the dep.
- **Fact base (verified, then corrected):** ⚠️ FACT-FRESHNESS CORRECTION — at charting time `origin/main` appeared red at #827 (`b97e8975`); by the time work began, main had advanced to `a3f3e58c` (#828) and CI was **green**: #829 (`f7091230`) fixed the one *blocking* #827 error (`model-role-config.ts` formatter) — #829 is the merged form of branch `fix/subagent-model-role-lint` (`59a3f2f3`). The other two #827 diagnostics (`subagents-command.ts:27` unused `<T>`, `tests/model-role-config.test.ts:31` `cfg!`) are **non-blocking biome warnings** (`bun run check` exits 0). Lesson: the "main red, blocks all PRs" premise was stale; origin/main moved under the charting session.

## Decisions so far

- [Resolve the #827 subagent biome regressions](tickets/00-resolve-827-subagent-biome-regressions.md) — **resolved upstream**: main was already green (#829 `f7091230` fixed the blocking formatter error); residual `<T>`/`cfg!` are non-blocking warnings, left for the subagent-migration owner.
- [Resolve FU-1 — auditor.ts pi-ai import](tickets/01-resolve-fu1-auditor-pi-ai-import.md) — **fixed** (`84ed1980` on `fix/main-green-827-fu1`): derived `AuditorModel` from `createAgentSession`; tsc clean, 227 tests pass.

## Not yet specified

<!-- The residual decisions are sharp enough to ticket (see tickets/). If resolving ticket 00's `<T>` shows the generic is consumed at more call sites than the one currently known (ui.custom's `custom: <T>(f: SubagentsViewerFactory<T>) => Promise<T>`), a follow-up cleanup may graduate here. -->

## Out of scope

- **Subagent-package migration** — `feat/extract-subagent-package`, `.planning/2026-07-24-extract-subagent-package`, `refactor/subagents-tui-to-subagent-ext`, etc. A separate, already-tracked effort with its own owner. This map does not own it. (Note: `feat/extract-subagent-package` is 21 commits behind main and does *not* move `subagents-command.ts` — it is not the file-move its name implies.)
- **Orphan-WIP reconciliation** — the untracked `pi-agent-ext-workflow/src/{subagents-command,subagent-viewer,subagent-progress-widget}.ts` (+ tests) loose in the `video_generation__core_task` worktree. They are on **no branch** and will be lost when this worktree orphans post-#820. Real risk, but it belongs to the migration effort / a separate hygiene effort, not "main green." **PRESERVED 2026-07-26:** the 7 files were copied onto branch `wip/preserve-subagent-workflow-files-pre-orphan` (commit `ee0a9d2d`, off `origin/main`, 1289 lines, all clean additions); originals in `core_task` untouched. Migration owner: `git diff main...wip/preserve-subagent-workflow-files-pre-orphan`.
- **Loop 3 / drafting / `/list` reorder** — explicitly deferred by the user ("fog, future map").
