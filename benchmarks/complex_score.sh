#!/usr/bin/env bash
# Phase 3: VLM scoring via run.py caption.
# For each of the 10 images (F1-F5 × python/swift), run:
#   --style score   → numeric {overall,detail,sharp,comp,adhere,artifacts} + issues
#   --style review  → prompt-adherence critique (captured[]/missed[] checklist)
#                   requires --prompt (the original t2i prompt)
# Outputs: <image>.score.json and <image>.review.json sidecars.
set -e
cd /Users/huangziyu/proj/video_generation
OUT=/Users/huangziyu/proj/video_generation__output/py_vs_swift_complex
PY=python/venv/bin/python

# Prompts must match complex_gen.sh exactly (for review adherence check).
declare -a CASES
CASES[1]="full body standing portrait of an elegant young East Asian woman wearing an elaborate red evening gown with intricate beadwork and a long flowing train, full body visible from head to toe, standing confidently in a studio with soft gradient lighting, high fashion photography, sharp focus on fabric texture and details, hands relaxed at her sides, 85mm lens"
CASES[2]="full body of a young woman walking gracefully, wearing a multi-layered traditional hanfu with wide flowing sleeves and layered silk skirts draping with motion, full body visible, garden setting with cherry blossoms, soft natural daylight, wind gently blowing the fabric, detailed embroidery visible, full anatomy correct, cinematic"
CASES[3]="three-quarter body view of a young woman seated casually on a stool, wearing layered streetwear: oversized hoodie over a plaid shirt, ripped jeans, chunky sneakers, multiple chains and rings, relaxed pose with one hand on knee, urban loft with concrete wall background, moody dramatic lighting, detailed fabric folds and accessory textures"
CASES[4]="extreme close-up portrait of a young East Asian woman face, natural light makeup with subtle blush, visible skin pores and fine skin texture, soft natural lighting, shallow depth of field, ultra sharp focus on eyes, neutral studio background, 85mm portrait lens"
CASES[5]="full body of a young woman sitting at an outdoor cafe table, wearing a summer sundress, holding a coffee cup, relaxed candid pose, legs crossed, full body visible, busy street background with soft bokeh, warm afternoon sunlight, lifestyle photography, natural interaction with the environment"

score_case() {
  local idx=$1 impl=$2
  local dir="$OUT/F$idx/$impl"
  local img="$dir/${impl}_s777.png"
  local prompt="${CASES[$idx]}"
  [ -f "$img" ] || { echo "MISSING $img"; return; }

  echo "── F$idx [$impl] score ──"
  $PY python/mlx-movie-director/run.py caption "$img" --style score --lang en 2>&1 | grep -iE "overall|score|pass|fail" | head -2
  echo "── F$idx [$impl] review (prompt adherence) ──"
  $PY python/mlx-movie-director/run.py caption "$img" --style review --prompt "$prompt" --lang en 2>&1 | grep -iE "overall|adherence|captured|missed|score" | head -3
  echo ""
}

for i in 1 2 3 4 5; do
  score_case $i python
  score_case $i swift
done

echo "============================================"
echo "  VLM scoring complete"
echo "============================================"
echo "Sidecar files generated:"
find "$OUT" -name "*.score.json" -o -name "*.review.json" | wc -l
