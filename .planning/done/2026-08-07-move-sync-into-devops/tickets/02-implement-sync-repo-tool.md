type: task
closed: 2026-08-07

## Question

Implement the `sync_repo` pi tool in `bun-apps/pi-agent-ext-devops` that fully replaces the three bash scripts (see map Destination + Notes for the parity bar).

Scope:
- New TS module (e.g. `src/sync-recipe.ts`) orchestrating git via `Bun.spawn`/`BranchClient`, mirroring how `recipe.ts`/`ci-recipe.ts` are structured.
- Reproduce the scripts' behavior: worktree-aware default-branch advancement (detect default via `origin/HEAD`; if the default branch is checked out in another worktree, advance there), `--full` submodule recursion, `--pull`/`--rebase`/`--dry-run` modes, unpushed-commit pre-flight warning, post-sync alignment verification.
- Register the tool in `extensions/devops.ts`.
- Tests via the `SpawnFn` seam (`src/spawn.ts`) — unit-test the orchestration with mocked git output (the bash scripts had zero tests; this is a net gain).
- Read the 3 bash scripts verbatim as the behavioral spec; drop only what ticket 01 proved unused.

Acceptance: tool registered, tests green (`bun test`), typecheck + `local_ci` green, and a real dry-run + real sync against this repo produces the same effect the bash did (worktree-aware, submodules aligned).

blocked by: (none — may run in parallel with 01; 01 only informs which flags to trim)

### Refined scope (from ticket 01)

- KEEP flags: `--full` (submodules), `--pull` (merge instead of ff), `--rebase` (rebase onto upstream), `--dry-run`, default-rebase mode. Internal: default-branch detection via `origin/HEAD`.
- DROP (no consumer, unless trivial to keep): `--remote`, `--branch`, `--no-submodules`, `--depth`, `--local`, `--merge`, `--base`.
- `scripts/sync-repo.test.ts` currently tests the bash default-branch detection — port its assertions to test the new TS module (don't leave a dangling test for a deleted script).

## Resolution

Closed 2026-08-07. PR [#1066](https://github.com/ziyu4huang/video_generation/pull/1066) merged (`17dee15f`): created `src/sync-recipe.ts` + `tests/sync-recipe.test.ts`; registered `sync_repo` in `extensions/devops.ts`; modified `src/gh.ts`/`src/branch-recipe.ts`; 6 files, +801, 119 tests pass. NOTE: PR #1066 shipped full-mode with `reset --hard` (discards commits) — flagged and then fixed by follow-up 02.1 (PR #1069) before the bash fallback was removed.
