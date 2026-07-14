#!/usr/bin/env bash
#
# flux2-full-lora-stack.sh — reproduce the ComfyUI "卡通转真人工厂" 12-LoRA stack
# end-to-end in pure Swift. z-image generates 3 reference images (2 characters +
# 1 background), then `flux2 scene` composes them with the FULL 12-LoRA quality
# stack rank-merged into one adapter (Flux2LoRALoader.merge). Every image is
# self-gated; refs use --strict-gate.
#
# This is the proof the full workflow runs in flux2-image-director: each LoRA
# logs its adapter count (>0 = the BFL-format remap in convert_lora_mlx.py held).
#
# Usage:  bash scripts/flux2-full-lora-stack.sh [--reuse-refs] [--open]
#   --reuse-refs : skip z-image regeneration, reuse any existing ref*.png
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
OUT="$(cd "$REPO/.." && pwd)/video_generation__output"
mkdir -p "$OUT"
REUSE=0; OPEN=""
for a in "$@"; do
  case "$a" in --reuse-refs) REUSE=1;; --open) OPEN="--open";; esac
done

PROMPT_A="photorealistic portrait of a young East Asian woman, short bob hair, navy school uniform, calm neutral expression, soft studio lighting, plain gray background, sharp focus, high detail"
PROMPT_B="photorealistic portrait of a young East Asian man, short black hair, thin glasses, white shirt, calm neutral expression, soft studio lighting, plain gray background, sharp focus, high detail"
PROMPT_BG="empty bright classroom interior, rows of wooden desks, large windows with soft daylight, green chalkboard, wide establishing shot, no people, photorealistic, high detail"
SCENE_PROMPT="a young woman with short bob hair in a navy uniform and a young man with thin glasses in a white shirt sit at adjacent wooden desks in a bright classroom, calm and focused, daylight from large windows"

if [ "$REUSE" = 0 ] || [ ! -f "$OUT/ref3_bg.png" ]; then
  echo "==> [1/4] z-image: ref1 (character A)"; "$ZIMAGE" t2i --prompt "$PROMPT_A" --transformer moody-pro-mix --width 640 --height 960 --seed 101 --strict-gate --name ref1_charA
  echo "==> [2/4] z-image: ref2 (character B)"; "$ZIMAGE" t2i --prompt "$PROMPT_B" --transformer moody-pro-mix --width 640 --height 960 --seed 202 --strict-gate --name ref2_charB
  echo "==> [3/4] z-image: ref3 (background)";  "$ZIMAGE" t2i --prompt "$PROMPT_BG" --transformer moody-pro-mix --width 1024 --height 1024 --seed 303 --strict-gate --name ref3_bg
else
  echo "==> [1-3/4] reusing existing refs"
fi

# The full 12-LoRA 卡通转真人工厂 stack, at the workflow's per-LoRA scales.
echo "==> [4/4] flux2 scene: 2 refs + bg canvas + FULL 12-LoRA stack"
"$FLUX2" scene \
  --ref "$OUT/ref1_charA.png" --ref "$OUT/ref2_charB.png" \
  --bg "$OUT/ref3_bg.png" --bg-strength 0.55 \
  --lora anything2real-a        --lora anything2real-characters \
  --lora chest-9b               --lora skin-tone \
  --lora lips-9b                --lora eye-9b \
  --lora details-9b             --lora longface-9b \
  --lora colorful               --lora qualitya \
  --lora darkklein-v2bfs-r256   --lora nexblend-asian \
  --lora-scale 0.5  --lora-scale 0.8  --lora-scale 1.0  --lora-scale 1.0 \
  --lora-scale 1.0  --lora-scale 0.5  --lora-scale 0.8  --lora-scale 0.5 \
  --lora-scale 0.5  --lora-scale 0.8  --lora-scale 0.25 --lora-scale 0.8 \
  --prompt "$SCENE_PROMPT" \
  --width 1024 --height 1024 --steps 6 --seed 42 --name scene_full_12lora_stack

SCENE_PNG="$OUT/scene_full_12lora_stack.png"
REL="$OUT/full-stack-relations.json"
cat > "$REL" <<JSON
{
  "title": "z-image refs → flux2 scene (FULL 12-LoRA 卡通转真人工厂 stack)",
  "root": "$OUT",
  "refs": [
    {"id":"ref1","label":"ref1_charA (z-image)","path":"ref1_charA.png","note":"character A"},
    {"id":"ref2","label":"ref2_charB (z-image)","path":"ref2_charB.png","note":"character B"},
    {"id":"ref3","label":"ref3_bg (z-image)","path":"ref3_bg.png","note":"background (--bg canvas)"}
  ],
  "outputs": [
    {"id":"scene","label":"flux2 scene — 2 refs + bg + 12 LoRAs (1024²/6)","path":"scene_full_12lora_stack.png",
     "sources":["ref1","ref2","ref3"],"runJson":"scene_full_12lora_stack.run.json",
     "note":"all 12 LoRAs rank-merged into one adapter via Flux2LoRALoader.merge"}
  ]
}
JSON
echo "wrote $REL"
bun "$REPO/swift/flux2-image-director/scripts/scene-gallery.ts" --manifest "$REL" --out "$OUT/full-stack-gallery.html" --gate ${OPEN}
echo "✅ done → $OUT/full-stack-gallery.html"
