---
name: devops-workflow
description: Use when doing branch / rebase / PR / merge / verify work on this repo — prepare a branch, self-verify with local CI, squash-merge a PR, verify the merge's file scope, or run an advisory post-run retrospective. Routes the canonical devops tool chain and forbids the raw-bash git fallback that caused scope-verification false-positives, worktree-blocked checkouts, and un-verified merges in past runs.
---

# DevOps Workflow

The canonical branch → CI → merge → verify → reflect lifecycle is owned by the
**devops tools**. When you touch git in any of these phases, call the tools **in
order** and **do NOT fall back to raw bash `git` / `gh`** for the parts they own.

## Why tools, not raw bash

Past runs that reached for raw bash git produced three recurring failure modes —
all of which the devops tools exist to prevent:

- **Scope-verification false-positives.** Hand-rolled `git show --stat` /
  `git diff --name-only` parsing mis-split binary lines / summary lines and
  reported CLEAN where the merge had actually drifted out of scope.
  `verify_merge` owns a tested `parseShowStat` + an explicit CLEAN/CONTAMINATED
  verdict, so the verdict is never a hunch.
- **Worktree-blocked checkouts.** A bare `git checkout -b` fatals when the
  branch is already checked out in another worktree. `prepare_branch` guards
  against this **before** any mutation and aborts cleanly (`worktree-conflict`).
- **Un-verified merges.** `gh pr merge` with no local gate merged PRs whose
  typecheck/tests were actually red. `await_pr_merge` gates the squash-merge on a
  real local-CI run first.

Every tool is **throw-free** (every refusal surfaces as a structured
`aborted`/`warnings` + `summary`, never a thrown exception), records the exact
git invocations in `commands[]`, and honors `dryRun` (compute + show the plan,
spawn zero mutations). Use `dryRun: true` to preview before mutating.

## The chain (run in order)

### 1. `prepare_branch` — worktree-safe branch setup

Create a branch off the base, rebase it onto the base, and/or force-push-with-
lease. This is what covers the **BEHIND** state that `await_pr_merge` blocks on:
when a PR is BEHIND, run `prepare_branch` with `rebase: true` (and
`forcePush: true` once the rebase is clean) to bring it forward, then re-attempt
the merge.

- Aborts `worktree-conflict` (branch checked out elsewhere) **before** mutating.
- Aborts `rebase-conflict` (runs `git rebase --abort` first, recorded) so you
  never land mid-rebase.
- `forcePush` defaults to **false** — it never force-pushes by accident; opt in
  explicitly with `--force-with-lease`.
- Prefer `dryRun: true` first to see the exact commands.

### 2. `local_ci` — self-verify (the local proxy for remote CI)

Run typecheck + tests scoped to the packages changed vs `origin/main`, plus the
repo's quality gates (file-size guard, lockfile-duplicate guard; strict adds the
audit gates). **Offline** — a green run is the local proxy for a green remote
run (remote CI is intentionally disabled in this repo). This is what
`await_pr_merge` gates on; run it standalone to self-verify before merge.

### 3. `await_pr_merge` — local-CI-gated squash-merge

Runs `local_ci` over the PR's changed packages vs its base, then squash-merges
when green **and** the PR is CLEAN/mergeable. Blocks (no merge) on red CI,
detection error, BEHIND, or a non-CLEAN mergeState. No remote CI, no polling.
When it reports BEHIND, go back to step 1 (`prepare_branch`).

### 4. `verify_merge` — confirm scope + main advanced + branch spent

After the merge: confirm the PR actually merged, inspect the merge commit's real
file scope against an optional `expectedScope` (verdict CLEAN vs CONTAMINATED),
and whether the feature branch is now **spent** (fully contained in the default
branch). Pass the same `expectedScope` you intended the work to touch — a
CONTAMINATED verdict means the merge pulled in out-of-scope paths. Replaces
manual `git show --stat` / `git branch --merged` verification.

### 5. `devops_retrospect` — advisory anomaly review

