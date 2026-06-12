#!/usr/bin/env bash
# sweep_voice.sh — the *correct* speech A/B (dasiwa vs dev) at voice-optimal settings.
#
# Prior runs used 8 steps + a long prompt -> "voice is bad". This sweep isolates
# the cause: 5 cells varying ONE factor each at the voice sweet spot
# (stage1=16, 57 frames, cfg5, seed 42, 768x512, --low-ram).
#
#   V1  optimized · dasiwa · 16st   primary A/B
#   V2  optimized · dev    · 16st   primary A/B (transformer)
#   V3  optimized · dasiwa ·  8st   step control   (8 vs 16)
#   V4  original  · dasiwa · 16st   prompt control (opt vs orig)
#   V5  original  · dasiwa ·  8st   baseline of record
#
# Logs each mp4 + params to output/.voice_runs.txt (7-col, with group) for
# build_voice_review.py. Sequential (GPU lock). ~16 min total.
#
# Usage:
#   bash scripts/sweep_voice.sh
# Resume: re-run; cells whose mp4 is already logged are NOT auto-skipped
# (re-running overwrites output/.voice_runs.txt) — comment out done cells.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY=/Users/huangziyu/proj/video_generation/python/venv/bin/python
OPT_PROMPT=/tmp/voice-optimized.txt
ORIG_PROMPT=/tmp/forge-catgirl.txt
RUNS_LOG="output/.voice_runs.txt"
SWEEP_LOG="output/.sweep_voice.log"

mkdir -p output
: > "$RUNS_LOG"
: > "$SWEEP_LOG"

for pf in "$OPT_PROMPT" "$ORIG_PROMPT"; do
  if [ ! -f "$pf" ]; then
    echo "ERROR: prompt file not found: $pf" >&2; exit 1
  fi
done

run_cell() {
  local transformer="$1" steps="$2" prompt_file="$3" tag="$4" group="$5" label="$6"
  echo "====================================================================" | tee -a "$SWEEP_LOG"
  echo ">>> [$label]  transformer=$transformer  steps=$steps  prompt=$tag  ($group)" | tee -a "$SWEEP_LOG"
  local logf="/tmp/voice_${label}.log"
  if "$PY" run.py video generate \
        --transformer "$transformer" \
        --prompt-file "$prompt_file" \
        --width 768 --height 512 --frames 57 --fps 24 --seed 42 \
        --stage1-steps "$steps" --cfg-scale 5 \
        --first-frame --low-ram -y > "$logf" 2>&1; then
    local base
    base="$(grep -oE 'Saved:[[:space:]]+\S+\.mp4' "$logf" | head -1 | sed -E 's/Saved:[[:space:]]+//')"
    if [ -n "$base" ]; then
      echo "$base|${label}|${transformer}|${steps}|5|${tag}|${group}" >> "$RUNS_LOG"
      echo "  ✅ $label -> $(basename "$base")" | tee -a "$SWEEP_LOG"
    else
      echo "  ⚠️  $label: ran but no Saved line found (see $logf)" | tee -a "$SWEEP_LOG"
    fi
  else
    echo "  ❌ $label FAILED (see $logf)" | tee -a "$SWEEP_LOG"
    tail -8 "$logf" >> "$SWEEP_LOG"
  fi
}

# Primary A/B (transformer comparison @ voice-optimal)
run_cell dasiwa 16 "$OPT_PROMPT"  opt  primary "dasiwa-16st-opt"
run_cell dev    16 "$OPT_PROMPT"  opt  primary "dev-16st-opt"
# Step control: 8 vs 16 (optimized prompt) — isolates the step-count lever
run_cell dasiwa  8 "$OPT_PROMPT"  opt  step    "dasiwa-08st-opt"
# Prompt control: optimized vs original @ 16 steps — isolates the prompt lever
run_cell dasiwa 16 "$ORIG_PROMPT" orig prompt  "dasiwa-16st-orig"
# Baseline of record: the actual prior condition (original prompt, 8 steps)
run_cell dasiwa  8 "$ORIG_PROMPT" orig baseline "dasiwa-08st-orig"

echo "====================================================================" | tee -a "$SWEEP_LOG"
echo "🎉 VOICE SWEEP DONE: $(wc -l < "$RUNS_LOG") / 5 runs logged -> $RUNS_LOG" | tee -a "$SWEEP_LOG"
