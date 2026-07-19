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
#   --full             MOST COMPLETE SYNC: advance the DEFAULT BRANCH everywhere (superproject
#                      + every submodule recursively), fetch all remotes, pull --ff-only in each
#                      repo, then report alignment. The default branch is AUTO-DETECTED per repo
#                      via origin/HEAD (never hardcoded main/master), so a submodule on `master`
#                      or `develop` is handled correctly. Worktree-aware: if the default branch is
#                      checked out in another worktree, it is advanced there (this worktree stays
#                      on its branch) instead of fatal-ing on `git checkout`. Aborts only if a
#                      repo that needs to switch branches has uncommitted changes.
#                      This is the "everything to latest default branch" button.
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
#   ./scripts/sync-repo.sh --full           # everything to latest default branch (superproject + submodules)
#   ./scripts/sync-repo.sh --remote         # also pull latest submodule tips
#   ./scripts/sync-repo.sh --branch main    # switch to main, then sync
#   ./scripts/sync-repo.sh --depth 1        # shallow submodules (CI / speed)
#   ./scripts/sync-repo.sh --no-submodules  # just the superproject
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Absolute path to THIS script — exported so `git submodule foreach` child shells can
# re-invoke it in lib mode (--detect-default-branch) for per-submodule default-branch
# detection, reusing the SAME logic as the superproject (no duplicated branch-guessing).
export SELF_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

STRATEGY="ff"            # ff | pull | rebase
REMOTE_MODE=false        # advance submodules to latest remote tips
FULL_SYNC=false          # --full: checkout default branch + pull everywhere
SYNC_SUBMODULES=true
BRANCH=""
DEPTH=""
DRY_RUN=false

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed -e '/^set -euo pipefail$/d' -e 's/^#//' -e 's/^ //'; }

# Detect the remote default branch of <repo-dir>; print its short name
# ("main", "master", "develop", "release/v2", …). Resolution order:
#   1. local origin/HEAD symbolic ref  (offline; set by clone / `git remote set-head -a`)
#   2. `git remote show origin`         (network; parses "HEAD branch: <name>")
#   3. hard fallback "main"
# Only the leading remote prefix is stripped ("origin/main" → "main", "origin/release/v2"
# → "release/v2"). Exposed as a lib-mode flag so `git submodule foreach` child shells reuse
# this exact logic: `sync-repo.sh --detect-default-branch [dir]`.
detect_default_branch() {  # <repo-dir>
  local repo="${1:-.}" db
  db="$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  db="${db#*/}"   # strip leading remote prefix: origin/main → main
  if [[ -n "$db" ]]; then echo "$db"; return 0; fi
  db="$(git -C "$repo" remote show origin 2>/dev/null \
        | awk '/HEAD branch:/ {print $NF; exit}' || true)"
  if [[ -n "$db" ]]; then echo "$db"; return 0; fi
  echo "main"
}

# Verify the local default-branch ref equals origin/<branch>; return 1 with a clear
# message if not. Called at the end of --full's superproject sync to turn the OLD
# silent-success footgun (advance skipped because the worktree holding the default
# branch is dirty/paused, or this worktree's branch has no upstream → "✓ Sync
# complete" + exit 0 while local main is still behind origin) into a LOUD failure.
# Reads shared refs only — main advances wherever the worktree that holds it runs
# the pull, so this check is correct from any worktree of the same repo.
verify_default_at_latest() {  # <repo> <branch>
  local repo="${1:?repo}" branch="${2:?branch}" local_sha remote_sha behind ahead
  # --verify -q: on a missing ref prints nothing to stdout + exits non-zero
  # (a bare `git rev-parse <ref>` would echo the ref NAME to stdout, masking the
  # missing-ref case as a non-empty string).
  remote_sha="$(git -C "$repo" rev-parse --verify -q "origin/$branch" 2>/dev/null || true)"
  if [[ -z "$remote_sha" ]]; then
    echo "✗ --full: cannot resolve 'origin/$branch' — is remote 'origin' fetched?" >&2
    return 1
  fi
  local_sha="$(git -C "$repo" rev-parse --verify -q "$branch" 2>/dev/null || true)"
  if [[ "$local_sha" != "$remote_sha" ]]; then
    behind=$(git -C "$repo" rev-list --count "$branch..origin/$branch" 2>/dev/null || echo "?")
    ahead=$( git -C "$repo" rev-list --count "origin/$branch..$branch" 2>/dev/null || echo "?")
    echo "✗ --full FAILED: default branch '$branch' is NOT at latest remote." >&2
    echo "    local  $branch         = ${local_sha:0:12}  (ahead $ahead / behind $behind)" >&2
    echo "    remote origin/$branch  = ${remote_sha:0:12}" >&2
    echo "  The advance was skipped — usually the worktree holding '$branch' has" >&2
    echo "  uncommitted changes or a paused git op. Resolve it there, then re-run." >&2
    return 1
  fi
  return 0
}

# Lib mode: resolve + print the default branch for <dir> (default: cwd), then exit.
# Lets every submodule reuse the superproject's detection via `git submodule foreach`.
if [[ "${1:-}" == "--detect-default-branch" ]]; then
  detect_default_branch "${2:-.}"
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)          FULL_SYNC=true; REMOTE_MODE=true; STRATEGY="pull"; shift ;;
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

