#!/usr/bin/env bash
# tidy-next-goals.sh — housekeeping SOP for output/next-goal-*.md goal notes.
#
# Two rules (see project memory: next-goal-naming-sop):
#   1. Canonical filename format:  next-goal-YYYYMMDD_HHMMSS.md
#        8-digit date, underscore separator, 6-digit time WITH seconds (local).
#   2. Retention: keep only the N newest (default 10); trim the oldest.
#
# Phase 1 normalizes any non-canonical name:
#   • dash separator  -> underscore        (next-goal-20260706-0531.md -> _053100)
#   • missing seconds -> padded with '0'    (next-goal-20260705_1100.md -> _110000)
#   • already canonical names are left untouched.
# Phase 2 sorts the (now zero-padded, fixed-width) names lexicographically
# descending and deletes everything past the N newest.
#
# Idempotent: a second run is a no-op. Pure bash (no mapfile) so it runs on the
# stock macOS bash 3.2 as well as bash 4+.
#
# Usage:   bash scripts/tidy-next-goals.sh [KEEP]
#   KEEP   number of newest files to retain (default 10)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/output"
KEEP="${1:-10}"

CANON_RE='next-goal-[0-9]{8}_[0-9]{6}\.md'

mkdir -p "$OUT_DIR"

# ── Phase 1: normalize filenames ─────────────────────────────────────────────
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  if [[ "$base" =~ $CANON_RE ]]; then
    continue
  fi
  tok="${base#next-goal-}"   # strip prefix
  tok="${tok%.md}"           # strip suffix -> YYYYMMDD[_-]HHMM(SS)?
  if [[ "$tok" =~ ^([0-9]{8})[-_]([0-9]{4,6})$ ]]; then
    d="${BASH_REMATCH[1]}"
    t="${BASH_REMATCH[2]}"
    while [ "${#t}" -lt 6 ]; do t="${t}0"; done   # pad missing seconds
    new="next-goal-${d}_${t}.md"
    if [ "$base" != "$new" ] && [ ! -e "$OUT_DIR/$new" ]; then
      mv -- "$f" "$OUT_DIR/$new"
      echo "rename: $base -> $new"
    else
      echo "skip:   $base (collision or unchanged)"
    fi
  else
    echo "skip:   $base (unparsable timestamp)"
  fi
done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'next-goal-*.md' -print0)

# ── Phase 2: keep only the N newest ──────────────────────────────────────────
total="$(find "$OUT_DIR" -maxdepth 1 -type f -name 'next-goal-*.md' | wc -l | tr -d ' ')"
if [ "$total" -gt "$KEEP" ]; then
  # Lexicographic desc on fixed-width canonical names == newest-first.
  trimmed=0
  while IFS= read -r name; do
    rm -- "$OUT_DIR/$name"
    echo "trim:   $name"
    trimmed=$((trimmed + 1))
  done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'next-goal-*.md' -exec basename {} \; \
            | sort -r | tail -n +$((KEEP + 1)))
  echo "trimmed $trimmed file(s)."
fi

remaining="$(find "$OUT_DIR" -maxdepth 1 -type f -name 'next-goal-*.md' | wc -l | tr -d ' ')"
echo "done: $remaining next-goal file(s) kept (limit $KEEP)."
