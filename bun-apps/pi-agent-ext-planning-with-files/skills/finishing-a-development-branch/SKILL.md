---
name: finishing-a-development-branch
description: Use when implementation is complete and tests pass, to decide how to integrate the work — presents structured options (local merge / PR / keep / discard), detects the worktree environment, and runs the chosen workflow worktree-safe. For this repo's PR option it delegates to ./scripts/pr-finish.sh; cleanup delegates to ./scripts/stale-branches.sh.
---

# Finishing a Development Branch

## Overview

Guide the closeout of development work: verify tests, detect the environment, present a small
set of structured options, execute the chosen one, and clean up. Never improvise the finish —
a wrong merge or a deleted worktree loses work.

**Core principle:** verify tests → detect environment → present options → execute → clean up.

**Announce:** "I'm using finishing-a-development-branch to close out this work."

## Step 1 — Verify tests (gate)

Before offering any option, prove the work is green. In this repo each package is tested
uniformly:

```bash
( cd bun-apps/<pkg> && bun test )          # any bun-apps/* package
( cd bun-apps/<pkg> && bun run build && bun test )   # if the package builds first
python/venv/bin/python -m pytest python/<pkg>/tests  # python packages
```

If **anything fails**: stop. Report the failures. Do not proceed to the options — a finish on
red tests merges broken code (see `verification-before-completion`). Fix or explicitly get
human consent to continue.

## Step 2 — Detect the environment

```bash
git rev-parse --abbrev-ref HEAD          # branch name, or "HEAD" if detached
git rev-parse --show-toplevel            # which worktree you're in
git worktree list                        # all worktrees + their branches
git status --porcelain                   # uncommitted changes? (resolve first)
```

This repo uses **sibling worktrees** (`../video_generation__<name>`, e.g. `__ext`, `__cli`,
`__pi`), not `.worktrees/`. `main` is checked out in the `__cli` worktree — you can **never**
`git checkout main` from another worktree (it's held). The finish must be worktree-safe:
prefer detaching at `origin/main` over checking out `main`.

## Step 3 — Present the options

**On a named branch (or ordinary repo):** exactly these four:

```
Implementation is complete and green. What do you want to do?

1. Merge locally back into <base>
2. Push and open a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work

Which?
```

**On a detached HEAD** (externally-managed worktree): exactly these three (no local merge):

```
Implementation is complete and green. You're on a detached HEAD.

1. Push as a new branch and open a Pull Request
2. Keep as-is (I'll handle it later)
3. Discard this work

Which?
```

Do not add explanations — keep the options terse.

## Step 4 — Execute the choice

### Option 1 — Local merge

```bash
# main lives in a sibling worktree; merge there via -C, never `cd` top-level (no-cd-drift hook)
git -C /path/to/__cli checkout main
git -C /path/to/__cli merge --ff-only <feature-branch>   # or a real merge
# re-verify tests on the merged result, THEN clean up (Step 5)
```

### Option 2 — Push and open a PR (this repo's preferred flow)

Create the PR, then run the repo's merge→cleanup helper, which encodes the whole sequence
(CI watch → squash-merge → base-update sync → branch delete → prune → 0-stale report):

```bash
gh pr create --title "<title>" --body "<body>"
./scripts/pr-finish.sh <PR#>            # squash-merge + worktree-safe cleanup
# preview without side effects:
./scripts/pr-finish.sh <PR#> --dry-run
```

`pr-finish.sh` detaches at `origin/main` (never checks out `main`), deletes local + remote
branch, and ends by calling `stale-branches.sh`. If a base-update is needed it syncs
`origin/main` into the branch, re-watches CI (polling for check registration), and re-merges.

### Option 3 — Keep as-is

Report: "Keeping branch `<name>`; worktree remains at `<path>`." Do **not** clean up.

### Option 4 — Discard

Confirm first — list exactly what will be deleted (branch, commits, worktree path) and require
explicit confirmation. Only then `git branch -D` (and worktree removal if you created it).

## Step 5 — Clean up

- **Options 1 and 4 only** clean up the worktree/branch. Options 2 and 3 keep it (PR iteration
  still needs the worktree alive).
- Branch hygiene gate:

```bash
./scripts/stale-branches.sh              # report only — expect 0 stale on a clean repo
./scripts/stale-branches.sh --prune      # delete stale local+remote, KEEP ≤7d-old branches
```

The keep-set (protected, never pruned): `main`, the current branch, any branch checked out in
a worktree, and any branch with an open PR. **Plus a recency guard:** in this concurrent-agent
repo, `--prune` also refuses any branch whose latest commit is ≤ 7 days old (almost certainly
another session's active work) unless you pass `--force`. Never `git branch -D` a branch just
because the report lists it — check `git log -1 --format=%ci <branch>` first; if recent, leave it.

**Removing a worktree:** run from the main repo root, never from *inside* the worktree being
removed, then prune:

```bash
git -C <main-repo-root> worktree remove <worktree-path>
git -C <main-repo-root> worktree prune
```

Only remove worktrees you created. Sibling worktrees owned by other sessions/concurrent agents
must be left alone.

## Quick reference

| Option | Merge | Push | Keep worktree | Delete branch |
|--------|-------|------|---------------|---------------|
| 1. Local merge | ✓ | — | — | ✓ |
| 2. PR (`pr-finish.sh`) | ✓ (squash) | ✓ | (cleanup after merge) | ✓ |
| 3. Keep | — | — | ✓ | — |
| 4. Discard | — | — | — | ✓ (force) |

## Red lines

Never:
- offer options before tests are green;
- merge without re-verifying tests on the merged result;
- `git checkout main` from a non-`__cli` worktree (main is held there);
- delete work without explicit confirmation;
- force-push without an explicit request;
- remove a worktree from *inside* itself, or one you didn't create;
- clean up on options 2/3 (the worktree is still needed).

Always:
- verify tests first;
- detect the environment before presenting options;
- show exactly 4 options (3 on detached HEAD);
- require confirmation for discard;
- end with `stale-branches.sh` and expect 0 stale.

## Integration

Called by:
- `subagent-driven-development` (final step, after all tasks + holistic review);
- `executing-plans` (after the last batch).

Pairs with: `using-git-worktrees` (created the workspace this skill cleans up).
