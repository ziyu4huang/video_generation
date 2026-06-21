#!/usr/bin/env bash
#
# scripts/list-gui-servers.sh
#
# Detect every running Bun GUI dev server across ALL git worktrees of this repo.
#
# Why this exists:
#   - `bun run gui:port --all` only lists *registered* servers (via
#     lib/worktree.ts' registry), so it misses servers started with an explicit
#     --port, unregistered ones, or orphans left by another session.
#   - The session-start git snapshot goes stale: a worktree may switch branch
#     after the session began, so `git worktree list` cached in context can lie.
#   This script queries the OS directly (ps + lsof + live `git branch`).
#
# Works on macOS's bundled bash 3.2 (no associative arrays / mapfile).
#
# Usage:
#   scripts/list-gui-servers.sh             # detect for the repo containing CWD
#   scripts/list-gui-servers.sh <path>      # detect for the repo containing <path>

set -o pipefail

REPO_COMMON="$(git -C "${1:-.}" rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -z "$REPO_COMMON" ]]; then
  echo "error: not inside a git worktree" >&2
  exit 1
fi
REPO_COMMON="$(cd "$REPO_COMMON" && pwd -P)"

# 1. Enumerate worktree paths (branch is queried LIVE below — do not trust the
#    branch field in `worktree list`, it reflects checkout time, not now).
WORKTREES="$(git -C "${1:-.}" worktree list --porcelain | awk '/^worktree /{print $2}')"

# 2. Collect every listening bun server: "<port> <pid> <cwd>" lines.
#    Listen sockets only — `bun run dev` (parent) doesn't listen, its child does.
SERVERS=""
while read -r pid port; do
  [[ -z "${pid:-}" ]] && continue
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{sub(/^n/,""); print; exit}')"
  [[ -z "$cwd" ]] && cwd="(unknown)"
  SERVERS+="${port} ${pid} ${cwd}"$'\n'
done < <(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
         | awk '$1=="bun"{p=$9; sub(/.*:/,"",p); print $2, p}')

# 3. Print one row per worktree.
printf "%-44s %-22s %-7s %-7s %-10s\n" "WORKTREE" "BRANCH" "PORT" "PID" "UPTIME"
printf '%.0s-' {1..95}; printf '\n'

while IFS= read -r wt; do
  [[ -z "$wt" ]] && continue
  wtnorm="$(cd "$wt" 2>/dev/null && pwd -P || printf '%s' "$wt")"
  branch="$(git -C "$wtnorm" branch --show-current 2>/dev/null || printf '(detached)')"
  found=0
  while IFS=' ' read -r sport spid scwd; do
    [[ -z "${sport:-}" ]] && continue
    # Match cwd under this worktree respecting the path boundary. A bare
    # "$scwd" == "$wtnorm"* would wrongly match /video_generation against a
    # server in /video_generation__gui, so require a trailing slash (or exact).
    if [[ "$scwd" == "$wtnorm" || "$scwd" == "$wtnorm/"* ]]; then
      up="$(ps -o etime= -p "$spid" 2>/dev/null | tr -d ' ' || printf '?')"
      printf "%-44s %-22s %-7s %-7s %-10s\n" "$wtnorm" "$branch" "$sport" "$spid" "$up"
      found=1
    fi
  done <<< "$SERVERS"
  if [[ "$found" -eq 0 ]]; then
    printf "%-44s %-22s %-7s %-7s %-10s\n" "$wtnorm" "$branch" "-" "-" "- none -"
  fi
done <<< "$WORKTREES"

printf '\nrepo: %s\n' "$REPO_COMMON"
