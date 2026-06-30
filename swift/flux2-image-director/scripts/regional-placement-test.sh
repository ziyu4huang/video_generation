#!/usr/bin/env bash
# regional-placement-test.sh — A/B test for `flux2 scene --regional` (left/right
# multi-character placement, the workflow's headline scenario). Two VLM-
# distinguishable characters (extreme hair colour) so run.py caption can verify
# position. Baseline (no --regional) vs --regional, then caption-scored.
#
# Usage: bash scripts/regional-placement-test.sh
set -euo pipefail

REPO="/Users/huangziyu/proj/video_generation"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
OUT="$REPO/swift/flux2-image-director/test_cases/regional"
mkdir -p "$OUT"

REF_A="photorealistic head-and-shoulders portrait of a young woman with bright neon PINK hair, wearing a red jacket, plain light gray studio background, even soft lighting, neutral expression, sharp focus, high detail"
REF_B="photorealistic head-and-shoulders portrait of a young woman with bright TEAL green hair, wearing a blue jacket, plain light gray studio background, even soft lighting, neutral expression, sharp focus, high detail"
SCENE="two young women standing side by side facing the camera, the woman with bright neon pink hair and a red jacket is on the LEFT, the woman with teal green hair and a blue jacket is on the RIGHT, plain neutral background, full body, photorealistic, sharp focus"

echo "==> [1/4] z-image ref A (pink hair)"
"$ZIMAGE" t2i --prompt "$REF_A" --transformer moody-pro-mix \
  --width 640 --height 960 --seed 1101 --strict-gate \
  --output-dir "$OUT" --name refA_pink 2>&1 | tail -3

echo "==> [2/4] z-image ref B (teal hair)"
"$ZIMAGE" t2i --prompt "$REF_B" --transformer moody-pro-mix \
  --width 640 --height 960 --seed 2202 --strict-gate \
  --output-dir "$OUT" --name refB_teal 2>&1 | tail -3

echo "==> [3/4] flux2 scene BASELINE (no --regional)"
"$FLUX2" scene \
  --ref "$OUT/refA_pink.png" --ref "$OUT/refB_teal.png" \
  --prompt "$SCENE" \
  --width 1024 --height 1024 --steps 6 --seed 42 \
  --output-dir "$OUT" --name scene_baseline 2>&1 | tail -4

echo "==> [4/4] flux2 scene REGIONAL (--regional)"
"$FLUX2" scene \
  --ref "$OUT/refA_pink.png" --ref "$OUT/refB_teal.png" \
  --regional --regional-feather 24 \
  --prompt "$SCENE" \
  --width 1024 --height 1024 --steps 6 --seed 42 \
  --output-dir "$OUT" --name scene_regional 2>&1 | tail -6

echo "==> DONE — outputs in $OUT"
ls -la "$OUT"/*.png