A read-only, **never-blocking** retrospective after a mutating recipe: scans the
recent reflog + branch/worktree/divergence state and flags anomalies — a
force-push / history-rewrite signature, scope drift (recent commits touched
paths outside `expectedScope`), a branch checked out in >1 worktree, a dirty
tree, or an unexpected ahead+behind / far-behind divergence. Run it last for a
"did anything look risky?" readout; its findings are advisory, never a gate.

## When to use which tool

| Situation | Tool |
| --- | --- |
| Need to create / rebase / force-push a branch (esp. to clear BEHIND) | `prepare_branch` |
| Self-verify typecheck + tests before merge | `local_ci` |
| Merge a PR (gated on local CI + mergeable) | `await_pr_merge` |
| Confirm a merge's scope + that the branch is spent | `verify_merge` |
| Post-run "anything risky?" anomaly readout | `devops_retrospect` |
| One-shot PR state + check tally (inspect, don't merge) | `pr_status` |
| Sync this repo/worktree to the latest default branch | `sync_repo` |
| Classify + clean up merged local/remote branches | `sweep_branches` |
| Build + deploy the pi-agent bundle + thin ext bundles (mirrors `scripts/deploy.ts`) | `pi_deploy` |
| Run a pi-agent `run-test.sh` tier (quick/medium/high/readonly/full) to self-verify | `pi_verify` |

### `sync_repo` — auto-managed hot files are preserved, not aborted

`sync_repo` advances the default branch (full mode), or rebases/merges the
current branch. By DEFAULT its dirty-tree gate would refuse the most common sync
— hermes writes `.agents/memory/MEMORY.md` in ~every worktree, leaving a dirty
tracked tree. So the gate now **preserves** auto-managed hot files: the default
preserve list is `['.agents/memory/MEMORY.md']`, stashed before the advance and
restored after (never lost). All OTHER uncommitted tracked work STILL aborts
`dirty_tree` (stash or commit it first). Override the list via `preserve:`;
pass `preserve: []` to disable preserve entirely (strict dirty-tree gate).

## Plain `pi` sessions (tools absent)

The devops tools load only via the **pi-agent wrapper's** run-dir argv splice —
a session launched as plain `pi` gets no repo extensions, so none of the tools
above are in its toolset. Diagnose this by the tools being absent, not by
guessing at launch flags. When they are absent:

- **Do NOT hand-roll raw git.** The old bash fallback (`scripts/sync-repo.sh`)
  was deleted after the TS port; inventing a replacement git sequence is
  exactly the raw-bash failure mode this skill forbids.
- **For sync**, use the CLI fallback — the same `runSync` orchestration as
  `sync_repo`, callable with `bun`:
  ```bash
  bun bun-apps/pi-agent-ext-devops/src/sync-cli.ts [--dry-run]
  ```
  It supports `--mode full|rebase|pull`, `--dry-run` (plan only, zero
  mutations — preview before running), `--force`, `--preserve <path>`, and
  `--preserve-strict`; it prints the structured JSON outcome and exits non-zero
  on abort (dirty tree, divergent default branch, …).
- **For other owned phases** (branch prep, local CI, PR merge, verify, sweep,
  retrospective), there is no CLI fallback — relaunch via the pi-agent wrapper
  (`bun bun-apps/pi-agent/src/cli.ts`), which auto-loads all run-dir extensions
  and skills, or ask the user to.

## Discipline

- **No raw-bash git for owned phases.** If a devops tool exists for the
  operation, call it. Reach for raw `git`/`gh` only for a quick read that no
  tool covers (and even then prefer `pr_status`).
- **Preview before mutating.** Pass `dryRun: true` to `prepare_branch` /
  `sync_repo` to see the exact commands first.
- **Honor the aborts.** A `worktree-conflict` / `rebase-conflict` /
  `force-push-failed` abort is a structural stop — resolve it (switch worktree,
  resolve conflicts, fetch + rebase) before re-running, don't paper over it.
- **Scope is a verdict, not a guess.** When you set `expectedScope`, trust the
  CLEAN/CONTAMINATED verdict from `verify_merge` over a hand-counted diff.
