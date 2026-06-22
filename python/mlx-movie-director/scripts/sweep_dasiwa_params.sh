#!/usr/bin/env bash
# sweep_dasiwa_params.sh — find best dasiwa hyperparameters for quality vs runtime.
#
# Tests 7 conditions against a shared base image (skips T2I to isolate LTX params):
#
#   Axis 1 — stage1_steps:      8, 16, 30
#   Axis 2 — teacache:          on vs off (at steps=8 and steps=16)
#   Axis 3 — audio_stage1_only: on at steps=8
#   Axis 4 — audio_cfg_scale:   3.0 vs default(7.0) at steps=8
#
#   Held constant: transformer=dasiwa, dev-audio, seed=42, frames=49,
#                  stage2_steps=3, cfg_scale=5.0, stg_scale=1.0,
#                  audio_modality_scale=5.0, resolution=448x704
#
# Usage:
#   BASE_IMAGE=/path/to/image.png bash scripts/sweep_dasiwa_params.sh
#   BASE_IMAGE=... SEEDS="42 100" bash scripts/sweep_dasiwa_params.sh   # multi-seed
#   BASE_IMAGE=... FRAMES=97 bash scripts/sweep_dasiwa_params.sh         # longer clip
#
# Each condition runs in a labelled subdir under SWEEP_ROOT.
# After all runs complete, analyze with:
#   python/venv/bin/python scripts/analyze_dasiwa_sweep.py <SWEEP_ROOT>

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${PY:-/Users/huangziyu/proj/video_generation__ltx/python/venv/bin/python}"
BASE_IMAGE="${BASE_IMAGE:-}"
SEEDS="${SEEDS:-42}"
FRAMES="${FRAMES:-49}"
SWEEP_DATE="$(date +%Y%m%d_%H%M%S)"
SWEEP_ROOT="${SWEEP_ROOT:-../video_generation__output/sweep_dasiwa_params_${SWEEP_DATE}}"
SWEEP_LOG="${SWEEP_ROOT}/sweep.log"

FIXED_PROMPT="一位年輕女性站在陽光明媚的花園中，她溫柔微笑，輕聲說「你終於來了，我等你好久了。」Style: cinematic realism."

# ── Validate ────────────────────────────────────────────────────────────────
if [ -z "$BASE_IMAGE" ]; then
  echo "ERROR: BASE_IMAGE is required." >&2
  echo "  Usage: BASE_IMAGE=/path/to/image.png bash scripts/sweep_dasiwa_params.sh" >&2
  echo "" >&2
  echo "  Generate one first (skip VLM, just T2I):" >&2
  echo "    $PY run.py video t2i2v --prompt '...' --transformer dasiwa --dev-audio \\" >&2
  echo "      --frames 49 --seed 42 --yes" >&2
  exit 1
fi
if [ ! -f "$BASE_IMAGE" ]; then
  echo "ERROR: BASE_IMAGE not found: $BASE_IMAGE" >&2; exit 1
fi

mkdir -p "$SWEEP_ROOT"
: > "$SWEEP_LOG"

echo "================================================================" | tee -a "$SWEEP_LOG"
echo "sweep_dasiwa_params — $(date)"                                     | tee -a "$SWEEP_LOG"
echo "  BASE_IMAGE : $BASE_IMAGE"                                         | tee -a "$SWEEP_LOG"
echo "  SEEDS      : $SEEDS"                                              | tee -a "$SWEEP_LOG"
echo "  FRAMES     : $FRAMES"                                             | tee -a "$SWEEP_LOG"
echo "  SWEEP_ROOT : $SWEEP_ROOT"                                         | tee -a "$SWEEP_LOG"
echo "================================================================" | tee -a "$SWEEP_LOG"

# ── Conditions ───────────────────────────────────────────────────────────────
# Format: "label|extra_args"
CONDITIONS=(
  "s1_8|--stage1-steps 8"
  "s1_16|--stage1-steps 16"
  "s1_30|--stage1-steps 30"
  "s1_8_tc|--stage1-steps 8 --teacache"
  "s1_16_tc|--stage1-steps 16 --teacache"
  "s1_8_ao|--stage1-steps 8 --audio-stage1-only"
  "s1_8_acfg3|--stage1-steps 8 --audio-cfg-scale 3.0"
)

# ── Runner ───────────────────────────────────────────────────────────────────
run_condition() {
  local label="$1" extra_args="$2" seed="$3"
  local cell="${label}_seed${seed}"
  local out_dir="${SWEEP_ROOT}/${cell}"
  local logf="${SWEEP_ROOT}/${cell}.log"

  echo "" | tee -a "$SWEEP_LOG"
  echo ">>> [$cell]  $extra_args" | tee -a "$SWEEP_LOG"
  echo "    seed=$seed  frames=$FRAMES  out=$out_dir" | tee -a "$SWEEP_LOG"

  # Skip if quality_report.json already exists (resume support)
  if ls "$out_dir"/t2i2v_*/quality_report.json &>/dev/null 2>&1; then
    echo "    ♻  already done — skipping" | tee -a "$SWEEP_LOG"
    return 0
  fi

  mkdir -p "$out_dir"
  local t_start=$SECONDS

  # shellcheck disable=SC2086
  if "$PY" run.py video t2i2v \
      --from-image "$BASE_IMAGE" \
      --prompt "$FIXED_PROMPT" \
      --transformer dasiwa --dev-audio \
      --frames "$FRAMES" --seed "$seed" \
      --cfg-scale 5.0 --stg-scale 1.0 \
      --audio-modality-scale 5.0 \
      --stage2-steps 3 \
      $extra_args \
      --quality-check --yes \
      --gen-output-dir "$out_dir" \
      > "$logf" 2>&1; then
    local elapsed=$(( SECONDS - t_start ))
    echo "    ✅  done in ${elapsed}s" | tee -a "$SWEEP_LOG"
    echo "DONE|$cell|${elapsed}s" >> "${SWEEP_ROOT}/results_index.txt"
  else
    echo "    ❌  FAILED (see $logf)" | tee -a "$SWEEP_LOG"
    tail -10 "$logf" | tee -a "$SWEEP_LOG"
    echo "FAIL|$cell|-" >> "${SWEEP_ROOT}/results_index.txt"
  fi
}

# ── Main loop ────────────────────────────────────────────────────────────────
total=0
for entry in "${CONDITIONS[@]}"; do
  label="${entry%%|*}"
  extra="${entry#*|}"
  for seed in $SEEDS; do
    run_condition "$label" "$extra" "$seed"
    (( total++ )) || true
  done
done

echo "" | tee -a "$SWEEP_LOG"
echo "================================================================" | tee -a "$SWEEP_LOG"
done_count=$(grep -c "^DONE" "${SWEEP_ROOT}/results_index.txt" 2>/dev/null || echo 0)
echo "SWEEP DONE: ${done_count}/${total} cells succeeded" | tee -a "$SWEEP_LOG"
echo "" | tee -a "$SWEEP_LOG"
echo "Next step — analyze results:" | tee -a "$SWEEP_LOG"
echo "  $PY scripts/analyze_dasiwa_sweep.py $SWEEP_ROOT" | tee -a "$SWEEP_LOG"
echo "================================================================" | tee -a "$SWEEP_LOG"
