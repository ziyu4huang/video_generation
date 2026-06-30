#!/usr/bin/env bash
# multi-seed-autoselect.sh — pragmatic improvement to flux2 multi-ref placement.
#
# Knowledge studied (2026-06-30): refs are GLOBAL tokens (no identity→region
# binding), so placement is 100% prompt-driven and reliable-but-probabilistic.
# --regional fights the architecture and loses (ghosting + bad hands). The
# engineering-efficient fix is NOT a new architecture — it is SEED SELECTION:
# run N seeds, verify each with the local LLM (placement + hand quality), keep
# the verified-correct best. Turns "placement is probabilistic" into "you get a
# verified-correct result". No --regional.
#
# Flow: z-image 2 distinct refs -> flux2 scene x N seeds (baseline) ->
# run.py caption score (gemma) + qwen3-vl-4b placement check -> rank ->
# HTML gallery (all seeds + verdicts, winner highlighted).
#
# Usage: bash scripts/multi-seed-autoselect.sh [N_SEEDS]
set -euo pipefail
REPO="/Users/huangziyu/proj/video_generation"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
PY="$REPO/python/venv/bin/python"
OUT="$REPO/swift/flux2-image-director/test_cases/autoselect"
N="${1:-5}"
mkdir -p "$OUT"

REF_A="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe, hands on hips, vivid neon PINK hair, red jacket, black pants, plain gray background, even lighting, sharp focus"
REF_B="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe, arms crossed, vivid TEAL green hair, blue jacket, white pants, plain gray background, even lighting, sharp focus"
SCENE="two young women standing side by side facing the camera, full body head to toe, the woman with vivid neon pink hair in a red jacket is on the LEFT with hands on hips, the woman with teal green hair in a blue jacket is on the RIGHT with arms crossed, plain neutral background, photorealistic, natural hands"

if [ ! -f "$OUT/refA.png" ] || [ ! -f "$OUT/refB.png" ]; then
  echo "==> refs"; "$ZIMAGE" t2i --prompt "$REF_A" --transformer moody-pro-mix --width 768 --height 1024 --seed 3311 --strict-gate --output-dir "$OUT" --name refA 2>&1 | tail -1
  "$ZIMAGE" t2i --prompt "$REF_B" --transformer moody-pro-mix --width 768 --height 1024 --seed 4422 --strict-gate --output-dir "$OUT" --name refB 2>&1 | tail -1
fi

SEEDS=$(python3 -c "print(' '.join(str(100+i*37) for i in range($N)))")
echo "==> flux2 scene x $N seeds: $SEEDS"
for S in $SEEDS; do
  "$FLUX2" scene --ref "$OUT/refA.png" --ref "$OUT/refB.png" --prompt "$SCENE" \
    --width 1024 --height 1024 --steps 6 --seed "$S" \
    --output-dir "$OUT" --name "seed_${S}" 2>&1 | tail -1
  "$PY" "$REPO/python/mlx-movie-director/run.py" caption "$OUT/seed_${S}.png" --style score --lang en >/dev/null 2>&1
  echo "  seed $S done + scored"
done

echo "==> verify + rank + HTML"
"$PY" "$REPO/swift/flux2-image-director/scripts/autoselect-rank.py" "$OUT" $SEEDS
echo "==> DONE: $OUT/autoselect-report.html"
