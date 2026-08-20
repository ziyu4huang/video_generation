#!/usr/bin/env bash
########################################
# run-self-improve-loop.sh — run the CLOSED self-improve loop for flux2.
#
# SYNCHRONOUS DIRECT DRIVER (not agent-in-the-middle). The earlier version
# invoked `s2-agent -e workflow -p "read … and execute"`, but the LLM agent in
# the middle backgrounded the workflow and exited before the result — so the
# runner never saw ok/converged (see output/new-goal-20260704-0402.md §0 #1).
# This version parses flags + selects a pose via jq, then calls the engine's
# runWorkflow DIRECTLY via self-improve-loop.driver.ts: synchronous, no router
# fragility, result returned in full.
#
# OPT-IN: spends real GPU + VLM tokens. NOT wired into run-test.sh / CI.
#
# USAGE
#   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh              # default = first pose
#   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --attempts 5
#   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --pose-id L3-01 --seed 42
#   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --prompt "a red apple"   # non-pose
#   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --mode reflect           # opt-in reflection
#   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --dry-run                # print args, exit
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ → s2-agent/ → bun-apps/ → repo root (three levels up).
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DRIVER="$REPO_ROOT/bun-apps/s2-agent-ext-flux2/scripts/self-improve-loop.driver.ts"
POSES_JSON="$REPO_ROOT/bun-apps/s2-agent-ext-flux2/workflows/poses.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi
if [ ! -f "$DRIVER" ]; then
  echo "error: driver not found at $DRIVER" >&2
  exit 1
fi

# ── Parse flags → workflow `args` ───────────────────────────────────────────
ATTEMPTS=3
SEED=42
STEPS=4
WIDTH=768
HEIGHT=768
POSE_ID=""
PROMPT=""
MODE="best-of-n"
JUDGE_MODEL=""
CONSECUTIVE_STATIC=""
SEEDS=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --attempts) ATTEMPTS="$2"; shift 2;;
    --seed)     SEED="$2";     shift 2;;
    --steps)    STEPS="$2";    shift 2;;
    --width)    WIDTH="$2";    shift 2;;
    --height)   HEIGHT="$2";   shift 2;;
    --pose-id)  POSE_ID="$2";  shift 2;;
    --prompt)   PROMPT="$2";   shift 2;;
    --mode)     MODE="$2";     shift 2;;
    --judge-model) JUDGE_MODEL="$2"; shift 2;;
    --consecutive-static) CONSECUTIVE_STATIC="$2"; shift 2;;
    --seeds)    SEEDS="$2";    shift 2;;
    --dry-run)  DRY=1;         shift;;
    -h|--help)  sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

ARGS="{\"repoRoot\":\"$REPO_ROOT\",\"attempts\":$ATTEMPTS,\"seed\":$SEED,\"steps\":$STEPS,\"width\":$WIDTH,\"height\":$HEIGHT,\"mode\":\"$MODE\",\"outDir\":\"$REPO_ROOT/../video_generation__output/wf-self-improve-flux2\""
if [ -n "$JUDGE_MODEL" ]; then
  ARGS="$ARGS,\"judgeModel\":\"$JUDGE_MODEL\""
fi
if [ -n "$CONSECUTIVE_STATIC" ]; then
  ARGS="$ARGS,\"consecutiveStatic\":$CONSECUTIVE_STATIC"
fi
if [ -n "$SEEDS" ]; then
  # comma-separated → JSON number array, validated as digits
  SEEDS_JSON="$(echo "$SEEDS" | tr ',' '\n' | grep -E '^[0-9]+$' | paste -sd, -)"
  if [ -z "$SEEDS_JSON" ]; then echo "error: --seeds must be comma-separated integers" >&2; exit 2; fi
  ARGS="$ARGS,\"seeds\":[$SEEDS_JSON]"
  # attempts should cover the seed set; bump if too few.
  SEEDS_N="$(echo "$SEEDS_JSON" | tr -cd ',' | wc -c | tr -d ' ')"
  if [ "$((SEEDS_N + 1))" -gt "$ATTEMPTS" ]; then ATTEMPTS="$((SEEDS_N + 1))"; fi
fi

if [ -n "$PROMPT" ]; then
  # Holistic-score loop (non-pose). jq -Rs safely JSON-encodes PROMPT (quotes,
  # backslashes, newlines) instead of splicing it raw into the JSON string.
  PROMPT_JSON="$(printf '%s' "$PROMPT" | jq -Rs '.')"
  ARGS="$ARGS,\"prompts\":[$PROMPT_JSON]}"
else
  if [ ! -f "$POSES_JSON" ]; then
    echo "error: poses.json not found at $POSES_JSON (pass --prompt instead)" >&2
    exit 1
  fi
  # poses.json is {levels:[{poses:[{id,prompt,failure_modes,atoms}]}]}. Select one
  # pose by id (default first); pass it as a single-element `poses` array exactly
  # as the workflow expects.
  if [ -n "$POSE_ID" ]; then
    POSE_JSON="$(jq -c --arg id "$POSE_ID" '[ [ .levels[].poses[] | select(.id==$id) ][0] ]' "$POSES_JSON")"
  else
    POSE_JSON="$(jq -c '[ [ .levels[].poses[] ][0] ]' "$POSES_JSON")"
  fi
  if [ "$POSE_JSON" = "null" ] || [ "$POSE_JSON" = "[null]" ]; then
    echo "error: could not select a pose (id='$POSE_ID' not found?)" >&2
    exit 1
  fi
  ARGS="$ARGS,\"poses\":$POSE_JSON}"
fi

echo "── self-improve loop (direct driver) ──"
echo "   driver: ${DRIVER#$REPO_ROOT/}"
echo "   args:   $ARGS"
[ "$DRY" -eq 1 ] && { echo "(dry-run — not executing)"; exit 0; }

# Drive the engine directly. The driver prints `LOOP_RESULT <json>` on its last
# stdout line and exits 0 on completion (converged OR needsReview). A converged
# loop has "converged":true in that line.
LOG=/tmp/flux2-self-improve-loop-$$.log
# Run first, grep the log after — never `… | grep -q` under pipefail. `grep -q`
# exits on its first match and closes the pipe, `tee` dies on SIGPIPE with 141,
# and pipefail makes that the pipeline's status: a CONVERGED loop was reported
# as "did NOT converge". Racy, so it flipped only sometimes. The else-branch
# below already greps $LOG — this just makes both branches do the same thing.
bun "$DRIVER" --args "$ARGS" 2>&1 | tee "$LOG" || true
if grep -Eq '"converged"[[:space:]]*:[[:space:]]*true' "$LOG"; then
  echo "✓ loop converged (see LOOP_RESULT above)"
  exit 0
else
  # Completed without converging (needsReview) is still a successful synchronous
  # run — only a crash (no LOOP_RESULT line) is a real failure.
  if grep -q '^LOOP_RESULT ' "$LOG"; then
    echo "⚠ loop completed but did NOT converge (needsReview) — see LOOP_RESULT above"
    exit 0
  fi
  echo "✗ loop crashed / produced no LOOP_RESULT — see $LOG"
  exit 1
fi
