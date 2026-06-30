#!/usr/bin/env bash
# fullbody-stress-test.sh — harder test for `flux2 scene --regional`.
# Stresses the two hardest generation problems the user flagged:
#   1. HANDS (full-body refs force hands into frame: hands on hips / arms crossed)
#   2. SMALL-PROPORTION identity (full body => face is ~10% of frame, not 60%).
# Multi-seed baseline (placement is non-deterministic without --regional) vs a
# regional run, all caption-verified by run.py caption (local LLM).
#
# Usage: bash scripts/fullbody-stress-test.sh
set -euo pipefail

REPO="/Users/huangziyu/proj/video_generation"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
OUT="$REPO/swift/flux2-image-director/test_cases/fullbody"
mkdir -p "$OUT"

# Full body, hands visible (hands-on-hips / arms-crossed), extreme hair colour
# so the VLM can still tell the two apart when each face is small.
REF_A="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe fully visible, hands resting on her hips, vivid neon PINK hair, wearing a bright red biker jacket and black pants, plain light gray background, even studio lighting, sharp focus, natural hands with five fingers each"
REF_B="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe fully visible, arms crossed over her chest, vivid TEAL green hair, wearing a bright blue denim jacket and white pants, plain light gray background, even studio lighting, sharp focus, natural hands with five fingers each"
SCENE="two young women standing side by side facing the camera in a full-body wide shot, head to toe visible, the woman with vivid neon pink hair in a red jacket and black pants is on the LEFT with hands on hips, the woman with teal green hair in a blue jacket and white pants is on the RIGHT with arms crossed, plain neutral studio background, photorealistic, sharp focus, natural anatomically correct hands"

echo "==> [1] z-image full-body ref A (pink, hands on hips)"
"$ZIMAGE" t2i --prompt "$REF_A" --transformer moody-pro-mix \
  --width 768 --height 1024 --seed 3311 --strict-gate \
  --output-dir "$OUT" --name refA_pink_fb 2>&1 | tail -2

echo "==> [2] z-image full-body ref B (teal, arms crossed)"
"$ZIMAGE" t2i --prompt "$REF_B" --transformer moody-pro-mix \
  --width 768 --height 1024 --seed 4422 --strict-gate \
  --output-dir "$OUT" --name refB_teal_fb 2>&1 | tail -2

# Multi-seed baseline: tests whether prompt-driven placement is consistent
# across seeds (the claim --regional exists to fix).
for S in 42 77 123; do
  echo "==> baseline seed=$S"
  "$FLUX2" scene \
    --ref "$OUT/refA_pink_fb.png" --ref "$OUT/refB_teal_fb.png" \
    --prompt "$SCENE" \
    --width 1024 --height 1024 --steps 6 --seed "$S" \
    --output-dir "$OUT" --name "scene_base_s${S}" 2>&1 | tail -2
done

# One regional run (refines each ref into a vertical strip — deterministic per strip).
echo "==> regional seed=42"
"$FLUX2" scene \
  --ref "$OUT/refA_pink_fb.png" --ref "$OUT/refB_teal_fb.png" \
  --regional --regional-feather 24 \
  --prompt "$SCENE" \
  --width 1024 --height 1024 --steps 6 --seed 42 \
  --output-dir "$OUT" --name scene_regional_fb 2>&1 | tail -3

echo "==> DONE — outputs in $OUT"
ls -la "$OUT"/*.png