# worktree owning <branch> — prints the absolute path of the worktree that has
# <branch> checked out, or empty if no worktree is on it. The current worktree is
# included in the search. Used by --full so it never checks the default branch out
# into a worktree that can't hold it (busy elsewhere).
worktree_for_branch() {  # <branch>
  git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null \
    | awk -v b="refs/heads/$1" '/^worktree /{wt=$2} /^branch /{if($2==b) print wt}'
}

# Detect a PAUSED git operation (rebase/merge/cherry-pick/revert/bisect) in <repo-dir>.
# Echoes a short label + returns 0 if one is in progress; returns 1 otherwise.
# Why this exists: a paused operation makes the tree look "dirty", but the correct
# fix is `--continue`/`--abort` — NOT `stash`/`checkout`, which can DESTROY the
# in-progress work. Callers MUST check this before any mutating command. Resolves
# the real git-dir via `--absolute-git-dir` (handles worktrees + submodules whose
# .git is a file pointer, not a directory).
in_progress_op() {  # <repo-dir>
  local repo="${1:-.}" gd
  gd="$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  [[ -d "$gd/rebase-merge"     ]] && { echo "interactive rebase"; return 0; }
  [[ -d "$gd/rebase-apply"     ]] && { echo "rebase / git am";   return 0; }
  [[ -f "$gd/MERGE_HEAD"       ]] && { echo "merge";             return 0; }
  [[ -f "$gd/CHERRY_PICK_HEAD" ]] && { echo "cherry-pick";       return 0; }
  [[ -f "$gd/REVERT_HEAD"      ]] && { echo "revert";            return 0; }
  [[ -f "$gd/BISECT_LOG"       ]] && { echo "bisect";            return 0; }
  return 1
}

# --- Pre-flight: refuse to touch a superproject with a paused operation -------
# Runs before ANY mutation (--full checkout/pull, branch switch, ff, submodule
# update are all unsafe mid-rebase). Surfaces the exact op + recovery command
# instead of the old misleading "uncommitted changes" message.
if op="$(in_progress_op "$REPO_ROOT")"; then
  echo "✗ Paused git operation in superproject ($REPO_ROOT): $op" >&2
  echo "  This is NOT ordinary dirty state — stash/checkout can destroy the work." >&2
  echo "  Resolve it first:" >&2
  echo "    git -C \"$REPO_ROOT\" status            # see the paused op" >&2
  echo "    git -C \"$REPO_ROOT\" rebase --continue # (or: rebase --abort | merge --continue | cherry-pick --continue)" >&2
  exit 1
