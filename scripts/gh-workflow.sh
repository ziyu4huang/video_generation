#!/usr/bin/env bash
# gh-workflow.sh — convenience wrappers for the issue → PR workflow.
#
# Integrates with the repo's templates and branch naming convention.
#
# Usage:
#   ./scripts/gh-workflow.sh bug       # create a bug issue
#   ./scripts/gh-workflow.sh feat      # create a feature issue
#   ./scripts/gh-workflow.sh pr        # create a PR (auto-detect issue from branch)
#   ./scripts/gh-workflow.sh pr --web  # create a PR in browser (auto-fill issue)
#   ./scripts/gh-workflow.sh finish <pr>  # squash-merge + cleanup (delegates to devops-merge-pr-after-ci)
#   ./scripts/gh-workflow.sh list      # list open issues I can claim
#
# To set up gh aliases:
#   bash scripts/gh-setup.sh
#
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BASE_BRANCH="${BASE_BRANCH:-main}"

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required (not on PATH)." >&2; exit 1; }

# ─── helpers ────────────────────────────────────────────────────────────────────

# Extract issue number from the current branch name.
# Convention: fix/42-short-description or feat/100-short-description
# Returns "" if no number found.
branch_issue() {
  local branch
  branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  [[ -z "$branch" ]] && { echo ""; return; }
  # Match /<number>- or <number>- at the start of the branch name after the first /
  # e.g. fix/42-add → 42; feat/100-feature → 100; 123-hotfix → 123
  echo "$branch" | grep -oE '(^|/)([0-9]+)-' | head -1 | tr -d '/-' || echo ""
}

# Open an issue with the chosen template + label.
open_issue() {
  local label="$1" template="$2"
  shift 2
  gh issue create \
    --label "$label" \
    --template "$template" \
    "$@"
}

# ─── subcommands ────────────────────────────────────────────────────────────────

cmd_bug() {
  echo "◆ Creating a bug report…"
  open_issue "bug" "01-bug-report.md" "$@"
}

cmd_feat() {
  echo "◆ Creating a feature request…"
  open_issue "enhancement" "02-feature-request.md" "$@"
}

cmd_pr() {
  local issue_num
  issue_num=$(branch_issue)

  if [[ -n "$issue_num" ]]; then
    # Check that the issue exists and is open
    if gh issue view "$issue_num" --json state -q '.state' 2>/dev/null | grep -q "OPEN"; then
      echo "◆ Detected issue #${issue_num} from branch name."
    else
      echo "⚠  Branch suggests issue #${issue_num}, but it doesn't exist or is closed."
      echo "   The PR body will still reference it — verify before merging."
    fi
  else
    echo "⚠  No issue number found in branch name."
    echo "   Convention: feat/42-short-description or fix/42-short-description"
    echo "   Continuing without auto-linking…"
  fi

  # Build the PR body
  local body_file
  body_file=$(mktemp)
  # Start from the template
  cat .github/pull_request_template.md > "$body_file"
  # Replace the placeholder
  if [[ -n "$issue_num" ]]; then
    # Use sed to replace the placeholder line
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s/ISSUE_NUMBER/$issue_num/g" "$body_file"
      sed -i '' "s/#N/$issue_num/g" "$body_file"
    else
      sed -i "s/ISSUE_NUMBER/$issue_num/g" "$body_file"
      sed -i "s/#N/$issue_num/g" "$body_file"
    fi
  fi

  # Detect if --web was passed
  local web_flag=""
  local args=()
  for arg in "$@"; do
    if [[ "$arg" == "--web" ]]; then
      web_flag="--web"
    else
      args+=("$arg")
    fi
  done

  if [[ -n "$web_flag" ]]; then
    echo "◆ Opening browser to create PR…"
    gh pr create --body-file "$body_file" --web "${args[@]}"
  else
    echo "◆ Creating PR from command line (--fill = auto-title from commits)…"
    echo "  (Use --web to open the browser for richer editing.)"
    gh pr create --body-file "$body_file" --fill "${args[@]}"
  fi

  rm -f "$body_file"
}

cmd_finish() {
  local pr_number="${1:-}"
  if [[ -z "$pr_number" ]]; then
    echo "Usage: $0 finish <pr-number>" >&2
    exit 1
  fi
  shift
  echo "◆ Finishing PR #${pr_number} (delegating to devops-merge-pr-after-ci)…"
  exec bun "$(dirname "$0")/../bun-apps/s2-agent-ext-devops/src/merge-pr-after-ci-cli.ts" "$pr_number" "$@"
}

cmd_list() {
  echo "◆ Open issues:"
  gh issue list --limit 20 "$@"
  echo
  echo "  To claim one:   gh issue develop <number>"
  echo "  Or with a label: gh issue list --label bug"
}

cmd_develop() {
  local issue_num="${1:-}"
  if [[ -z "$issue_num" ]]; then
    echo "Usage: $0 develop <issue-number>" >&2
    exit 1
  fi

  echo "◆ Developing issue #${issue_num}…"

  # Fetch issue details
  local title labels
  title=$(gh issue view "$issue_num" --json title -q '.title' 2>/dev/null || echo "")
  labels=$(gh issue view "$issue_num" --json labels -q '[.[].name]|join(",")' 2>/dev/null || echo "")

  if [[ -z "$title" ]]; then
    echo "Issue #${issue_num} not found." >&2
    exit 1
  fi

  # Determine prefix from labels
  local prefix
  if echo "$labels" | grep -qi "bug"; then
    prefix="fix"
  else
    prefix="feat"
  fi

  # Slugify the title for a branch name
  local slug
  slug=$(echo "$title" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9 ]//g' \
    | tr ' ' '-' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//' \
    | cut -c1-60)

  local branch="${prefix}/${issue_num}-${slug}"

  echo "  Issue:  #${issue_num} — ${title}"
  echo "  Branch: ${branch}"
  echo "  Labels: ${labels:-none}"

  # Create the branch
  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    echo "  Branch '${branch}' already exists. Checking it out…"
    git checkout "${branch}"
  else
    git checkout -b "${branch}" "$REMOTE/$BASE_BRANCH"
    echo ""
    echo "  ✓ Branch created. Start coding!"
    echo "  When ready:  gh pr create  (or ./scripts/gh-workflow.sh pr)"
  fi
}

# ─── dispatch ───────────────────────────────────────────────────────────────────

case "${1:-help}" in
  bug|b)      shift; cmd_bug "$@" ;;
  feat|f)     shift; cmd_feat "$@" ;;
  pr|create)  shift; cmd_pr "$@" ;;
  finish|merge|m)  shift; cmd_finish "$@" ;;
  list|l)     shift; cmd_list "$@" ;;
  develop|dev|claim|d) shift; cmd_develop "$@" ;;
  help|h|-h|--help)
    sed -n '3,13p' "$0"
    echo
    echo "Aliases (after running scripts/gh-setup.sh):"
    echo "  gh bug       → create bug issue"
    echo "  gh feat      → create feature issue"
    echo "  gh prc       → create PR (auto-detect issue from branch name)"
    echo "  gh prc --web → create PR in browser"
    echo "  gh finish    → squash-merge + cleanup"
    echo "  gh list      → list open issues"
    echo "  gh claim <N> → create branch from issue #N (feat/42-slug or fix/42-slug)"
    ;;
  *)
    echo "Unknown subcommand: $1" >&2
    echo "Usage: $0 {bug|feat|pr|finish|list|develop}" >&2
    exit 1
    ;;
esac
