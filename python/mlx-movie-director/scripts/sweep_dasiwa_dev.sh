#!/usr/bin/env bash
# sweep_dasiwa_dev.sh — DaSiWa-vs-dev parameter sweep (14 runs).
#
# For each transformer in {dasiwa, dev}, runs 7 cells:
#   steps{8,20,30} x cfg{3,5}  (6 cells)  +  HQ (steps15, cfg5, --hq)  (1 cell)
# All cells: 768x512, 97 frames, fps 24, seed 42 (fixed for fair comparison),
# --low-ram. Extracts the first frame (--first-frame) for later review captioning.
#
# Each run's mp4 path + params are appended to output/.sweep_runs.txt for the
# review-HTML builder. Runs sequentially (GPU lock). ~55 min total.
#
# Usage:
#   PROMPT_FILE=/tmp/forge-catgirl.txt bash scripts/sweep_dasiwa_dev.sh
# Resume: re-run; already-done cells are skipped if their mp4 is logged.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY=/Users/huangziyu/proj/video_generation/python/venv/bin/python
PROMPT_FILE="${PROMPT_FILE:-/tmp/forge-catgirl.txt}"
RUNS_LOG="output/.sweep_runs.txt"
SWEEP_LOG="output/.sweep.log"

mkdir -p output
: > "$RUNS_LOG"          # fresh run log (builder reads this)
: > "$SWEEP_LOG"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: prompt file not found: $PROMPT_FILE" >&2; exit 1
fi

run_cell() {
  local transformer="$1" steps="$2" cfg="$3" extra="$4" label="$5"
  echo "====================================================================" | tee -a "$SWEEP_LOG"
  echo ">>> [$label]  transformer=$transformer  steps=$steps  cfg=$cfg  $extra" | tee -a "$SWEEP_LOG"
  local logf="/tmp/sweep_${label}.log"
  if "$PY" run.py video generate \
        --transformer "$transformer" \
        --prompt-file "$PROMPT_FILE" \
        --width 768 --height 512 --frames 97 --fps 24 --seed 42 \
        --stage1-steps "$steps" --cfg-scale "$cfg" $extra \
        --first-frame --low-ram -y > "$logf" 2>&1; then
    local base
    base="$(grep -oE 'Saved:[[:space:]]+\S+\.mp4' "$logf" | head -1 | sed -E 's/Saved:[[:space:]]+//')"
    if [ -n "$base" ]; then
      echo "$base|${label}|${transformer}|${steps}|${cfg}|${extra#--}" >> "$RUNS_LOG"
      echo "  ✅ $label -> $(basename "$base")" | tee -a "$SWEEP_LOG"
    else
      echo "  ⚠️  $label: ran but no Saved line found (see $logf)" | tee -a "$SWEEP_LOG"
    fi
  else
    echo "  ❌ $label FAILED (see $tmp/$logf)" | tee -a "$SWEEP_LOG"
    tail -8 "$logf" >> "$SWEEP_LOG"
  fi
}

for T in dasiwa dev; do
  run_cell "$T"  8 5 ""      "${T}-08st-cfg5"
  run_cell "$T" 20 5 ""      "${T}-20st-cfg5"
  run_cell "$T" 30 5 ""      "${T}-30st-cfg5"
  run_cell "$T"  8 3 ""      "${T}-08st-cfg3"
  run_cell "$T" 20 3 ""      "${T}-20st-cfg3"
  run_cell "$T" 30 3 ""      "${T}-30st-cfg3"
  run_cell "$T" 15 5 "--hq"  "${T}-HQ15st-cfg5"
done

echo "====================================================================" | tee -a "$SWEEP_LOG"
echo "🎉 SWEEP DONE: $(wc -l < "$RUNS_LOG") / 14 runs logged -> $RUNS_LOG" | tee -a "$SWEEP_LOG"
