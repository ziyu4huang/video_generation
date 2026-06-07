#!/usr/bin/env bash
# A/B test for LTX-2.3 default parameters — 4 runs, 73 frames (~3s @ 24fps)
# Tests: cfg_scale (3.0 vs 5.0) × stg_scale (1.0 vs 0.0)
#
# Usage: bash scripts/ab_test_ltx.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$SCRIPT_DIR/../venv/bin/python"
RUN="$PYTHON $SCRIPT_DIR/run.py"

PROMPT="ocean waves gently breaking on sandy beach at sunrise, clear sky, warm golden light, slow camera tilt"
FRAMES=73
FPS=24
WIDTH=704
HEIGHT=480
SEED=42

echo "============================================================"
echo " LTX-2.3 A/B test — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Prompt : $PROMPT"
echo " Frames : $FRAMES  FPS: $FPS  Size: ${WIDTH}x${HEIGHT}"
echo " Tests  : 4 runs  (cfg × stg)"
echo "============================================================"
echo ""

run_test() {
    local label="$1"
    local cfg="$2"
    local stg="$3"

    echo "------------------------------------------------------------"
    echo " Test $label — cfg_scale=$cfg  stg_scale=$stg"
    echo "------------------------------------------------------------"
    T0=$SECONDS
    $RUN video \
        --prompt "$PROMPT" \
        --width $WIDTH --height $HEIGHT \
        --frames $FRAMES --fps $FPS \
        --seed $SEED \
        --cfg-scale "$cfg" \
        --stg-scale "$stg"
    ELAPSED=$(( SECONDS - T0 ))
    echo " [$label] done in ${ELAPSED}s"
    echo ""
}

# A: current defaults
run_test "A" 3.0 1.0

# B: higher CFG (stronger prompt adherence)
run_test "B" 5.0 1.0

# C: STG disabled (no spatial-temporal guidance)
run_test "C" 3.0 0.0

# D: higher CFG + STG disabled
run_test "D" 5.0 0.0

echo "============================================================"
echo " All tests complete. Output files:"
ls -lh "$SCRIPT_DIR/output/"*.mp4 | tail -4
echo "============================================================"
