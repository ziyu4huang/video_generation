#!/usr/bin/env bash
########################################
# sweep-merged-branches.sh — delete local branches whose work is already on the
# base branch (origin's default, usually main), INCLUDING squash-merged branches
# that `git branch --merged` cannot detect. Built for the multi-worktree setup:
# `main` lives in the main worktree, so `gh pr merge --delete-branch` cannot
# check it out in a feature worktree and local branches accumulate there.
#
# DETECTION — a branch is "merged" (deletable) if ANY of these hold:
#   (a) ancestor  — `git merge-base --is-ancestor <branch> <base>` (normal merge;
#                   the branch tip is contained in base).
#   (b) upstream gone — the branch's remote-tracking ref is `[gone]` (merged via
#                   a PR that deleted the remote branch, e.g. gh --delete-branch).
#                   This is the reliable signal for SQUASH-merged branches.
#   (c) patch-equivalent — `git cherry <base> <branch>` shows 0 commits marked
#                   `+` (every diff is already in base; catches single-commit
#                   squashes that have no upstream).
# Blind spot: a LOCAL-ONLY, multi-commit branch that was squash-merged without
# ever being pushed (no upstream to go `[gone]`, and cherry can't match a
# combined patch). Rare; the dry-run + review gate below is the safety net.
#
# SAFETY MODEL
#   DRY-RUN by default — lists what it WOULD delete, deletes nothing. Pass
#   --delete to actually remove the merged branches. Any branch with unmerged
#   work is LEFT UNTOUCHED and merely listed. The current branch, the base
#   branch, and any branch checked out in a worktree are never deleted.
#
# USAGE
#   ./scripts/sweep-merged-branches.sh                # dry-run: report only
#   ./scripts/sweep-merged-branches.sh --delete       # delete the merged ones
#   ./scripts/sweep-merged-branches.sh --base dev     # use a different base ref
#   ./scripts/sweep-merged-branches.sh -h|--help
#
# TIP: run `git fetch --prune` first so merged branches show `[gone]` accurately.
########################################
set -euo pipefail

# Default base = origin's default branch (origin/main typically), else origin/main.
BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
DELETE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete|-f|--apply) DELETE=1; shift ;;
    --base)    BASE="${2:?--base requires a ref}"; shift 2 ;;
    --base=*)  BASE="${1#--base=}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# Operate from the current worktree's top level (run from anywhere).
cd "$(git rev-parse --show-toplevel)"

git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1 \
  || { echo "base ref '$BASE' not found — run \`git fetch\` or pass --base=<ref>." >&2; exit 1; }

CURRENT="$(git symbolic-ref --short HEAD 2>/dev/null || true)"   # empty when detached
DEFAULT_LOCAL="${BASE#origin/}"                                  # e.g. main

# Branches checked out in SOME worktree — git refuses to delete these anyway;
# we classify them as protected up front so the report is honest.
WORKTREE_BRANCHES=()
while IFS= read -r line; do
  WORKTREE_BRANCHES+=("$line")
done < <(git worktree list --porcelain | awk '/^branch /{sub(/^refs\/heads\//,"",$2); print $2}')

in_list() { local x="$1"; shift; local i; for i in "$@"; do [[ "$i" == "$x" ]] && return 0; done; return 1; }
protected() {
  local b="$1"
  [[ "$b" == "$CURRENT" ]] && return 0
  [[ "$b" == "$DEFAULT_LOCAL" ]] && return 0
  [[ "$b" == "main" || "$b" == "master" ]] && return 0
  in_list "$b" "${WORKTREE_BRANCHES[@]+"${WORKTREE_BRANCHES[@]}"}" && return 0
  return 1
}

# Echo "merged" if the branch's work is in $BASE (see DETECTION above), else
# "unmerged:<N>" where N is the count of unmerged-by-patch commits (for display).
classify() {
  local b="$1"
  # (a) normal merge — tip is an ancestor of base.
  if git merge-base --is-ancestor "$b" "$BASE" 2>/dev/null; then echo "merged"; return; fi
  # (b) upstream gone — merged via a PR that deleted the remote branch.
  local track; track="$(git for-each-ref --format='%(upstream:track)' "refs/heads/$b" 2>/dev/null)"
  if [[ "$track" == *gone* ]]; then echo "merged"; return; fi
  # (c) patch-equivalent — every commit's diff is already in base.
  local plus; plus="$(git cherry "$BASE" "$b" 2>/dev/null | grep -c '^+' || true)"
  if [[ "$plus" -eq 0 ]]; then echo "merged"; return; fi
  echo "unmerged:$plus"
}

MERGED=(); KEEP=(); SKIP=()
while IFS= read -r b; do
  [[ -z "$b" ]] && continue
  if protected "$b"; then SKIP+=("$b"); continue; fi
  c="$(classify "$b")"
  case "$c" in
    merged)        MERGED+=("$b") ;;
    unmerged:*)    KEEP+=("$b (${c#unmerged:} unmerged)") ;;
  esac
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

echo "base: $BASE   mode: $([ "$DELETE" = 1 ] && echo DELETE || echo DRY-RUN)"
echo
if [[ ${#MERGED[@]} -gt 0 ]]; then
  echo "MERGED — safe to delete (work is in $BASE via ancestor / upstream-gone / patch-equiv):"
  printf '  %s\n' "${MERGED[@]}"
else
  echo "MERGED: (none)"
fi
[[ ${#KEEP[@]} -gt 0 ]] && { echo; echo "UNMERGED — left untouched:"; printf '  %s\n' "${KEEP[@]}"; }
[[ ${#SKIP[@]} -gt 0 ]]  && { echo; echo "PROTECTED (current / base / in-a-worktree) — skipped:"; printf '  %s\n' "${SKIP[@]}"; }

if [[ "$DELETE" -eq 1 ]] && [[ ${#MERGED[@]} -gt 0 ]]; then
  echo
  git branch -D "${MERGED[@]}"
  echo "deleted ${#MERGED[@]} merged branch(es)."
elif [[ "$DELETE" -eq 0 ]] && [[ ${#MERGED[@]} -gt 0 ]]; then
  echo
  echo "dry-run — re-run with --delete to remove the MERGED branches listed above."
fi
