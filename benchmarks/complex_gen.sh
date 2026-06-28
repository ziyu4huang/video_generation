#!/usr/bin/env bash
# Phase 2: Generate F1-F5 complex female-character benchmark matrix.
# Same prompt + seed (777) on BOTH Python (run.py) and Swift (zimage).
# moody-pro-mix / 9-step / CFG 1.0. Designed to stress full-body anatomy +
# elaborate cloth — things SSIM cannot judge (only VLM can).
#
# IMPORTANT for fair timing: Python and Swift runs are SEPARATED (Python batch
# first, then Swift batch) with a cool-down gap. Within a batch the thermal
# state is comparable. Per-step times live in the manifests' perf block.
set -e
cd /Users/huangziyu/proj/video_generation
OUT=/Users/huangziyu/proj/video_generation__output/py_vs_swift_complex
PY=python/venv/bin/python
SW="swift run --package-path swift/z-image-director zimage"

mkdir -p "$OUT"/{F1,F2,F3,F4,F5}

# ── The 5 test cases ──────────────────────────────────────────────
# Each: prompt | width | height | (portrait/landscape/square)
declare -a CASES
CASES[1]="full body standing portrait of an elegant young East Asian woman wearing an elaborate red evening gown with intricate beadwork and a long flowing train, full body visible from head to toe, standing confidently in a studio with soft gradient lighting, high fashion photography, sharp focus on fabric texture and details, hands relaxed at her sides, 85mm lens|832|1216"
CASES[2]="full body of a young woman walking gracefully, wearing a multi-layered traditional hanfu with wide flowing sleeves and layered silk skirts draping with motion, full body visible, garden setting with cherry blossoms, soft natural daylight, wind gently blowing the fabric, detailed embroidery visible, full anatomy correct, cinematic|832|1216"
CASES[3]="three-quarter body view of a young woman seated casually on a stool, wearing layered streetwear: oversized hoodie over a plaid shirt, ripped jeans, chunky sneakers, multiple chains and rings, relaxed pose with one hand on knee, urban loft with concrete wall background, moody dramatic lighting, detailed fabric folds and accessory textures|1216|832"
CASES[4]="extreme close-up portrait of a young East Asian woman face, natural light makeup with subtle blush, visible skin pores and fine skin texture, soft natural lighting, shallow depth of field, ultra sharp focus on eyes, neutral studio background, 85mm portrait lens|832|1216"
CASES[5]="full body of a young woman sitting at an outdoor cafe table, wearing a summer sundress, holding a coffee cup, relaxed candid pose, legs crossed, full body visible, busy street background with soft bokeh, warm afternoon sunlight, lifestyle photography, natural interaction with the environment|1024|1024"

run_case() {
  local idx=$1 impl=$2
  IFS='|' read -r prompt w h <<< "${CASES[$idx]}"
  local dir="$OUT/F$idx/$impl"
  mkdir -p "$dir"
  local name="${impl}_s777"
  echo "── F$idx [$impl] ${w}×${h} ──"
  if [ "$impl" = "python" ]; then
    $PY python/mlx-movie-director/run.py image t2i \
      --transformer moody-pro-mix --prompt "$prompt" \
      --seed 777 --steps 9 \
      --width "$w" --height "$h" \
      --output "$dir/$name" 2>&1 | grep -E "Step|Avg Speed|Pipeline Finished|Saved" | tail -4
    # Python saves as output_*.png — rename to canonical
    mv "$dir"/output_*.png "$dir/$name.png" 2>/dev/null || true
    mv "$dir"/output_*.run.json "$dir/$name.run.json" 2>/dev/null || true
    mv "$dir"/output_*.manifest.json "$dir/$name.manifest.json" 2>/dev/null || true
  else
    $SW t2i --transformer moody-pro-mix --prompt "$prompt" \
      --seed 777 --width "$w" --height "$h" \
      --output-dir "$dir" --name "$name" 2>&1 | grep -E "step [0-9]|denoise total|saved" | tail -3
  fi
  echo ""
}

echo "============================================"
echo "  PYTHON BATCH (all 5 cases)"
echo "============================================"
for i in 1 2 3 4 5; do run_case $i python; done

echo "============================================"
echo "  Cool-down 20s (thermal fairness)..."
echo "============================================"
sleep 20

echo "============================================"
echo "  SWIFT BATCH (all 5 cases)"
echo "============================================"
for i in 1 2 3 4 5; do run_case $i swift; done

echo ""
echo "============================================"
echo "  DONE — files in $OUT"
echo "============================================"
ls -R "$OUT" | grep -E "\.png|\.manifest\.json" | head -30
