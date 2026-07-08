#!/usr/bin/env bash
# Recursively sync this git repo AND every submodule (nested ones too).
#
# Default (no flags) — leaves the whole tree at a consistent, committed state:
#   1. git fetch --all --prune          refresh every remote of the superproject
#   2. fast-forward the current branch  only if it tracks a remote and can move
#                                       forward cleanly; NEVER creates merge commits
#   3. git submodule update             check out every submodule — nested ones too —
#       --init --recursive              at the SHA the superproject pins; uninitialized
#                                       submodules get cloned automatically
#
# This is safe to run any time on a clean tree. A dirty superproject working tree
# aborts the branch fast-forward but the submodule sync still runs (submodule
# update only touches submodule paths).
#
# Flags:
#   --remote           also advance each submodule to its latest remote-tracking tip
#                      (rewrites the recorded pointer → superproject shows dirty; commit it)
#   --pull             use `git pull` (merge) instead of fast-forward for the superproject
#   --rebase           rebase the current branch onto its upstream instead of fast-forward
#   --branch <name>    check out <name> first (tree must be clean), then sync
#   --no-submodules    skip the recursive submodule sync (superproject fetch + ff only)
#   --depth <n>        shallow depth for submodule init/update
#   --dry-run          print what would run; skip every mutating command
#   -h, --help         show this help
#
# Usage:
#   ./scripts/sync-repo.sh                  # safe default (fetch + ff + recursive submodules)
#   ./scripts/sync-repo.sh --remote         # also pull latest submodule tips
#   ./scripts/sync-repo.sh --branch main    # switch to main, then sync
#   ./scripts/sync-repo.sh --depth 1        # shallow submodules (CI / speed)
#   ./scripts/sync-repo.sh --no-submodules  # just the superproject
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STRATEGY="ff"            # ff | pull | rebase
REMOTE_MODE=false        # advance submodules to latest remote tips
SYNC_SUBMODULES=true
BRANCH=""
DEPTH=""
DRY_RUN=false

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed -e '/^set -euo pipefail$/d' -e 's/^#//' -e 's/^ //'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)        REMOTE_MODE=true;   shift ;;
    --pull)          STRATEGY="pull";    shift ;;
    --rebase)        STRATEGY="rebase";  shift ;;
    --branch)        BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --no-submodules) SYNC_SUBMODULES=false; shift ;;
    --depth)         DEPTH="${2:?--depth needs a value}"; shift 2 ;;
    --dry-run|-n)    DRY_RUN=true;       shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# run <label> <cmd...>  — echo then exec, unless --dry-run
run() {
  local label="$1"; shift
  echo "  $ ${label}"
  if [[ "$DRY_RUN" == true ]]; then
    echo "    (dry-run) skipped"
    return 0
  fi
  "$@"
}

need_clean_tree() {  # <why>
  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "✗ Uncommitted changes in $REPO_ROOT — $1" >&2
    echo "  Stash or commit first:  git -C \"$REPO_ROOT\" stash" >&2
    return 1
  fi
  return 0
}

echo "→ Repo: $REPO_ROOT"

# --- 0. Optional branch switch -------------------------------------------------
if [[ -n "$BRANCH" ]]; then
  if need_clean_tree "cannot switch branches"; then
    echo "→ Checking out $BRANCH …"
    run "git checkout $BRANCH" git -C "$REPO_ROOT" checkout "$BRANCH"
  else
    exit 1
  fi
fi

# --- 1. Fetch the superproject -------------------------------------------------
echo "→ Fetching remotes …"
run "git fetch --all --prune" git -C "$REPO_ROOT" fetch --all --prune

# --- 2. Advance the current branch (if it has an upstream) ---------------------
CURRENT="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT" == "HEAD" ]]; then
  echo "→ Detached HEAD — skipping branch advance (worktree checkout)."
else
  UPSTREAM="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -z "$UPSTREAM" ]]; then
    echo "→ Branch '$CURRENT' has no upstream — skipping branch advance."
  else
    AHEAD=$(git  -C "$REPO_ROOT" rev-list --count '@{u}..HEAD' 2>/dev/null || echo "?")
    BEHIND=$(git -C "$REPO_ROOT" rev-list --count 'HEAD..@{u}' 2>/dev/null || echo "?")
    echo "→ $CURRENT is ${AHEAD} ahead / ${BEHIND} behind ${UPSTREAM}"

    if [[ "$BEHIND" == "0" ]]; then
      echo "  ✓ Already up to date."
    else
      case "$STRATEGY" in
        ff)
          if [[ "$AHEAD" != "0" ]]; then
            echo "  ! Branch diverged (ahead=$AHEAD). Refusing force-merge; use --pull or --rebase."
          else
            if need_clean_tree "cannot fast-forward"; then
              run "git merge --ff-only '@{u}'" git -C "$REPO_ROOT" merge --ff-only '@{u}'
            fi
          fi ;;
        pull)
          if need_clean_tree "cannot pull"; then
            run "git pull --no-edit" git -C "$REPO_ROOT" pull --no-edit
          fi ;;
        rebase)
          if need_clean_tree "cannot rebase"; then
            run "git rebase '@{u}'" git -C "$REPO_ROOT" rebase '@{u}'
          fi ;;
      esac
    fi
  fi
fi

# --- 3. Sync submodules recursively -------------------------------------------
if [[ "$SYNC_SUBMODULES" == true ]]; then
  # Common args appended to every submodule command.
  sm_args=(--init --recursive)
  [[ -n "$DEPTH" ]] && sm_args+=(--depth "$DEPTH")

  if [[ "$REMOTE_MODE" == true ]]; then
    # Refresh each submodule's remote first, then move its checkout to the
    # latest tip of its configured branch (--remote). This rewrites the pointer
    # recorded in the superproject, so the superproject ends up dirty — commit it.
    echo "→ Fetching submodules (recursive) …"
    run "git submodule foreach --recursive git fetch --all --prune" \
        git -C "$REPO_ROOT" submodule foreach --recursive git fetch --all --prune

    echo "→ Advancing submodules to latest remote tip (--remote --recursive) …"
    run "git submodule update --remote --recursive" \
        git -C "$REPO_ROOT" submodule update "${sm_args[@]}" --remote
  else
    echo "→ Syncing submodules at pinned SHAs (--init --recursive) …"
    run "git submodule update --init --recursive" \
        git -C "$REPO_ROOT" submodule update "${sm_args[@]}"
  fi

  # Always ensure submodule metadata (.gitmodules) and actual checkouts agree.
  echo "→ Reconciling submodule paths …"
  run "git submodule sync --recursive" git -C "$REPO_ROOT" submodule sync --recursive

  echo
  echo "→ Submodule status:"
  git -C "$REPO_ROOT" submodule status --recursive | sed 's/^/    /'
fi

echo
echo "✓ Sync complete."
