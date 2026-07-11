#!/usr/bin/env bash
# pr-finish.sh — squash-merge a PR and clean up its branch, worktree-safe.
#
# Encodes the verified post-review sequence distilled from the iter-3
# retrospective (PRs #488/#489/#493 all hit some subset of these gotchas):
#
#   1. preflight  — on the PR branch, clean tree, gh present, PR mergeable
#   2. checks     — wait for CI (gh pr checks --watch --fail-fast); abort on fail
#   3. merge      — gh pr merge --squash; if "head not up to date", sync the
#                   branch with origin/main, push, re-watch CI, retry the merge
#   4. cleanup    — detach at origin/main (NOT `git checkout main` — main is
#                   checked out in a sibling worktree, so that fails), delete the
#                   local + remote branch, fetch --prune
#   5. report     — stale-branches.sh (expect 0 stale) + HEAD
#
# Why no `--delete-branch` on `gh pr merge`: that flag tries to check out the
# base branch after deleting the head; in a multi-worktree repo `main` is already
# checked out elsewhere, so the checkout fails and leaves the local branch behind
# (the exact iter-3 "could not determine current branch" failure). We delete
# manually after detaching instead — deterministic in every repo layout.
#
# Usage:
#   ./scripts/pr-finish.sh <pr-number>             # do it
#   ./scripts/pr-finish.sh <pr-number> --dry-run   # print the sequence, mutate nothing
#   ./scripts/pr-finish.sh <pr-number> --no-checks # skip the CI watch (no CI on repo)
#
# Safety: set -euo pipefail; NEVER force-push; NEVER check out or reset main
# directly; refuse to proceed if the PR is not mergeable. The companion
# stale-branches.sh is called in REPORT mode only (no --prune) at the very end.
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BASE_BRANCH="${BASE_BRANCH:-main}"

# --- args ---------------------------------------------------------------------
DRY_RUN=false
NO_CHECKS=false
PR_NUMBER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --no-checks) NO_CHECKS=true ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then
        [[ "$arg" =~ ^[0-9]+$ ]] || { echo "Expected a PR number, got: $arg" >&2; exit 1; }
        PR_NUMBER="$arg"
      else
        echo "Unexpected extra arg: $arg" >&2; exit 1
      fi ;;
  esac
