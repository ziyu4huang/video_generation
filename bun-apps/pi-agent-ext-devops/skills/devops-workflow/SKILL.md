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

Run typecheck + tests scoped to the packages changed vs `origin/main`, plus
**every step of the workflow's `regression-gates` job** (~14 gates, ~5s).
**Offline** — a green run is the local proxy for a green remote run (remote CI
is intentionally disabled in this repo). This is what `await_pr_merge` gates on;
run it standalone to self-verify before merge.

**Nothing here is hand-copied.** Both halves are derived from
`.github/workflows/ci.yml.disabled` at runtime: the per-package command from the
`tests` matrix (`src/ci-matrix.ts`), the gate list from the `regression-gates`
job (`src/ci-gates.ts`). A hand-written gate list previously ran 2 of the 14
steps, so `test:deps` / `test:adr` / `test:seam` / `test:routing` /
`test:config-parity` / `test:ci-workflow` / `test:scripts` and the `--strict`
portability audit never ran under the gate `await_pr_merge` merges on. If you add
a gate step to the workflow, `local_ci` picks it up with no edit here.

Two consequences worth knowing:

- **A gate list that cannot be parsed fails the run** (`gateError`, `overall:
  "fail"`), it does not degrade to "0 gates, all passed". That degradation is
  the false-green the derivation exists to prevent. This is the OPPOSITE of the
  matrix reader, which safely degrades to `{}` because a package with no row
  still runs its generic `bun run test`.
- **`strict: true` no longer means "add the audit gates"** — those are in the
  job now and always run. It means "also run the audits that have NO workflow
  step" (`check-workflow-patterns.mjs`, `verify-skills.ts`).

`local_ci` is **change-scoped**, so it says nothing about packages your branch
does not touch. It is not a health check for `main` — that is `main_health`.

### 2b. `main_health` — is the default branch itself green?

Change-scoping plus disabled remote CI means a branch that avoids a broken
package merges green forever and **nothing reports that `main` is red**. On
2026-08-15 `main` had been failing `pi-agent` for days and had just started
failing `pi-agent-ext-obsidian`; no step in this chain would have said so.

`main_health` runs the FULL matrix + the whole gate suite **in the worktree that
actually holds the default branch** — a suite runs against a working tree, not a
ref, so running it anywhere else would report that tree's health under main's
name. Read-only: it never checks out, syncs, or mutates.

- **No worktree holds the default branch → it ABORTS** and reports unhealthy.
  "We could not test it" must never read as "it is fine".
- A dirty or behind tree still runs, but the outcome carries a `warnings` entry
  saying the verdict is about that tree and not exactly `origin/<default>`.
- **A package whose typecheck exits 127 goes to `toolchainMissing`, not
  `failingPackages`.** 127 is "command not found" — that worktree has no deps
  installed, which is an environment problem, not a broken branch. Its test is
  discounted too (several matrix rows are `bun run build && …`, which fails for
  the same reason). The branch still counts as unverified: an unrun check is not
  evidence of health. Fix with `bun install` from that worktree's `bun-apps/`.

It is STRICTER than `ci-local.sh`, which runs only each matrix row's `test-cmd`
and no typechecks at all. Expect `main_health` to surface typecheck failures that
`ci-local.sh` reports as green.

Run it before starting work, and when a merge you did not expect to matter looks
suspicious. Do NOT gate `await_pr_merge` on it: your PR is not responsible for a
package it does not touch.

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
| "Is `main` itself green?" (full matrix + gates, read-only) | `main_health` |
| Classify + clean up merged local/remote branches | `sweep_branches` |
| Build + deploy the pi-agent bundle + thin ext bundles (mirrors `scripts/deploy.ts`) | `pi_deploy` |
| Run a pi-agent `run-test.sh` tier (quick/medium/high/readonly/full) to self-verify | `pi_verify` |

### `sweep_branches` — the worktree guard covers remotes too

A branch checked out in ANY worktree is never deleted, **local or remote**.
Deleting `origin/x` does not touch a local checkout of `x`, which is why remotes
used to be exempt — but the guard protects the person in that worktree, whose
push target and upstream tracking would vanish mid-session. The guard runs twice:
at plan time and again against fresh state immediately before each delete.

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
- **Every other owned phase now has one too.** All take `--help`, print the
  structured outcome as JSON on stdout (diagnostics stay on stderr), and exit
  `0` success / `1` the run reports failure or abort / `2` usage error:

  ```bash
  bun bun-apps/pi-agent-ext-devops/src/main-health-cli.ts        # is main green?
  bun bun-apps/pi-agent-ext-devops/src/sweep-cli.ts [--execute]  # dry-run by default
  bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts [--all]
  bun bun-apps/pi-agent-ext-devops/src/prepare-cli.ts --rebase [--force-push]
  bun bun-apps/pi-agent-ext-devops/src/verify-merge-cli.ts <pr> [--scope a,b]
  ```

  They are THIN wrappers: argv in, JSON out, all logic in the recipe, and the
  same `createLiveSpawn` + `createBranchClient` surface `extensions/devops.ts`
  wires. So the CLI and the tool cannot diverge in behavior, only in
  presentation — and the guards (worktree-conflict, dry-run defaults,
  `--force-push` never implied) are the recipe's, not re-implemented here.

- **`await_pr_merge` has no standalone CLI** — use `devops-pr-finish`
  (`src/pr-finish-cli.ts`), which wraps the whole finish sequence
  (preflight → local-CI gate → merge gates → squash-merge → verify_merge →
  branch cleanup).

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
