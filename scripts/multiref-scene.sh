#!/usr/bin/env bash
#
# multiref-scene.sh — reproduce the ComfyUI "三參考圖全能王" workflow in pure Swift:
#   z-image (moody-pro-mix, photoreal T2I) generates 3 reference images
#     ref1 = character A,  ref2 = character B,  ref3 = background scene
#   flux2 scene consumes them (+ a composition prompt) to compose the final scene.
# Every image is self-gated (shared ImageGate); refs use --strict-gate so a noise /
# blank ref aborts before flux2 wastes GPU. Finally writes scene-relations.json and
# builds a self-contained, badged gallery HTML.
#
# Usage:  bash scripts/multiref-scene.sh [--open]
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
GALLERY="$REPO/swift/flux2-image-director/scripts/scene-gallery.ts"
OUT="$(cd "$REPO/.." && pwd)/video_generation__output"
mkdir -p "$OUT"
OPEN=${1:-}

PROMPT_A="photorealistic portrait of a young East Asian woman, short bob hair, navy school uniform, calm neutral expression, soft studio lighting, plain gray background, sharp focus, high detail"
PROMPT_B="photorealistic portrait of a young East Asian man, short black hair, thin glasses, white shirt, calm neutral expression, soft studio lighting, plain gray background, sharp focus, high detail"
PROMPT_BG="empty bright classroom interior, rows of wooden desks, large windows with soft daylight, green chalkboard, wide establishing shot, no people, photorealistic, high detail"
SCENE_PROMPT="a young woman with short bob hair in a navy uniform and a young man with thin glasses in a white shirt sit at adjacent wooden desks in a bright classroom, taking a written exam, calm and focused, daylight from large windows"

echo "==> [1/4] z-image: generate ref1 (character A)"
"$ZIMAGE" t2i --prompt "$PROMPT_A" --transformer moody-pro-mix \
  --width 640 --height 960 --seed 101 --strict-gate --name ref1_charA
echo "==> [2/4] z-image: generate ref2 (character B)"
"$ZIMAGE" t2i --prompt "$PROMPT_B" --transformer moody-pro-mix \
  --width 640 --height 960 --seed 202 --strict-gate --name ref2_charB
echo "==> [3/4] z-image: generate ref3 (background)"
"$ZIMAGE" t2i --prompt "$PROMPT_BG" --transformer moody-pro-mix \
  --width 1024 --height 1024 --seed 303 --strict-gate --name ref3_bg

echo "==> [4/4] flux2: compose scene from 3 references"
"$FLUX2" scene \
  --ref "$OUT/ref1_charA.png" --ref "$OUT/ref2_charB.png" --ref "$OUT/ref3_bg.png" \
  --prompt "$SCENE_PROMPT" \
  --width 1024 --height 1024 --steps 6 --seed 42 --name scene_multiref_real

# --- relations manifest for the gallery --------------------------------------
SCENE_PNG="$OUT/scene_multiref_real.png"
REL="$OUT/scene-relations.json"
cat > "$REL" <<JSON
{
  "title": "z-image refs → flux2 scene (two-stage, real refs)",
  "root": "$OUT",
  "refs": [
    {"id":"ref1","label":"ref1_charA (z-image)","path":"ref1_charA.png","note":"character A — short bob hair, navy uniform"},
    {"id":"ref2","label":"ref2_charB (z-image)","path":"ref2_charB.png","note":"character B — glasses, white shirt"},
    {"id":"ref3","label":"ref3_bg (z-image)","path":"ref3_bg.png","note":"background — empty classroom (v1: steers environment)"}
  ],
  "outputs": [
    {"id":"scene","label":"flux2 scene — 3 refs (1024²/6)","path":"scene_multiref_real.png",
     "sources":["ref1","ref2","ref3"],"runJson":"scene_multiref_real.run.json",
     "note":"ref3 is a 3rd reference steering environment (not a literal composited backdrop in v1)"}
  ]
}
JSON
echo "wrote $REL"

echo "==> building self-contained gallery (with gate badges)"
bun "$GALLERY" --manifest "$REL" --out "$OUT/scene-gallery.html" --gate ${OPEN:+--open}
echo "✅ done → $OUT/scene-gallery.html"
