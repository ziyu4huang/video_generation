#!/usr/bin/env bash
# Rebase current worktree branch onto origin/main (default) or local main (--local).
# Usage: ./scripts/git-remote-main-sync.sh [--local] [--merge] [--remote <name>] [--base <branch>]
set -euo pipefail

REMOTE="origin"
BASE="main"
STRATEGY="rebase"
LOCAL_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)  LOCAL_ONLY=true; shift ;;
    --merge)  STRATEGY="merge"; shift ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --base)   BASE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

CURRENT=$(git rev-parse --abbrev-ref HEAD)
if [[ "${LOCAL_ONLY}" == true ]]; then
  TARGET="${BASE}"
else
  TARGET="${REMOTE}/${BASE}"
fi

echo "→ Current branch : ${CURRENT}"
echo "→ Syncing from   : ${TARGET}"
echo "→ Strategy       : ${STRATEGY}"
echo

# Bail out if there are uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ Uncommitted changes detected. Stash or commit before syncing."
  exit 1
fi

if [[ "${LOCAL_ONLY}" == false ]]; then
  echo "Fetching ${REMOTE}..."
  git fetch "${REMOTE}"
fi

AHEAD=$(git rev-list "${TARGET}..HEAD" --count)
BEHIND=$(git rev-list "HEAD..${TARGET}" --count)

echo "  ${CURRENT} is ${AHEAD} ahead / ${BEHIND} behind ${TARGET}"

if [[ "${BEHIND}" -eq 0 ]]; then
  echo "✓ Already up to date — nothing to do."
  exit 0
fi

if [[ "${STRATEGY}" == "rebase" ]]; then
  echo "Rebasing ${CURRENT} onto ${TARGET}..."
  git rebase "${TARGET}"
else
  echo "Merging ${TARGET} into ${CURRENT}..."
  git merge --no-edit "${TARGET}"
fi

echo
echo "✓ Sync complete."
git log --oneline -5
