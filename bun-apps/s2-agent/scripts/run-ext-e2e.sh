#!/usr/bin/env bash
########################################
# run-ext-e2e.sh — run the L2 judgment e2e workflow for every s2-agent extension.
#
# Discovers bun-apps/s2-agent-ext-*/workflows/test-*-e2e.js and runs each via the
# s2-agent `workflow` tool. OPT-IN: this spends LLM tokens and is non-deterministic,
# so it is deliberately NOT wired into run-test.sh / CI. See PRD.md (L2 layer).
#
# WHY A SEPARATE RUNNER
#   The `workflow` tool takes a `script` STRING (no file-path param), so each
#   invocation is: run.sh -p "read <file> and execute it via the
#   workflow tool (background:false)". This script just loops that over packages.
#   (workflow is a default-on static extension now — no `-e workflow` needed.)
#
# USAGE
#   bash bun-apps/s2-agent/scripts/run-ext-e2e.sh              # all extensions
#   bash bun-apps/s2-agent/scripts/run-ext-e2e.sh flux2        # one extension
#   bash bun-apps/s2-agent/scripts/run-ext-e2e.sh --list       # list, run nothing
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ → s2-agent/ → bun-apps/ → repo root (three levels up).
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXTS_DIR="$REPO_ROOT/bun-apps"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi

# Collect matching workflows (optionally filtered to one extension name).
filter="${1:-}"
if [ "$filter" = "--list" ]; then
  mode="list"
elif [ -n "$filter" ]; then
  mode="one"
else
  mode="all"
fi

# Collect matching workflows (glob into an array, then filter by mode).
WORKFLOWS=()
for d in "$EXTS_DIR"/s2-agent-ext-*/workflows/test-*-e2e.js; do
  [ -f "$d" ] || continue
  if [ "$mode" = "one" ]; then
    case "$d" in *"/s2-agent-ext-$filter/"*) WORKFLOWS+=("$d");; esac
  else
    WORKFLOWS+=("$d")
  fi
done

if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
  echo "No extension e2e workflows found under $EXTS_DIR/s2-agent-ext-*/workflows/test-*-e2e.js"
  [ "$mode" = "one" ] && echo "(filter '$filter' matched nothing)"
  [ "$mode" = "list" ] && exit 0
  exit 0
fi

if [ "$mode" = "list" ]; then
  printf '%s\n' "${WORKFLOWS[@]}"
  exit 0
fi

PASS=0
FAIL=0
FAILED_NAMES=()
for wf in "${WORKFLOWS[@]}"; do
  rel="${wf#$REPO_ROOT/}"
  echo "── running $rel ──"
  # Capture to a log, THEN grep the file — never `… | grep -q` under pipefail.
  # `grep -q` exits on its first match and closes the pipe; `tee` (and often the
  # producer) then dies on SIGPIPE with 141, and pipefail makes 141 the
  # pipeline's status. So the SUCCESS case took the failure branch — and only
  # sometimes, since it races the producer's own exit. A green run reported as
  # ✗, intermittently, is worse than a crash.
  log="/tmp/s2-agent-ext-e2e-$$-$PASS$FAIL.log"
  bun "$SCRIPT_DIR/../src/cli.ts" \
      -p "read the file $rel, then call the workflow tool with its FULL source as the script parameter (no markdown fences), background:false, and report the structured result it returns." \
      2>&1 | tee "$log" >&2 || true
  if grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$log"; then
    rm -f "$log"
    echo "✓ $rel"
    PASS=$((PASS+1))
  else
    rm -f "$log"
    echo "✗ $rel (no \"ok\": true in result, or run errored)"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$rel")
  fi
  echo
done

echo "── summary ──"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -gt 0 ] && { printf 'FAILED:\n'; printf '  %s\n' "${FAILED_NAMES[@]}"; exit 1; }
exit 0
