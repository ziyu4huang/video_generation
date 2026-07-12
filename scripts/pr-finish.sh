#!/usr/bin/env bash
# pr-finish.sh — squash-merge a PR and clean up its branch, worktree-safe.
#
# Encodes the verified post-review sequence distilled from the iter-3
# retrospective (PRs #488/#489/#493 all hit some subset of these gotchas):
#
#   1. preflight  — on the PR branch, clean tree, gh present, PR mergeable
#   2. checks     — poll for check registration, then watch ALL checks to a FINAL
#                    state; merge only if the final aggregate is green (NO
#                    --fail-fast). Preflight does NOT abort while CI is running.
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
CHECKS_REGISTER_TIMEOUT="${CHECKS_REGISTER_TIMEOUT:-30}"
SAW_CHECKS=false   # set true by step 2 when CI checks actually exist

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

# --- CI gate helpers ----------------------------------------------------------
# ci_running <pr> → 0 (true) if any check is in a NON-terminal (running/pending)
# state. Terminal = SUCCESS / NEUTRAL / SKIPPED / FAILURE / STARTUP_FAILURE /
# CANCELLED / TIMED_OUT / ACTION_REQUIRED. Anything else (PENDING / QUEUED /
# IN_PROGRESS / WAITING / unknown) means CI is still in flight.
ci_running() {
  local n
  n=$(gh pr checks "$1" --json state 2>/dev/null \
      -q '[.[]|select(.state!="SUCCESS" and .state!="NEUTRAL" and .state!="SKIPPED" and .state!="FAILURE" and .state!="STARTUP_FAILURE" and .state!="CANCELLED" and .state!="TIMED_OUT" and .state!="ACTION_REQUIRED")]|length' \
      2>/dev/null || echo 0)
  [[ -n "$n" && "$n" -gt 0 ]]
}

# wait_ci <pr> <required> → poll for check registration (≤ CHECKS_REGISTER_TIMEOUT),
# then watch ALL checks to a terminal state (plain --watch, NOT --fail-fast) and
# gate on the FINAL JSON aggregate (no transient-flake false-aborts — iter-8).
#   required=false → if no checks register in time, assume "no CI configured" and
#                    return 0 (merge proceeds). Sets SAW_CHECKS=true when CI exists.
#   required=true  → checks are KNOWN to exist (watched in step 2); if they don't
#                    re-register after a base-update push, ABORT (iter-4 race).
wait_ci() {
  local pr="$1" required="${2:-false}" bad deadline
  # Registration poll: right after a push GitHub hasn't created the check runs
  # yet, so `gh pr checks` is briefly empty. Wait for them to appear.
  if [[ -z "$(gh pr checks "$pr" 2>/dev/null)" ]]; then
    deadline=$(( $(date +%s) + CHECKS_REGISTER_TIMEOUT ))
    while [[ -z "$(gh pr checks "$pr" 2>/dev/null)" ]]; do
      if [[ $(date +%s) -ge $deadline ]]; then break; fi
      sleep 3
    done
    if [[ -z "$(gh pr checks "$pr" 2>/dev/null)" ]]; then
      if [[ "$required" == true ]]; then
        echo "CI checks did not register within ${CHECKS_REGISTER_TIMEOUT}s. Aborting." >&2
        return 1
      fi
      echo "  (no checks detected within ${CHECKS_REGISTER_TIMEOUT}s — assuming none configured; use --no-checks to skip this wait)" >&2
      return 0
    fi
  fi
  SAW_CHECKS=true
  gh pr checks "$pr" --watch --interval 15 || true   # wait for all; exit code ignored
  bad=$(gh pr checks "$pr" --json state \
        -q '[.[]|select(.state!="SUCCESS" and .state!="NEUTRAL" and .state!="SKIPPED")]|length' \
        2>/dev/null || echo "?")
  if [[ "$bad" != "0" ]]; then
    echo "CI not all-green after watch ($bad non-passing check(s)). Inspect: gh pr checks $pr" >&2
    return 1
  fi
}

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

# mergeStateStatus: BEHIND = needs base update (handled in step 3); DIRTY = real
# problem; BLOCKED = conditional (ci_running → fall through to watch; else a
# real block — failing check / missing review; see the BLOCKED branch below).
# CLEAN / MERGEABLE / UNSTABLE (CI running) are OK.
STATE=$(gh pr view "$PR_NUMBER" --json mergeStateStatus -q '.mergeStateStatus' 2>/dev/null || echo "UNKNOWN")
say "Preflight OK — PR #$PR_NUMBER head='$PR_HEAD', on branch='$CURRENT_BRANCH', mergeStateStatus='$STATE'"
if [[ "$DRY_RUN" != true && "$STATE" == "BLOCKED" ]]; then
  # BLOCKED can be transient (a required check still running) or a real block
  # (failing check / missing required review). If CI is still in flight, fall
  # through to the step-2 watch — wait_ci waits for completion and gates. If CI
  # is already complete, it's a real non-CI block. (iter-9: the old hard-abort
  # false-fired while checks were still running.)
  if ci_running "$PR_NUMBER"; then
    say "BLOCKED but CI still running — will watch to completion (step 2)."
  else
    echo "PR is BLOCKED and CI is complete (failing check or missing required review). Resolve on GitHub, then retry." >&2; exit 1
  fi
fi

# --- 2. fetch + checks --------------------------------------------------------
run git fetch "$REMOTE" --prune

if [[ "$NO_CHECKS" == true ]]; then
  say "Skipping CI watch (--no-checks)."
else
  say "Watching CI on PR #$PR_NUMBER (wait for ALL checks; tolerate transient flakes)…"
  if [[ "$DRY_RUN" != true ]]; then
    wait_ci "$PR_NUMBER" false || exit 1
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

say "Squash-merging PR #${PR_NUMBER}…"
BASE_UPDATED=false
if [[ "$DRY_RUN" != true ]]; then
  try_merge && rc=0 || rc=$?
  if [[ $rc -eq 2 ]]; then
    BASE_UPDATED=true
    say "Base moved — syncing '$PR_HEAD' with $REMOTE/$BASE_BRANCH, then re-running CI…"
    run git merge "$REMOTE/$BASE_BRANCH" --no-edit
    run git push "$REMOTE" "$PR_HEAD"
    if [[ "$NO_CHECKS" != true && "$SAW_CHECKS" == true ]]; then
      say "Re-watching CI after base-update…"
      # wait_ci(required=true) re-polls for registration (CI existed in step 2,
      # so it MUST re-register after the base-update push) then watches + gates.
      wait_ci "$PR_NUMBER" true || { echo "CI failed after base-update. Aborting." >&2; exit 1; }
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
# Fetch FIRST so the local origin/main ref reflects the squash-merge we just did
# — otherwise the detach below uses the step-2 (pre-merge) ref and HEAD lands
# one commit behind. (Found by dogfooding: pr-finish.sh left HEAD at the
# previous PR's merge commit.)
run git fetch "$REMOTE" --prune
# Detach at the freshly-merged base tip — works whether or not main is in a worktree.
run git checkout --detach "$REMOTE/$BASE_BRANCH"
if [[ "$DRY_RUN" != true ]]; then
  git branch -D "$PR_HEAD" 2>/dev/null || true   # local (already gone if gh deleted it)
  git push "$REMOTE" --delete "$PR_HEAD" 2>/dev/null || true  # remote (idempotent)
else
  echo "→ git branch -D $PR_HEAD"
  echo "→ git push $REMOTE --delete $PR_HEAD"
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
