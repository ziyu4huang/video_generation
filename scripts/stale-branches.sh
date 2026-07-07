#!/usr/bin/env bash
# List branch heads that are NOT in the keep-set and are safe to delete.
#
# Keep-set (NEVER proposed for deletion):
#   - main                       (the integration branch)
#   - the current branch         (HEAD)
#   - worktree-checked-out       (git forbids deleting these; the #332 lesson
#                                 is that our PROPOSALS must respect this too,
#                                 or the output gets noisy / dangerous)
#   - open-PR heads              (active work under review)
#
# Every other branch (local + remote) is reported as STALE with its PR state
# (merged / closed / no-PR). "merged" and "closed" branches are dead and safe
# to delete; "no-PR" branches are local experiments — review before deleting.
#
# Usage:
#   ./scripts/stale-branches.sh            # report only (default, exit 0)
#   ./scripts/stale-branches.sh --prune    # delete the stale branches (prompts)
#   ./scripts/stale-branches.sh --quiet    # only print the count
#
# This script NEVER deletes a branch checked out in a worktree it does not own.
set -euo pipefail

REMOTE="${REMOTE:-origin}"
PRUNE=false
QUIET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prune) PRUNE=true;  shift ;;
    --quiet) QUIET=true;  shift ;;
    -h|--help)
      sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

# --- resolve the keep-set -----------------------------------------------------

# Worktree-checked-out branches (local refs, may be "refs/heads/x" or "x").
WORKTREE_BRANCHES=$(git worktree list --porcelain 2>/dev/null \
  | awk '/^branch /{sub(/^refs\/heads\//,"",$2); print $2}' | sort -u)

# Open-PR head branch names (needs gh; degrades gracefully if absent).
OPEN_PR_HEADS=""
if command -v gh >/dev/null 2>&1; then
  OPEN_PR_HEADS=$(gh pr list --state open --json headRefName -q '.[].headRefName' 2>/dev/null | sort -u || true)
fi

is_kept() {
  # $1 = branch name (no remote prefix). Returns 0 if the branch is in the keep-set.
  local b="$1"
  [[ "$b" == "main" ]] && return 0
  [[ "$b" == "$(git rev-parse --abbrev-ref HEAD)" ]] && return 0
  grep -qxF "$b" <<<"$WORKTREE_BRANCHES" 2>/dev/null && return 0
  [[ -n "$OPEN_PR_HEADS" ]] && grep -qxF "$b" <<<"$OPEN_PR_HEADS" && return 0
  return 1
}

# pr_state <branch> -> echoes "merged #N" | "closed #N" | "no PR"
pr_state() {
  local b="$1"
  if [[ -z "$(command -v gh 2>/dev/null)" ]]; then
    # No gh: best-effort — "merged into main?" via contains.
    if git merge-base --is-ancestor "refs/heads/$b" "refs/remotes/${REMOTE}/main" 2>/dev/null \
       || git merge-base --is-ancestor "refs/remotes/${REMOTE}/$b" "refs/remotes/${REMOTE}/main" 2>/dev/null; then
      echo "merged (no-gh)"
    else
      echo "no PR (no-gh)"
    fi
    return
  fi
  local row
  row=$(gh pr list --state all --head "$b" --json number,state -q '.[0]|"\(.state) #\(.number)"' 2>/dev/null || true)
  if [[ -z "$row" ]]; then echo "no PR"; else echo "$(tr '[:upper:]' '[:lower:]' <<<"$row")"; fi
}

# --- scan local branches ------------------------------------------------------
# for-each-ref avoids the worktree "+" marker ambiguity; we re-check worktree
# membership via is_kept() (WORKTREE_BRANCHES) so a branch checked out in ANY
# worktree is never proposed.
STALE_LOCAL=()
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if is_kept "$name"; then continue; fi
  STALE_LOCAL+=("$name|$(pr_state "$name")")
done < <(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)

# --- scan remote branches -----------------------------------------------------
# for-each-ref lists only real branch refs (no symbolic origin/HEAD).
STALE_REMOTE=()
while IFS= read -r ref; do
  [[ -z "$ref" ]] && continue
  name="${ref#${REMOTE}/}"
  # Skip the bare remote-namespace ref ("origin") and main.
  [[ "$name" == "$REMOTE" || "$name" == "main" || "$name" == "HEAD" ]] && continue
  if is_kept "$name"; then continue; fi
  STALE_REMOTE+=("$name|$(pr_state "$name")")
done < <(git for-each-ref --format='%(refname:short)' refs/remotes/${REMOTE}/ 2>/dev/null)

# --- report -------------------------------------------------------------------

count=$(( ${#STALE_LOCAL[@]} + ${#STALE_REMOTE[@]} ))

if [[ "$QUIET" == true ]]; then
  echo "$count"
  exit 0
fi

if [[ $count -eq 0 ]]; then
  echo "✓ No stale branches. Keep-set (main / current / worktree-checked-out / open-PR) covers everything."
  exit 0
fi

echo "Stale branches (deletable): $count"
[[ ${#STALE_LOCAL[@]}  -gt 0 ]] && echo "  local:"
for entry in "${STALE_LOCAL[@]:-}"; do
  [[ -z "$entry" ]] && continue
  name="${entry%%|*}"; state="${entry#*|}"
  echo "    $name   $state"
done
[[ ${#STALE_REMOTE[@]} -gt 0 ]] && echo "  remote:"
for entry in "${STALE_REMOTE[@]:-}"; do
  [[ -z "$entry" ]] && continue
  name="${entry%%|*}"; state="${entry#*|}"
  echo "    ${REMOTE}/$name   $state"
done

if [[ "$PRUNE" == true ]]; then
  echo
  for entry in "${STALE_LOCAL[@]:-}"; do
    [[ -z "$entry" ]] && continue
    name="${entry%%|*}"
    echo "→ git branch -D $name"
    git branch -D "$name"
  done
  for entry in "${STALE_REMOTE[@]:-}"; do
    [[ -z "$entry" ]] && continue
    name="${entry%%|*}"
    echo "→ git push ${REMOTE} --delete $name"
    git push "$REMOTE" --delete "$name"
  done
  echo "✓ Pruned $count stale branch(es)."
fi
