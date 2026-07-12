---
name: using-git-worktrees
description: Use when starting isolated feature work or executing an implementation plan — ensures work happens in a dedicated worktree. This repo uses SIBLING worktrees (../video_generation__<name>), not .worktrees/; main lives in the __cli worktree. Covers detect/create/navigate (subshell or git -C, never top-level cd)/baseline/cleanup per the keep-set rules.
---

# Using Git Worktrees

## Overview

Ensure work happens in an **isolated worktree** before implementation. This repo's layout is
specific: every feature dir is a **sibling worktree** under the same parent (e.g.
`/Users/huangziyu/proj/video_generation__ext`, `__cli`, `__pi`, `__ltx`, `__memory`,
`__workflow`, `__image_workflow`), **not** a `.worktrees/` subdirectory. `main` is checked out
in the `__cli` worktree.

**Core principle:** detect existing isolation first; create a sibling worktree off `origin/main`;
navigate with subshells or `git -C` (the `no-cd-drift` PreToolUse hook blocks top-level `cd`);
baseline-test before starting; clean up with `finishing-a-development-branch`.

**Announce:** "I'm using-git-worktrees to set up an isolated workspace."

## Step 0 — Detect existing isolation

You are almost always **already inside** a linked worktree in this repo. Confirm:

```bash
git rev-parse --git-dir          # ends in `/worktrees/<name>` ⇒ linked worktree
git rev-parse --show-toplevel    # the worktree path
git rev-parse --abbrev-ref HEAD  # branch, or "HEAD" if detached
git worktree list                # all worktrees + their branches
```

- **Already in a worktree** (the normal case) → skip creation, go to Step 2 (baseline).
- **In the bare/common repo or on `main` in `__cli`** → create a new worktree (Step 1).

Submodule guard: inside a submodule `git-dir` also differs from `git-common-dir`. Confirm with
`git rev-parse --show-superproject-working-tree` — if it prints a path, you're in a submodule,
not a worktree; treat as an ordinary checkout.

## Step 1 — Create a sibling worktree

Create from **any** worktree (they share one `.git`); branch off `origin/main`:

```bash
git fetch origin --prune
git worktree add ../video_generation__<name> -b <branch-name> origin/main
```

Naming convention: `video_generation__<topic>` (double underscore), matching the existing
siblings. The new dir lands as a sibling of the others — never inside `.worktrees/`.

If the sandbox refuses, fall back to working in-place in the current worktree on a new branch
(`git checkout -b <branch>`), and note that isolation is branch-level, not dir-level.

## Step 2 — Baseline

Verify the starting state is clean **before** writing anything, so a later failure is clearly
yours and not pre-existing:

```bash
# node/bun packages (this repo is a Bun workspace monorepo)
( cd ../video_generation__<name>/bun-apps/<pkg> && bun install && bun test )
# python packages
python/venv/bin/python -m pytest python/<pkg>/tests
```

If the baseline test fails: report it, get explicit consent before continuing — otherwise you
can't tell your bugs from the pre-existing ones.

## Step 3 — Navigate between worktrees

The `no-cd-drift` hook **blocks any top-level `cd`** (the tool's cwd would drift out of repo
root and break root-relative paths). Always navigate with:

```bash
( cd ../video_generation__<name> && <command> )     # subshell — preferred
git -C ../video_generation__<name> <git-command>    # git only
bun run --cwd bun-apps/<pkg> <script>               # bun scripts
```

Never run a bare `cd ../video_generation__<name>` at the top level of a command.

## Step 4 — The keep-set (what is protected)

`stale-branches.sh` never prunes the keep-set:
- `main` (and whatever is checked out in `__cli`);
- the current branch;
- any branch checked out in any worktree;
- any branch with an open PR.

Only branches **outside** this set are "stale" and prunable. Inspect with:

```bash
./scripts/stale-branches.sh                 # report
./scripts/stale-branches.sh --prune         # delete stale local + remote
```

## Step 5 — Clean up

When the work is merged (see `finishing-a-development-branch`), remove the worktree from the
**main repo root**, never from inside the worktree itself, then prune:

```bash
git -C /Users/huangziyu/proj/video_generation__cli worktree remove ../video_generation__<name>
git -C /Users/huangziyu/proj/video_generation__cli worktree prune
```

Only remove worktrees **you** created. Other siblings are owned by concurrent sessions/agents —
leave them. (`pr-finish.sh` handles this cleanup automatically after a PR merge.)

## Quick reference

| Situation | Action |
|-----------|--------|
| Already in a linked worktree | Skip creation; baseline (Step 0→2) |
| Need isolation | `git worktree add ../video_generation__<name> -b <branch> origin/main` |
| Navigate | `( cd <path> && … )` or `git -C <path> …` — never top-level `cd` |
| Baseline red | Report + get consent before continuing |
| After merge | `worktree remove` from main repo root + `worktree prune` |
| Not your worktree | Leave it (concurrent session owns it) |

## Red lines

Never:
- create a worktree when Step 0 shows you're already in one;
- create under `.worktrees/` — this repo uses sibling worktrees;
- use a top-level `cd` (the `no-cd-drift` hook blocks it; use a subshell or `-C`);
- run `git worktree remove` from inside the worktree being removed;
- remove a worktree or branch you didn't create (concurrent sessions may own it);
- start work on a red baseline without explicit consent;
- check out `main` outside the `__cli` worktree (it's held there).

Always:
- run Step 0 first;
- branch new worktrees off `origin/main` (fetch first);
- baseline-test before writing;
- keep navigation in subshells / `git -C`;
- end with `stale-branches.sh` and expect 0 stale.

## Integration

Called by:
- `brainstorming` (once design is approved, before implementation);
- `subagent-driven-development` and `executing-plans` (before any task).

Pairs with: `finishing-a-development-branch` (cleans up the worktree this skill creates).
