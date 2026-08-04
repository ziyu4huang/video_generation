type: prototype
status: closed
claimed: 2026-08-04 work-session
resolved: 2026-08-04
blocked by: —

## Question

How should the skill encode the **multi-worktree post-merge cleanup** — the dance that
neither `await_pr_merge` nor `pr-finish.sh`'s default path handles cleanly for *this*
repo? Draft the section (a concrete artifact to react to), don't finalize it.

Known procedure (from repo memory + the just-completed PR #1022 / #1023 cleanup):

- This repo has ≈13 linked worktrees; `main` is checked out **only** in the primary
  worktree (`/Users/huangziyu/proj/video_generation`). So `git checkout main` in a
  feature worktree **fails** (`fatal: 'main' is already used by worktree at …`).
- After a successful merge:
  1. Detect the primary worktree: `git worktree list` (the entry whose branch is `main`
     / the default).
  2. Sync `main` in place — never top-level `cd` (`no-cd-drift.sh` blocks it):
     `git -C <primary-worktree> pull --ff-only`.
  3. In the feature worktree, retire to `main`'s tip:
     `git checkout --detach origin/main && git branch -D <feature-branch>`
     (squash merges are not a direct ancestor, so `git branch -d` refuses — use `-D`;
     content is identical, only the sha differs).
  4. Verify/report via `sweep_branches` (gh-confirmed merge only; review bucket for
     uncertain) — NOT `stale-branches.sh`.

Deliverable: a draft **"Post-merge cleanup (worktree-aware)"** section for
`skills/land-pr/SKILL.md`, written so the agent executes it with judgment (e.g. skip the
detach if the worktree is the primary; detect "main is in another worktree" before
trying `checkout main`). Raise fidelity; react to it before folding into the skill.

## Resolution

**Draft accepted as the basis for the skill's post-merge cleanup section.** Artifact:
[`drafts/post-merge-cleanup.md`](../drafts/post-merge-cleanup.md) — a 4-step worktree-aware
cleanup:

1. detect layout (`git worktree list` → primary vs feature worktree);
2. sync `main` in the primary worktree (`git -C <primary-worktree> pull --ff-only`);
3. retire the feature worktree (`git fetch --prune` → `git checkout --detach origin/main`
   → `git branch -D <branch>` — `-D` not `-d`, squash merges aren't a direct ancestor);
4. verify with `sweep_branches` (escalate anything in `review` to the human).

Plus the four footgun guards (fetch-before-detach; never `git checkout main` in a feature
worktree; `-D`-not-`-d`; trust `sweep_branches` not `stale-branches.sh`). Edge cases
covered: primary-is-current-worktree (skip the detach); `sweep_branches` `review`
escalation (same escape-hatch discipline as #03). Folds into `skills/land-pr/SKILL.md` at
build time (after #06). Accepted as the basis 2026-08-04.
