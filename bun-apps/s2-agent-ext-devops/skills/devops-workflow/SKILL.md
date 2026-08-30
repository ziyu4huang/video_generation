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
(c) Plain `pi` session without the devops extension → CLI fallback: `bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts` (same runSync orchestration; `--dry-run` supported; JSON on stdout).

Rebase/pull on a DETACHED worktree (session worktrees here routinely are — post-merge detach, fresh agent worktree) aborts `detached_head` by default; pass `--branch <name>` (or `--branch auto`, which derives the name from the worktree folder suffix: `video_generation__memory` → `memory`) to create the branch at the current HEAD and proceed. Guarded: never the default branch; an existing branch at a different commit aborts `branch_exists` (existing at the exact HEAD is attached, not recreated); a branch checked out in another worktree aborts `worktree_conflict`. The agent layer should pass a semantic name (ticket / next-goal slug) when it has one and reserve `auto` as the fallback — never let the tool name a branch after the work of a session it cannot see.
(d) Verify after: `git log --oneline -3 origin/main`.

Remote name: every `origin/<ref>` ref and `git fetch/push origin` in the devops tools follows `DEVOPS_REMOTE` env > `git config devops.remote` > `origin` (src/remote.ts) — `origin/main` in this skill's prose means `<remote>/main` for the configured remote. Fork layouts (`origin` = personal mirror, `upstream` = the real forge) set one of the two and every tool follows.

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

## Forge backends (how PR/merge calls reach the host)

The PR/merge tools talk to the git host through a **forge abstraction**
(`src/forge/`): REST-first, gh-CLI fallback. Selection (`src/forge/select.ts`)
is automatic per repo — you do not choose a backend:

1. `GITHUB_TOKEN` / `GH_TOKEN` env → GitHub REST adapter.
2. `gh auth token` (gh installed + authenticated) → GitHub REST adapter.
3. gh on PATH (no token) → the gh-CLI adapter (historical behavior).
4. None of the above → the tool aborts with remediation text.

Gitea/Forgejo hosts (recognized by naming, or forced with `DEVOPS_FORGE=gitea`
for self-hosted names like `git.acme.internal`) select the **Gitea adapter** —
which requires `GITEA_TOKEN` (a PAT from Settings → Applications; there is no
gh-equivalent CLI to harvest one). `GITEA_API_BASE` overrides the API base
(http instances). Note: Gitea has no mergeable-state ladder — a
behind-but-mergeable PR reports CLEAN; the local-CI gate, not mergeState, is
the correctness gate.
Git operations (fetch/push/branch/worktree) never go through the forge layer;
they stay native regardless of backend.

## The chain (run in order)

### 0. Sync check — ALWAYS first, no exceptions

Before ANY step below (and before executing a next-goal queue head), verify
the tree is at the remote default branch's tip. Work is written against main
as of its session; main moves between sessions. Starting the chain from a
stale tree rebases, CI-gates, or merges against the wrong base — this check
is not optional and not implicit in later steps.

- **Attached worktree**: `bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts --mode rebase`
  (or fetch and count `git rev-list --count HEAD..origin/main` — `0` = already at tip).
- **Detached worktree** (post-merge detach / fresh agent worktree — routine
  here): `--branch <slug>` works in `rebase`/`pull` modes only. It is IGNORED
  in the default `full` mode — full advances `main` in its own worktree, never
  the calling worktree's HEAD, so a detached caller stays stale with nothing
  but a warning ("branch option ignored in full mode"). The full-mode recipe
  is TWO steps: (1) `sync-default-branch-cli` (full — fetch, advance main,
  submodules), then (2) `prepare-feature-branch-cli --branch <slug> --create`
  (base defaults to the freshly fetched `<remote>/main`) to attach THIS
  worktree to the tip. Verify after either path:
  `git rev-list --count HEAD..origin/main` → `0`.

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
2026-08-15 `main` had been failing `s2-agent` for days and had just started
failing `s2-agent-ext-obsidian`; no step in this chain would have said so.

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

It is STRICTER than `ci-local.ts`, which runs only each matrix row's `test-cmd`
and no typechecks or lints at all. Expect `main_health` to surface typecheck and
biome failures that `ci-local.ts` reports as green.

Run it before starting work, and when a merge you did not expect to matter looks
suspicious. Do NOT gate `merge_pr_after_local_ci` on it: your PR is not responsible for a
package it does not touch.

### 2c. Independent reviewer gate — named dispatch → verdict → receipt

