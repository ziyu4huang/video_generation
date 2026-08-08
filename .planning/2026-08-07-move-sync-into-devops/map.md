---
effort: 2026-08-07-move-sync-into-devops
status: complete
---
## Destination

A `sync_repo` pi tool in `bun-apps/pi-agent-ext-devops` (TypeScript, orchestrating git via `Bun.spawn`/`BranchClient`, tested through the spawn seam) that fully replaces the three repo-sync shell scripts — `scripts/sync-repo.sh`, `scripts/git-remote-main-sync.sh`, `scripts/safe-sync.sh`. The scripts are deleted; sync is agent-invoked only (no CLI/shell entry point). Reaching the end means: one canonical, tested, TS sync capability in the devops extension, zero redundant bash, and every former consumer updated.

## Notes

- Domain: `bun-apps/pi-agent-ext-devops` (TS extension; tools registered in `extensions/devops.ts`; git/gh via `Bun.spawn` + `SpawnFn` seam in `src/spawn.ts`; `GhClient`/`BranchClient` in `src/gh.ts`). Existing tools: `await_pr_merge`, `pr_status`, `sweep_branches`, `local_ci`.
- Convention: implement sync orchestration in TS calling git primitives (NOT "avoid git"). Match how `await_pr_merge`/`local_ci` work.
- Parity bar: the TS tool must reproduce the full behavior of the 3 scripts (worktree-aware default-branch advancement via `origin/HEAD`, `--full` submodules, `--pull`/`--rebase`/`--dry-run`, unpushed-commit warnings, alignment verification), MINUS any flag/feature ticket 01 proves unused. Full replacement — removing bash must lose no capability actually in use.
- Repo SOP: PR per change, local CI (`await_pr_merge`/`local_ci`), squash-merge with `gh ship`, never wait for remote CI. (Per `docs/agents/learnings.md` `[convention]`.)
- Sync the worktree to latest `origin/main` before any code ticket (it was 1 behind at chart time).

## Decisions so far

- [01 — Map script consumers](tickets/01-map-script-consumers.md) — closed: zero code consumers; `safe-sync` not sourced anywhere; removal safe; TS port keeps `--full`/`--pull`/`--rebase`/`--dry-run`, drops unused flags.
- [02 — Implement sync_repo tool](tickets/02-implement-sync-repo-tool.md) — closed: PR [#1066](https://github.com/ziyu4huang/video_generation/pull/1066) merged (`17dee15f`); `sync_repo` TS tool in pi-agent-ext-devops, 6 files, spawn-seam tested, 119 tests pass.
- 02.1 (emerged mid-flight) — closed: PR [#1069](https://github.com/ziyu4huang/video_generation/pull/1069) merged (`798936c4`); hardened full-mode to `merge --ff-only` + abort-on-divergent (never loses commits); `reset --hard` only via `force: true`; 121 tests pass.
- [03 — Remove bash scripts + update consumers](tickets/03-remove-bash-scripts-update-consumers.md) — closed: PR [#1070](https://github.com/ziyu4huang/video_generation/pull/1070) merged (`61321205`); deleted 3 scripts + bash test; `learnings.md` convention rows → `sync_repo` modes; commitScope tool-quirk entry sharpened.

## Not yet specified

(none — ticket 01 graduated the flag-surface and unused-flag questions into tickets 02 and 03)

## Out of scope

- Re-architecting the other devops tools (`await_pr_merge`/`pr_status`/`sweep_branches`/`local_ci`) — untouched.
- A CLI subcommand for sync — user chose agent-invoked only.
- Memory store / non-sync scripts under `scripts/` — untouched.

## Resolution

**Destination reached (2026-08-07).** Sync capability moved into `bun-apps/pi-agent-ext-devops` as the `sync_repo` TS tool (Bun.spawn/BranchClient, spawn-seam tested), faithful to the existing `await_pr_merge`/`local_ci` pattern. The three bash scripts + their bash test are deleted; `docs/agents/learnings.md` points at the new tool. Net: one canonical, tested, agent-invoked sync capability; zero redundant bash; safety parity with the old `pull --ff-only` (hardened in 02.1 before the fallback was removed in 03). Answer to the original question — "does moving into devops mean TS/bun?" — is empirically yes.