fi

# --- 0a. --full: advance superproject default branch (worktree-aware) ---------
# Old behavior blindly ran `git checkout main`, which fatals with
#   "fatal: '<branch>' is already used by worktree at <path>"
# in any repo that keeps the default branch checked out in a dedicated worktree.
# Instead: if the default branch already lives in another worktree, advance it
# THERE and leave the current worktree on its branch. Only check it out here when
# it's free. (Branch name is auto-detected — see detect_default_branch above.)
if [[ "$FULL_SYNC" == true ]]; then
  DEFAULT_BRANCH="$(detect_default_branch "$REPO_ROOT")"
  echo "→ --full mode: syncing everything to latest '$DEFAULT_BRANCH' (auto-detected)"
  CURRENT_FF="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [[ "$CURRENT_FF" == "$DEFAULT_BRANCH" ]]; then
    : # already on the default branch — sections 1–2 will fetch + advance it in this worktree
  else
    MAIN_WT="$(worktree_for_branch "$DEFAULT_BRANCH")"
    if [[ -n "$MAIN_WT" && "$MAIN_WT" != "$REPO_ROOT" ]]; then
      # default branch is checked out in another worktree — don't hijack it into this one.
      echo "→ '$DEFAULT_BRANCH' is checked out in another worktree:"
      echo "    $MAIN_WT"
      echo "  Advancing '$DEFAULT_BRANCH' there; keeping this worktree on '$CURRENT_FF'."
      if op="$(in_progress_op "$MAIN_WT")"; then
        echo "  ⚠ $MAIN_WT has a paused git op ($op) — '$DEFAULT_BRANCH' not advanced there." >&2
      elif git -C "$MAIN_WT" diff --quiet && git -C "$MAIN_WT" diff --cached --quiet; then
        run "git -C \"$MAIN_WT\" pull --ff-only origin $DEFAULT_BRANCH" \
            git -C "$MAIN_WT" pull --ff-only origin "$DEFAULT_BRANCH"
      else
        echo "  ⚠ $MAIN_WT has uncommitted changes — '$DEFAULT_BRANCH' not advanced there." >&2
      fi
    else
      # default branch is free (not checked out in any worktree) — check it out here.
      if need_clean_tree "cannot switch to $DEFAULT_BRANCH"; then
        echo "→ Switching superproject to '$DEFAULT_BRANCH' …"
        run "git checkout $DEFAULT_BRANCH" git -C "$REPO_ROOT" checkout "$DEFAULT_BRANCH"
      else
        exit 1
      fi
    fi
  fi
fi

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

# --- 2b. --full guard: superproject default branch MUST be at latest remote ----
# The whole point of --full is "everything to latest default branch". The advance
# above can be SILENTLY skipped — the sibling worktree holding the default branch
# is dirty/paused (section 0a), or this worktree's branch has no upstream
# (section 2) — leaving local main behind origin while the OLD code still printed
# "✓ Sync complete" + exit 0. That silent success is the footgun the user hit.
# verify_default_at_latest() fails loudly instead. Skipped under --dry-run because
# the (skipped) advance never ran, so the refs legitimately don't match yet.
if [[ "$FULL_SYNC" == true && "$DRY_RUN" == false ]]; then
  if ! verify_default_at_latest "$REPO_ROOT" "$DEFAULT_BRANCH"; then
    if [[ -n "${MAIN_WT:-}" ]]; then
      echo "    check:  git -C "${MAIN_WT}" status" >&2
    fi
    exit 1
  fi
fi

