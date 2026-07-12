#!/usr/bin/env bash
# gh-setup.sh — register gh CLI aliases for the issue → PR workflow.
#
# Run once after cloning. Aliases are persisted in ~/.config/gh/config.yml.
# Re-run anytime to update.
#
# Usage:
#   bash scripts/gh-setup.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW="$SCRIPT_DIR/gh-workflow.sh"

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required (not on PATH)." >&2; exit 1; }

echo "◆ Registering gh aliases for video_generation__cli workflow…"
echo "  (all delegate to scripts/gh-workflow.sh)"
echo

# Aliases reference the absolute path so they work from any directory.
gh_alias() {
  local name="$1" cmd="$2"
  # Skip if already set to the same value
  local current
  current=$(gh alias list 2>/dev/null | grep "^${name}:" || true)
  local expected="${name}: !${WORKFLOW} ${cmd}"
  if [[ "$current" == "$expected" ]]; then
    echo "  ✓ ${name} — already set"
  else
    gh alias set "$name" "!${WORKFLOW} ${cmd}" --clobber
    echo "  ✓ ${name} — set"
  fi
}

gh_alias "bug"    "bug --web"
gh_alias "feat"   "feat --web"
gh_alias "prc"    "pr"
gh_alias "finish" "finish"
gh_alias "claim"  "develop"
gh_alias "list"   "list"

echo
echo "◆ Done. Available commands:"
echo
echo "  gh bug           — create a bug issue (opens in browser)"
echo "  gh feat           — create a feature issue (opens in browser)"
echo "  gh prc            — create PR (auto-link issue from branch name)"
echo "  gh prc --web      — create PR in browser"
echo "  gh finish <N>     — squash-merge PR #N + cleanup"
echo "  gh claim <N>      — create branch from issue #N (feat/42-slug or fix/42-slug)"
echo "  gh list           — list open issues"
echo
echo "  gh issue list     — (built-in gh) full issue list"
echo "  gh pr create      — (built-in gh) if you need fine-grained control"
echo