Write-heavy implementer dispatches use the independent **reviewer subagent**
as the real quality gate (watchdog OFF — see CLAUDE.md's Subagent dispatch).
Dispatch it WITH a `name:` (e.g. `reviewer-<ticket>`); that name is the key
to the verdict, whatever the harness's child→lead injection does:

- **PRIMARY (claude CLI 2.1.250+, probed 2026-08-29 ≤45s)**: the reviewer's
  notification arrives injected into the lead conversation mid-turn — reply to
  it. NEVER wait idly for it, and never TaskStop blind: on 2.1.247 the same
  notification was observed delayed >24h or never (RCA 2026-08-28; a
  REQUEST_CHANGES landed 24h late against already-merged #2098 and spawned
  #2122), so the fallback is always one command away.
- **FALLBACK + receipt (always)** —
  `bun bun-apps/s2-agent-ext-devops/scripts/reviewer-harvest.ts --name <reviewer-name> [--timeout <sec>] [--poll <sec>]`
  Locates the newest `agent-a<name>-*.jsonl` transcript under `~/.claude-glm`
  (PRIMARY) — or, when that finds nothing, the newest matching run record in the
  pi-harness archive `~/.pi/subagents/runs/<runId>.json` (FALLBACK, default-on;
  PR #2170) — so a pi/s2-agent-dispatched reviewer's verdict harvests too,
  extracts the last `end_turn` assistant text as the verdict (exit 0
  completed / 1 still-running·absent·errored / 2 usage), and writes an
  idempotent receipt under `output/reviewer-harvest/`. **Cite the receipt
  file (or transcript path) in the PR body** — that is the
  independent-review evidence. `TaskStop` the reviewer after harvest.

Session-start habit (the #2122 pattern): re-read the team inbox
(`~/.claude-glm/teams/session-*/inboxes/team-lead.json`) — a delayed verdict
may carry actionable findings against already-merged code.

### 3. `merge_pr_after_local_ci` — local-CI-gated squash-merge

Runs `run_local_ci` over the PR's changed packages vs its base, then squash-merges
when green **and** the PR is CLEAN/mergeable. Blocks (no merge) on red CI,
detection error, BEHIND, or a non-CLEAN mergeState. No remote CI, no polling.
When it reports BEHIND, go back to step 1 (`prepare_feature_branch`).

**Version bumps are manual, at PR finish** (2026-08-22 policy — supersedes the
2026-08-07 "no release tooling" decision): when a PR touches
`bun-apps/s2-agent/**`, run
`bun bun-apps/s2-agent-ext-devops/src/version-bump-cli.ts --package s2-agent --patch`
(`--minor` for user-visible / host-contract changes, `--major` for breaking)
and commit the bump with the change it names. The tool syncs package.json +
`dispatch.ts`'s VERSION const in lockstep; the e2e pins read package.json so
they never chase. `merge_pr_after_local_ci` nudges (advisory, never blocks)
when s2-agent changed without a bump — deploy version dirs render
`<pkgVersion>+g<sha>`, and an ever-frozen `0.1.0` prefix names nothing.

### 4. `verify_merge_landed` — confirm scope + main advanced + branch spent

After the merge: confirm the PR actually merged, inspect the merge commit's real
file scope against an optional `expectedScope` (verdict CLEAN vs CONTAMINATED),
and whether the feature branch is now **spent**. Pass the same `expectedScope`
you intended the work to touch — a CONTAMINATED verdict means the merge pulled in
out-of-scope paths. **List EVERY touched root, including doc files** (CLAUDE.md,
`docs/`, READMEs) — a code PR with an intentional one-line CLAUDE.md edit rode
through as "CONTAMINATED" on PR #1802 because only the package dir was passed.
On CONTAMINATED the tool/CLI now prints a `scope remedy:` warning with the exact
corrected `--scope` list (current entries ∪ drifted paths) — copy-paste it into
a `verify-merge-cli <pr> --scope …` re-run to re-adjudicate CLEAN. Replaces
manual `git show` / `git branch --merged` verification.

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

### 6. Close out — self-reflect + write the next goal

**REQUIRED FINAL STEP:** after the chain completes, follow
**self-reflect-next-goal** (same package, `skills/self-reflect-next-goal/`):
write `output/next-goal-<ts>.md` recording what shipped (with verification
evidence) and 3–5 ranked next goals, and prune the rolling history beyond 10.
When starting the NEXT run, read the newest next-goal file before planning.
**Ticket-queue close-out:** when the merged PR closed a ticket of a
`.planning/<effort>/` queue, the successor's `Immediate steps` head is the NEXT
ticket in the effort's chosen `Execution order` (see `self-reflect-next-goal`
queue mode) — not a freshly invented goal; when the queue is empty, the head is
the effort close-out (map status: complete).

## When to use which tool

| Situation | Tool |
| --- | --- |
| Need to create / rebase / force-push a branch (esp. to clear BEHIND) | `prepare_feature_branch` |
| Self-verify typecheck + tests before merge | `run_local_ci` |
| Merge a PR (gated on local CI + mergeable) | `merge_pr_after_local_ci` |
| Confirm a merge's scope + that the branch is spent | `verify_merge_landed` |
| Harvest a named reviewer subagent's verdict (fallback + receipt) | `bun bun-apps/s2-agent-ext-devops/scripts/reviewer-harvest.ts --name <reviewer-name>` |
| Post-run "anything risky?" anomaly readout | `run_devops_retrospect` |
| One-shot PR state + check tally (inspect, don't merge) | `show_pr_status` |
| Sync this repo/worktree to the latest default branch | `sync_default_branch` |
| "Is `main` itself green?" (full matrix + gates, read-only) | `check_main_health` |
| Classify + clean up merged local/remote branches | `sweep_merged_branches` |
| Build + deploy the s2-agent bundle + thin ext bundles (runs `s2-agent-ext-devops/src/deploy/run.ts` via `src/deploy-cli.ts`) | `deploy_pi_agent_sh` |
| Run a s2-agent `run-test.ts` tier (quick/medium/full) to self-verify | `verify_pi_agent_deploy` |
| Deploy the versioned sh core + ext set (Pipeline B, registry `src/registry-config.ts`) | `deploy` — `bun run --cwd bun-apps/s2-agent deploy` (CLI: `bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts [--list]`) |
| "Does the DEPLOYED dist actually work?" (boot + ext-load + model call against `<outRoot>/current`) | `bun bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts` (runs automatically after every deploy too) |
| Reuse a DEPLOYED extension's tools from any bun script (no repo, no rebuild) | the dist's `<outRoot>/AGENTS.md` — the quickstart against `<platform>/current/ext/ext-standalone.mjs` (proven by every deploy's `standalone-import` E2E probe) |

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

The devops tools load only via the **s2-agent wrapper's** run-dir argv splice —
a session launched as plain `pi` gets no repo extensions, so none of the tools
above are in its toolset. Diagnose this by the tools being absent, not by
guessing at launch flags. When they are absent:

- **Do NOT hand-roll raw git.** The old bash fallback (`scripts/sync-repo.sh`)
  was deleted after the TS port; inventing a replacement git sequence is
  exactly the raw-bash failure mode this skill forbids.
- **For sync**, use the CLI fallback — the same `runSync` orchestration as
  `sync_default_branch`, callable with `bun`:
  ```bash
  bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts [--dry-run]
  ```
  It supports `--mode full|rebase|pull`, `--dry-run` (plan only, zero
  mutations — preview before running), `--force`, `--preserve <path>`, and
  `--preserve-strict`; it prints the structured JSON outcome and exits non-zero
  on abort (dirty tree, divergent default branch, …).
- **Every other owned phase now has one too.** All take `--help`, print the
  structured outcome as JSON on stdout (diagnostics stay on stderr), and exit
  `0` success / `1` the run reports failure or abort / `2` usage error:

  ```bash
  bun bun-apps/s2-agent-ext-devops/src/main-health-cli.ts        # is main green?
  bun bun-apps/s2-agent-ext-devops/src/sweep-merged-branches-cli.ts [--execute]  # dry-run by default
  bun bun-apps/s2-agent-ext-devops/src/local-ci-cli.ts [--all]
  bun bun-apps/s2-agent-ext-devops/src/prepare-feature-branch-cli.ts --rebase [--force-push]
  bun bun-apps/s2-agent-ext-devops/src/verify-merge-cli.ts <pr> [--scope a,b]
  bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts [--list]
  bun bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts [--deploy-root <path>] [--skip-model-call]
  bun bun-apps/s2-agent-ext-devops/src/version-bump-cli.ts --package s2-agent [--patch|--minor|--major] [--dry-run]
  ```

  `verify-deploy-e2e-cli` proves the deployed dist works, not just that it
  built: three bounded probes (60s/60s/120s caps) against the version dir
  `current` points at — `s2-agent.sh --help` boot, `--ext-list` vs deploy.json's
  enabled extensions, and a real `-p` one-shot model call. A fast
  provider/auth failure is a SKIP (boot still proved), a timeout or missing
  extension is a FAIL. `deploy-cli.ts` runs the same E2E automatically after
  every deploy (fresh or noop); the standalone CLI is for post-hoc checks of
  an existing `~/proj/dist/s2-agent-sh`. Do NOT probe interactive
  subcommands (bare `auth` opens a TUI and blocks forever without a TTY).

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
  full CI re-run (observed on PR #1646, 2026-08-18). The poll applies **only to
  an OPEN PR** — a terminal-state PR never settles (GitHub stops computing
  mergeability once merged), so an UNKNOWN read on one is returned immediately.

  An **already-MERGED PR is a settled outcome, not an abort** (#2077, observed
  twice around PR #2027): a retry against a merge that had landed used to print
  `merged:false, verdict:NOT-MERGED` — sending the operator to re-verify and
  clean up by hand. The CLI now warns `already MERGED`, skips the merge gates +
  `mergeNow`, and runs verify_merge_landed + branch cleanup as its own recovery
  path. `NOT-MERGED` from this tool now means what it says; a `CLOSED` PR
  still aborts `not-open`.

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