# --- 3. Sync submodules recursively -------------------------------------------
if [[ "$SYNC_SUBMODULES" == true ]]; then
  # Common args appended to every submodule command.
  sm_args=(--init --recursive)
  [[ -n "$DEPTH" ]] && sm_args+=(--depth "$DEPTH")

  # Pre-flight: detect a PAUSED git operation in ANY submodule (recursive).
  # `git submodule update` can't safely skip a single paused submodule, and
  # advancing the superproject pointer past a mid-operation checkout can destroy
  # the in-progress work (the exact footgun that bit this repo on 2026-07-16).
  # foreach cd's into each submodule, so `pwd` yields its ABSOLUTE path — correct
  # even for NESTED submodules (whose $sm_path is relative to the parent, not
  # top-level; $REPO_ROOT/$sm_path would silently miss them).
  BLOCKED_SM=""
  while IFS= read -r sm; do
    [[ -z "$sm" ]] && continue
    if op="$(in_progress_op "$sm")"; then
      echo "  ⚠ $sm: paused git op ($op) — checkout/update would be UNSAFE"
      BLOCKED_SM+="${sm}"$'
'
    fi
  done < <(git -C "$REPO_ROOT" submodule --quiet foreach --recursive 'pwd' 2>/dev/null)
  if [[ -n "$BLOCKED_SM" ]]; then
    echo "✗ Paused git operation in submodule(s); skipping checkout/update." >&2
    echo "  A paused op is NOT ordinary dirty state — stash/checkout can destroy work." >&2
    echo "  Resolve each, then re-run:" >&2
    echo "    git -C \"<submodule>\" status            # see the paused op" >&2
    echo "    git -C \"<submodule>\" rebase --continue # (or --abort / merge --continue / cherry-pick --continue)" >&2
  elif [[ "$FULL_SYNC" == true ]]; then
    # --full: checkout each submodule's DEFAULT branch (auto-detected per submodule) + pull.
    echo "→ --full: fetching submodules (recursive) …"
    run "git submodule foreach --recursive git fetch --all --prune" \
        git -C "$REPO_ROOT" submodule foreach --recursive git fetch --all --prune

    echo "→ --full: checkout default branch + pull --ff-only in each submodule …"
    run "git submodule foreach --recursive '<detect-default-branch>; checkout; pull --ff-only>'" \
        git -C "$REPO_ROOT" submodule foreach --recursive 'db="$(bash "$SELF_PATH" --detect-default-branch . 2>/dev/null || echo main)"; git checkout "$db" 2>/dev/null || true; git pull --ff-only origin "$db" 2>&1 | tail -3'

    # Advance the recorded pointers to the new HEADs.
    echo "→ --full: updating submodule pointers …"
    run "git submodule update --remote --recursive" \
        git -C "$REPO_ROOT" submodule update "${sm_args[@]}" --remote

  elif [[ "$REMOTE_MODE" == true ]]; then
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

  # --full: report HEAD vs each submodule's default remote + warn about local changes
  if [[ "$FULL_SYNC" == true ]]; then
    echo
    echo "→ Alignment report (HEAD vs each submodule's default remote):"
    git -C "$REPO_ROOT" submodule foreach --recursive \
      'db="$(bash "$SELF_PATH" --detect-default-branch . 2>/dev/null || echo main)"; local_sha=$(git rev-parse --short HEAD); remote_sha=$(git rev-parse --short "origin/$db" 2>/dev/null || echo "?"); if [[ "$local_sha" == "$remote_sha" ]]; then status="✓"; else status="⚠"; fi; echo "    $name: HEAD=$local_sha $db=$remote_sha $status"' 2>&1 | grep -v '^Entering'

    echo
    echo "→ Local changes check:"
    local_changes=false
    while IFS= read -r sm_path; do
      [[ -z "$sm_path" ]] && continue
      changes=$(git -C "$REPO_ROOT/$sm_path" status --short 2>/dev/null)
      if [[ -n "$changes" ]]; then
        echo "    ⚠ $sm_path has uncommitted changes:"
        echo "$changes" | sed 's/^/        /'
        local_changes=true
      fi
    done < <(git -C "$REPO_ROOT" submodule --quiet foreach 'echo "$name"')
    if [[ "$local_changes" == false ]]; then
      echo "    ✓ All submodules clean."
    fi
  fi
fi

echo
echo "✓ Sync complete."
