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
#   ./scripts/stale-branches.sh --prune --force   # ALSO delete RECENT branches
#
# Concurrent-agent safety: in a multi-worktree/multi-agent repo, an un-PR'd
# branch whose latest commit is recent (≤ RECENT_DAYS, default 7) is almost
# certainly ACTIVE work from another session — the keep-set heuristics
# (worktree-checked-out / open-PR) miss it. --prune NEVER deletes such branches
# unless --force is given; the report flags them ⚠ recent.
# (Hard-won lesson: this script once force-deleted active unmerged work —
# fix/selfimprove-loop-hardening — because it lacked a recency guard.)
# Override the window with RECENT_DAYS=N.
#
# This script NEVER deletes a branch checked out in a worktree it does not own.
set -euo pipefail

REMOTE="${REMOTE:-origin}"
PRUNE=false
QUIET=false
FORCE=false
RECENT_DAYS="${RECENT_DAYS:-7}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prune) PRUNE=true;  shift ;;
    --quiet) QUIET=true;  shift ;;
    --force) FORCE=true;  shift ;;
    -h|--help)
      awk '/^set -euo pipefail/{exit} NR>1' "$0"; exit 0 ;;
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

# --- concurrent-agent recency guard -----------------------------------------
# A branch whose latest commit is ≤ RECENT_DAYS old is almost certainly ACTIVE
# work from another session, even with no open PR and not checked out anywhere
# right now. --prune refuses to delete these unless --force.
ref_age_days() {  # $1 = full ref (refs/heads/x | refs/remotes/<remote>/x)
  local ct
  ct=$(git log -1 --format=%ct "$1" 2>/dev/null || true)
  [[ -z "$ct" ]] && { echo ""; return; }
  echo $(( ( $(date +%s) - ct ) / 86400 ))
}
is_recent_local()  { local d; d=$(ref_age_days "refs/heads/$1");            [[ -n "$d" && "$d" -le "$RECENT_DAYS" ]]; }
is_recent_remote() { local d; d=$(ref_age_days "refs/remotes/${REMOTE}/$1"); [[ -n "$d" && "$d" -le "$RECENT_DAYS" ]]; }

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
  if is_recent_local "$name"; then
    echo "    $name   $state   ⚠ recent (≤${RECENT_DAYS}d — likely active; kept without --force)"
  else
    echo "    $name   $state"
  fi
done
[[ ${#STALE_REMOTE[@]} -gt 0 ]] && echo "  remote:"
for entry in "${STALE_REMOTE[@]:-}"; do
  [[ -z "$entry" ]] && continue
  name="${entry%%|*}"; state="${entry#*|}"
  if is_recent_remote "$name"; then
    echo "    ${REMOTE}/$name   $state   ⚠ recent (≤${RECENT_DAYS}d — likely active; kept without --force)"
  else
    echo "    ${REMOTE}/$name   $state"
  fi
done

if [[ "$PRUNE" == true ]]; then
  echo
  for entry in "${STALE_LOCAL[@]:-}"; do
    [[ -z "$entry" ]] && continue
    name="${entry%%|*}"
    if is_recent_local "$name" && [[ "$FORCE" != true ]]; then
      echo "⚠ keep $name — latest commit ≤${RECENT_DAYS}d (concurrent-agent safety); --force to override."
      continue
    fi
    echo "→ git branch -D $name"
    git branch -D "$name"
  done
  for entry in "${STALE_REMOTE[@]:-}"; do
    [[ -z "$entry" ]] && continue
    name="${entry%%|*}"
    if is_recent_remote "$name" && [[ "$FORCE" != true ]]; then
      echo "⚠ keep ${REMOTE}/$name — latest commit ≤${RECENT_DAYS}d (concurrent-agent safety); --force to override."
      continue
    fi
    echo "→ git push ${REMOTE} --delete $name"
    git push "$REMOTE" --delete "$name"
  done
  echo "✓ Pruned stale branch(es) (recent ones kept; use --force to include them)."
fi