done
[[ -n "$PR_NUMBER" ]] || { echo "Usage: $0 <pr-number> [--dry-run] [--no-checks]" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required (not on PATH)." >&2; exit 1; }

# run/dry helper: echoes the command, executes only when not --dry-run.
run() { echo "→ $*"; [[ "$DRY_RUN" == true ]] || "$@"; }
say()  { echo; echo "■ $*"; }

# --- 1. preflight -------------------------------------------------------------
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
PR_HEAD=$(gh pr view "$PR_NUMBER" --json headRefName -q '.headRefName' 2>/dev/null) || {
  echo "Could not read PR #$PR_NUMBER (does it exist? are you authed to gh?)." >&2; exit 1; }

if [[ "$DRY_RUN" != true ]]; then
  [[ "$CURRENT_BRANCH" == "$PR_HEAD" ]] || {
    echo "You are on '$CURRENT_BRANCH', but PR #$PR_NUMBER head is '$PR_HEAD'." >&2
    echo "  → git checkout $PR_HEAD" >&2; exit 1; }
  [[ -z "$(git status --porcelain)" ]] || {
    echo "Working tree is dirty. Commit or stash first." >&2; exit 1; }
fi

# mergeStateStatus: BEHIND = needs base update (handled in step 3); BLOCKED /
# DIRTY = real problem. CLEAN / MERGEABLE / UNSTABLE(cI running) are OK.
STATE=$(gh pr view "$PR_NUMBER" --json mergeStateStatus -q '.mergeStateStatus' 2>/dev/null || echo "UNKNOWN")
say "Preflight OK — PR #$PR_NUMBER head='$PR_HEAD', on branch='$CURRENT_BRANCH', mergeStateStatus='$STATE'"
if [[ "$DRY_RUN" != true && "$STATE" == "BLOCKED" ]]; then
  echo "PR is BLOCKED (failing required review/check). Resolve it on GitHub, then retry." >&2; exit 1
fi

# --- 2. fetch + checks --------------------------------------------------------
run git fetch "$REMOTE" --prune

if [[ "$NO_CHECKS" == true ]]; then
  say "Skipping CI watch (--no-checks)."
else
  say "Watching CI on PR #$PR_NUMBER (gh pr checks --watch --fail-fast)…"
  if [[ "$DRY_RUN" != true ]]; then
    # If the repo has no checks configured, --watch exits non-zero immediately;
    # treat an empty check list as "nothing to wait for" rather than failure.
    if [[ -n "$(gh pr checks "$PR_NUMBER" 2>/dev/null)" ]]; then
      if ! gh pr checks "$PR_NUMBER" --watch --interval 15 --fail-fast; then
        echo "CI checks did not pass. Fix/rerun the failing job, then re-run this script." >&2
        exit 1
      fi
    else
      echo "  (no checks configured on this PR — nothing to watch)"
    fi
  fi
fi

# --- 3. merge (with base-update handling) -------------------------------------
# Returns: 0 = merged; 2 = "head not up to date" (base moved); 1 = other failure.
try_merge() {
  local err rc
  err=$(gh pr merge "$PR_NUMBER" --squash 2>&1 >/dev/null) && rc=0 || rc=$?
  # gh returns a non-zero code on the base-update error; detect the known message.
  if [[ $rc -ne 0 ]]; then
    if grep -qiE "up to date|out of date|outdated|behind" <<<"$err"; then
      echo "$err" >&2; return 2
    fi
    echo "$err" >&2; return 1
  fi
  return 0
}

say "Squash-merging PR #$PR_NUMBER…"
BASE_UPDATED=false
if [[ "$DRY_RUN" != true ]]; then
  try_merge && rc=0 || rc=$?
  if [[ $rc -eq 2 ]]; then
    BASE_UPDATED=true
    say "Base moved — syncing '$PR_HEAD' with $REMOTE/$BASE_BRANCH, then re-running CI…"
    run git merge "$REMOTE/$BASE_BRANCH" --no-edit
    run git push "$REMOTE" "$PR_HEAD"
    if [[ "$NO_CHECKS" != true ]]; then
      say "Re-watching CI after base-update…"
      [[ -n "$(gh pr checks "$PR_NUMBER" 2>/dev/null)" ]] \
        && { gh pr checks "$PR_NUMBER" --watch --interval 15 --fail-fast \
             || { echo "CI failed after base-update. Aborting." >&2; exit 1; }; }
    fi
    say "Re-merging…"
    try_merge && rc=0 || rc=$?
    [[ $rc -eq 0 ]] || { echo "Merge still failing after base-update. Inspect manually." >&2; exit 1; }
  elif [[ $rc -ne 0 ]]; then
    echo "Merge failed for a non-base-update reason. Inspect manually." >&2; exit 1
  fi
fi

# --- 4. cleanup (worktree-safe: detach, never `checkout main`) ----------------
say "Cleaning up branch '$PR_HEAD'…"
# Detach at the freshly-merged base tip — works whether or not main is in a worktree.
run git checkout --detach "$REMOTE/$BASE_BRANCH"
if [[ "$DRY_RUN" != true ]]; then
  git branch -D "$PR_HEAD" 2>/dev/null || true   # local (already gone if gh deleted it)
  git push "$REMOTE" --delete "$PR_HEAD" 2>/dev/null || true  # remote (idempotent)
  git fetch "$REMOTE" --prune
else
  echo "→ git branch -D $PR_HEAD"
  echo "→ git push $REMOTE --delete $PR_HEAD"
  echo "→ git fetch $REMOTE --prune"
fi

# --- 5. report ----------------------------------------------------------------
say "Done. Branch state:"
if [[ "$DRY_RUN" != true ]]; then
  "$(dirname "$0")"/stale-branches.sh || true   # report only — expect 0 stale
  echo
  echo "HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
  [[ "$BASE_UPDATED" == true ]] && echo "(note: base was auto-synced mid-merge)"
else
  echo "  (dry-run — nothing was changed)"
fi
