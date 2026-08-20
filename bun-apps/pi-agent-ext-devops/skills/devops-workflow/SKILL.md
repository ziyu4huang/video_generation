---
name: devops-workflow
description: Use when doing branch / rebase / PR / merge / verify work on this repo — prepare a branch, self-verify with local CI, squash-merge a PR, verify the merge's file scope, or run an advisory post-run retrospective. Routes the canonical devops tool chain and forbids the raw-bash git fallback that caused scope-verification false-positives, worktree-blocked checkouts, and un-verified merges in past runs.
---

# DevOps Workflow

The canonical branch → CI → merge → verify → reflect lifecycle is owned by the
**devops tools**. When you touch git in any of these phases, call the tools **in
order** and **do NOT fall back to raw bash `git` / `gh`** for the parts they own.

## Agent trigger map — git sync

(a) The user asks to sync/update the repo to the latest remote default branch in ANY phrasing: "sync to remote", "git sync", "update main", "get latest", "pull latest", "up to date".
(b) Devops tools loaded → call `sync_default_branch` (default full mode; `dryRun:true` to preview).
(c) Plain `pi` session without the devops extension → CLI fallback: `bun bun-apps/pi-agent-ext-devops/src/sync-default-branch-cli.ts` (same runSync orchestration; `--dry-run` supported; JSON on stdout).
(d) Verify after: `git log --oneline -3 origin/main`.

Note: tools activate on these keywords via owner-declared gating; `enable_tool` is the escape hatch when a gate hasn't fired.

## Why tools, not raw bash

Past runs that reached for raw bash git produced three recurring failure modes —
all of which the devops tools exist to prevent:

- **Scope-verification false-positives.** Hand-rolled `git show --stat` /
  `git diff --name-only` parsing mis-split binary lines / summary lines and
  reported CLEAN where the merge had actually drifted out of scope.
  `verify_merge_landed` owns a tested parser + an explicit CLEAN/CONTAMINATED verdict,
  so the verdict is never a hunch. **Never parse `--stat` yourself, and note the
  tool no longer does either**: `--stat` renders for a terminal and abbreviates
  long paths as `.../tail`, which broke every prefix match and reported a clean
  merge as CONTAMINATED (PR #1360). `--numstat` is the machine-readable form —
  full paths, per-file counts.
- **Worktree-blocked checkouts.** A bare `git checkout -b` fatals when the
  branch is already checked out in another worktree. `prepare_feature_branch` guards
  against this **before** any mutation and aborts cleanly (`worktree-conflict`).
- **Un-verified merges.** `gh pr merge` with no local gate merged PRs whose
  typecheck/tests were actually red. `merge_pr_after_local_ci` gates the squash-merge on a
  real local-CI run first.

Every tool is **throw-free** (every refusal surfaces as a structured
`aborted`/`warnings` + `summary`, never a thrown exception), records the exact
git invocations in `commands[]`, and honors `dryRun` (compute + show the plan,
spawn zero mutations). Use `dryRun: true` to preview before mutating.

## The chain (run in order)

### 1. `prepare_feature_branch` — worktree-safe branch setup

Create a branch off the base, rebase it onto the base, and/or force-push-with-
lease. This is what covers the **BEHIND** state that `merge_pr_after_local_ci` blocks on:
when a PR is BEHIND, run `prepare_feature_branch` with `rebase: true` (and
`forcePush: true` once the rebase is clean) to bring it forward, then re-attempt
the merge.

- Aborts `worktree-conflict` (branch checked out elsewhere) **before** mutating.
- Aborts `rebase-conflict` (runs `git rebase --abort` first, recorded) so you
  never land mid-rebase.
- `rebase` runs `git rebase <base> <branch>`, so it checks the named branch out
  and **leaves HEAD there** — you do not have to check it out first, and you are
  not left where you started.
- `forcePush` defaults to **false** — it never force-pushes by accident; opt in
  explicitly with `--force-with-lease`.
- Prefer `dryRun: true` first to see the exact commands.

### 2. `run_local_ci` — self-verify (the local proxy for remote CI)

Run typecheck + lint + tests scoped to the packages changed vs `origin/main`,
plus **every step of the workflow's `regression-gates` job** (~15 gates, ~5s).
**Offline** — a green run is the local proxy for a green remote run (remote CI
is intentionally disabled in this repo). This is what `merge_pr_after_local_ci` gates on;
run it standalone to self-verify before merge.

**Nothing here is hand-copied.** Both halves are derived from
`.github/workflows/ci.yml.disabled` at runtime: the per-package command from the
`tests` matrix (`src/ci-matrix.ts`), the gate list from the `regression-gates`
job (`src/ci-gates.ts`). The per-package **typecheck** and **lint** phases are the
one exception and always have been: they are local_ci-native, resolved by script
NAME inside each package (`typecheck` / `check`-if-tsc; `check`-if-biome /
`lint`-if-biome), because the matrix rows give most packages a bare `bun test`
that chains neither. Which packages must declare such a script is asserted by
`tests/extension-entry-typechecked.test.ts` and `tests/lint-executor-coverage.test.ts`. A hand-written gate list previously ran 2 of the 14
steps, so `test:deps` / `test:adr` / `test:seam` / `test:routing` /
`test:config-parity` / `test:ci-workflow` / `test:scripts` and the `--strict`
portability audit never ran under the gate `merge_pr_after_local_ci` merges on. If you add
a gate step to the workflow, `run_local_ci` picks it up with no edit here.

Two consequences worth knowing:

- **A gate list that cannot be parsed fails the run** (`gateError`, `overall:
  "fail"`), it does not degrade to "0 gates, all passed". That degradation is
  the false-green the derivation exists to prevent. This is the OPPOSITE of the
  matrix reader, which safely degrades to `{}` because a package with no row
  still runs its generic `bun run test`.
- **`strict: true` no longer means "add the audit gates"** — those are in the
  job now and always run. It means "also run the audits that have NO workflow
  step" (`check-workflow-patterns.mjs`, `verify-skills.ts`).

`run_local_ci` is **change-scoped**, so it says nothing about packages your branch
does not touch. It is not a health check for `main` — that is `check_main_health`.

### 2b. `check_main_health` — is the default branch itself green?

Change-scoping plus disabled remote CI means a branch that avoids a broken
package merges green forever and **nothing reports that `main` is red**. On
2026-08-15 `main` had been failing `pi-agent` for days and had just started
failing `pi-agent-ext-obsidian`; no step in this chain would have said so.

`check_main_health` runs the FULL matrix + the whole gate suite **in the worktree that
actually holds the default branch** — a suite runs against a working tree, not a
ref, so running it anywhere else would report that tree's health under main's
name. Read-only: it never checks out, syncs, or mutates.

- **No worktree holds the default branch → it ABORTS** and reports unhealthy.
  "We could not test it" must never read as "it is fine".
- A dirty or behind tree still runs, but the outcome carries a `warnings` entry
  saying the verdict is about that tree and not exactly `origin/<default>`.
- **A package whose typecheck OR lint exits 127 goes to `toolchainMissing`, not
  `failingPackages`.** 127 is "command not found" — that worktree has no deps
  installed, which is an environment problem, not a broken branch. `biome` is a
  package-local binary too, so it fails 127 for exactly the same reason `tsc` does. Its test is
  discounted too (several matrix rows are `bun run build && …`, which fails for
  the same reason). The branch still counts as unverified: an unrun check is not
  evidence of health. Fix with `bun install` from that worktree's `bun-apps/`.

It is STRICTER than `ci-local.sh`, which runs only each matrix row's `test-cmd`
and no typechecks or lints at all. Expect `main_health` to surface typecheck and
biome failures that `ci-local.sh` reports as green.

Run it before starting work, and when a merge you did not expect to matter looks
suspicious. Do NOT gate `merge_pr_after_local_ci` on it: your PR is not responsible for a
package it does not touch.

### 3. `merge_pr_after_local_ci` — local-CI-gated squash-merge

Runs `run_local_ci` over the PR's changed packages vs its base, then squash-merges
when green **and** the PR is CLEAN/mergeable. Blocks (no merge) on red CI,
detection error, BEHIND, or a non-CLEAN mergeState. No remote CI, no polling.
When it reports BEHIND, go back to step 1 (`prepare_feature_branch`).

### 4. `verify_merge_landed` — confirm scope + main advanced + branch spent

After the merge: confirm the PR actually merged, inspect the merge commit's real
file scope against an optional `expectedScope` (verdict CLEAN vs CONTAMINATED),
and whether the feature branch is now **spent**. Pass the same `expectedScope`
you intended the work to touch — a CONTAMINATED verdict means the merge pulled in
out-of-scope paths. Replaces manual `git show` / `git branch --merged`
verification.

**`UNVERIFIED` is a fourth verdict, and it is not a pass.** It means the merge
landed but its files could not be read, so the scope check never ran. Treat the
scope as unknown — never as clean. The usual cause is mundane: right after
`gh pr merge` the squash commit exists only on the remote, so `git show <sha>`
fails with `fatal: bad object`. Pass `--fetch` (CLI) / `allowFetch` (recipe) to
pull that one object and verify for real; `pr_finish` already does. Before this
verdict existed, that everyday case reported **CLEAN with `fileCount: 0`** —
identical to a genuinely clean merge (issue #1439).

**`spent` does not mean "contained".** A squash merge rewrites the branch into
one new commit, so the head ref is never an ancestor of the base and
`git branch --merged` never lists it — under this repo's squash convention that
made `branchSpent` permanently false. It now keys off gh's `headRefOid`: still
pointing at the SHA that was merged ⇒ nothing left to lose ⇒ safe to delete. A
branch with commits pushed AFTER the merge correctly reports NOT spent.

Do not reach for a tree comparison against the merge commit instead — that tree
is all of the default branch at merge time, so it includes every unrelated PR
that landed between this branch's last rebase and its merge.

### 5. `run_devops_retrospect` — advisory anomaly review

A read-only, **never-blocking** retrospective after a mutating recipe: scans the
recent reflog + branch/worktree/divergence state and flags anomalies — a
force-push / history-rewrite signature, scope drift (recent commits touched
paths outside `expectedScope`), a branch checked out in >1 worktree, a dirty
tree, or an unexpected ahead+behind / far-behind divergence. Run it last for a
"did anything look risky?" readout; its findings are advisory, never a gate.

## When to use which tool

| Situation | Tool |
| --- | --- |
| Need to create / rebase / force-push a branch (esp. to clear BEHIND) | `prepare_feature_branch` |
| Self-verify typecheck + tests before merge | `run_local_ci` |
| Merge a PR (gated on local CI + mergeable) | `merge_pr_after_local_ci` |
| Confirm a merge's scope + that the branch is spent | `verify_merge_landed` |
| Post-run "anything risky?" anomaly readout | `run_devops_retrospect` |
| One-shot PR state + check tally (inspect, don't merge) | `show_pr_status` |
| Sync this repo/worktree to the latest default branch | `sync_default_branch` |
| "Is `main` itself green?" (full matrix + gates, read-only) | `check_main_health` |
| Classify + clean up merged local/remote branches | `sweep_merged_branches` |
| Build + deploy the pi-agent bundle + thin ext bundles (runs `pi-agent-ext-devops/scripts/deploy.ts`) | `deploy_pi_agent_sh` |
| Run a pi-agent `run-test.sh` tier (quick/medium/high/readonly/full) to self-verify | `verify_pi_agent_deploy` |
| Deploy the versioned sh core + ext set (Pipeline B, registry `pi-agent.registry.yaml`) | `deploy` — `bun run --cwd bun-apps/pi-agent deploy` (CLI: `bun bun-apps/pi-agent-ext-devops/src/deploy-cli.ts [--ext <name>] [--list]`) |

### `sweep_merged_branches` — the worktree guard covers remotes too

A branch checked out in ANY worktree is never deleted, **local or remote**.
Deleting `origin/x` does not touch a local checkout of `x`, which is why remotes
used to be exempt — but the guard protects the person in that worktree, whose
push target and upstream tracking would vanish mid-session. The guard runs twice:
at plan time and again against fresh state immediately before each delete.

### `sync_default_branch` — auto-managed hot files are preserved, not aborted

`sync_default_branch` advances the default branch (full mode), or rebases/merges the
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
  `sync_default_branch`, callable with `bun`:
  ```bash
  bun bun-apps/pi-agent-ext-devops/src/sync-default-branch-cli.ts [--dry-run]
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
  bun bun-apps/pi-agent-ext-devops/src/sweep-merged-branches-cli.ts [--execute]  # dry-run by default
  bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts [--all]
  bun bun-apps/pi-agent-ext-devops/src/prepare-feature-branch-cli.ts --rebase [--force-push]
  bun bun-apps/pi-agent-ext-devops/src/verify-merge-cli.ts <pr> [--scope a,b]
  bun bun-apps/pi-agent-ext-devops/src/deploy-cli.ts [--list|--ext <name>]
  ```

  They are THIN wrappers: argv in, JSON out, all logic in the recipe, and the
  same `createLiveSpawn` + `createBranchClient` surface `extensions/devops.ts`
  wires. So the CLI and the tool cannot diverge in behavior, only in
  presentation — and the guards (worktree-conflict, dry-run defaults,
  `--force-push` never implied) are the recipe's, not re-implemented here.

- **`merge_pr_after_local_ci` has no standalone CLI** — use `devops-merge-pr-after-ci`
  (`src/merge-pr-after-ci-cli.ts`), which wraps the whole finish sequence
  (preflight → local-CI gate → merge gates → squash-merge → verify_merge_landed →
  branch cleanup).

  Its cleanup **detaches this worktree onto the merge commit** before deleting
  the spent head branch — git refuses `branch -D` on a branch checked out
  anywhere, and the worktree that ran the merge is normally still on it, so
  that step used to fail on essentially every run and the caller had to detach
  and sweep by hand. The target is the merge sha rather than `origin/<base>`
  because the remote-tracking ref is still at the pre-merge tip at that point
  (`fetch --prune` runs after), which would leave you one commit behind the
  merge you just made. A branch held by a **different** worktree is deliberately
  left alone (that tree is not ours to move) and reported in `warnings`; its
  remote counterpart is still deleted.

  Its **merge gates read a snapshot taken after the CI gate, not the preflight
  one**. `mergeState: UNKNOWN` means GitHub has not finished computing
  mergeability (it recomputes on every push to the PR *and* to its base), so an
  UNKNOWN is polled up to `MERGE_STATE_POLLS` times rather than treated as a
  refusal. The outcome reports `mergeStateSettle: { mergeState, polls }`;
  `polls > 1` means it started UNKNOWN and settled. Before this, the gates read
  a snapshot from before a two-minute run_local_ci run — an UNKNOWN that had long
  since settled to CLEAN aborted the merge, and each manual retry paid for a
  full CI re-run (observed on PR #1646, 2026-08-18).

  `--assume-ci-green <sha>` skips the local-CI gate for exactly that retry
  case, asserting a full 40-hex head sha you already saw green. It is checked
  against the PR's **current** head, so a push landing in between aborts
  (`ci-assumption-stale`) instead of merging an ungated commit; a PR whose
  status carries no `headRefOid` is refused (`ci-assumption-unverifiable`)
  rather than trusted. The outcome carries `ciSkipped: { assumedSha }` and a
  warning — its **absence** is the proof this invocation ran CI itself. Use it
  only to retry a merge that already passed; never to merge something local CI
  has not seen.

  A merge refused for a **missing `workflow` scope** aborts as
  `missing-workflow-scope` (not the generic `merge-failed`) and names the fix:
  `gh auth refresh -h github.com -s workflow`, which the token owner must run
  interactively. GitHub classifies this by PATH, so any PR touching
  `.github/workflows/` trips it — including `ci.yml.disabled`, which nothing
  runs. The scope is **not stable across a session**, so one successful merge
  is not evidence it is still there. After refreshing, re-run with
  `--assume-ci-green <head sha>` instead of paying for run_local_ci again.

## Discipline

- **No raw-bash git for owned phases.** If a devops tool exists for the
  operation, call it. Reach for raw `git`/`gh` only for a quick read that no
  tool covers (and even then prefer `show_pr_status`).
- **Preview before mutating.** Pass `dryRun: true` to `prepare_feature_branch` /
  `sync_default_branch` to see the exact commands first.
- **Honor the aborts.** A `worktree-conflict` / `rebase-conflict` /
  `force-push-failed` abort is a structural stop — resolve it (switch worktree,
  resolve conflicts, fetch + rebase) before re-running, don't paper over it.
- **Scope is a verdict, not a guess.** When you set `expectedScope`, trust the
  CLEAN/CONTAMINATED verdict from `verify_merge_landed` over a hand-counted diff.
