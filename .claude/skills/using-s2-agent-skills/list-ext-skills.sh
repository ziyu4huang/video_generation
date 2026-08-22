#!/usr/bin/env bash
# List every reusable skill / CLI / script shipped in bun-apps/s2-agent-ext-*.
# Run from anywhere; paths are repo-root-relative and safe to paste into any
# shell whose cwd is the repo root.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo_root"

mode="${1:-skills}" # skills | cli | scripts

case "$mode" in
  skills)
    # name + description line of every SKILL.md under an ext package
    for f in bun-apps/s2-agent-ext-*/skills/*/SKILL.md; do
      pkg=$(echo "$f" | cut -d/ -f2)
      skill=$(basename "$(dirname "$f")")
      desc=$(awk '/^description:/{sub(/^description: *>? */,""); print; exit}' "$f")
      printf '%s\t%s\t%s\n' "$skill" "$pkg" "${desc:-<no description>}"
    done | column -t -s $'\t' | sort
    ;;
  cli)
    # headless CLI fallbacks — runnable from repo root via: bun <path> --help
    ls bun-apps/s2-agent/src/cli.ts 2>/dev/null
    ls bun-apps/s2-agent-ext-*/src/*-cli.ts 2>/dev/null || echo "(none)"
    ;;
  scripts)
    # per-package scripts/ dirs (verification + smoke entry points)
    for d in bun-apps/s2-agent-ext-*/scripts; do
      [ -d "$d" ] || continue
      echo "== $d"
      ls "$d" | grep -v '^lib$' | grep -v '\.test\.' | sed 's/^/   /'
    done
    ;;
  *)
    echo "usage: list-ext-skills.sh [skills|cli|scripts]" >&2
    exit 2
    ;;
esac
