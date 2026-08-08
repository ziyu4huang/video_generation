---
type: task
status: closed
---

# 06 — sweep_branches: check delete exit codes (stop reporting failed deletes as success)

## Finding (codebase review M2)

`gh.ts` `deleteLocalBranch`/`deleteRemoteBranch` discard the spawn exit code (`createLiveSpawn` never throws — returns {exitCode}). `branch-recipe.ts` `executeSweep` then unconditionally pushes the name into `deletedLocal`/`deletedRemote`. A non-zero exit (permissions, already-gone, server-side protection) is swallowed and the structured outcome reports success — i.e. it lies. Inconsistent with sibling gh methods (`mergeNow`, `rebaseAndForcePush`) which check exit + throw. No test simulates a failing delete (the fakes' deletions are no-ops).

## Acceptance

- `deleteLocalBranch`/`deleteRemoteBranch` (gh.ts) check exit code and throw on non-zero (match the sibling methods' pattern).
- `executeSweep` (branch-recipe.ts) catches delete failures and routes them to a `skipped[]` (with reason) instead of `deleted*`.
- Add a regression test: a delete returning exit!=0 -> branch lands in `skipped` with reason, NOT in `deleted*`.
- Structured outcome is truthful: `deleted*` contains only branches actually deleted.

## Resolution — FIXED in #1055
deleteLocalBranch/deleteRemoteBranch (gh.ts) now check exit code and throw on non-zero (mirroring mergeNow). executeSweep (branch-recipe.ts) wraps each delete in try/catch → routes failures to skipped[] with a reason. deleted* now contains only branches actually deleted. Tests: gh.ts throw-on-non-zero (local+remote); branch-recipe failed-local-delete→skipped, failed-remote-delete→skipped.
