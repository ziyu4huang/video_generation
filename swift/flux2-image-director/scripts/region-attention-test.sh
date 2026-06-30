#!/usr/bin/env bash
# region-attention-test.sh — A/B for the in-denoise block-masked region attention.
#
# The decisive experiment is a MASK-vs-PROMPT CONFLICT: the prompt says
# "pink LEFT, teal RIGHT" but --ref-mask assigns pink→RIGHT, teal→LEFT.
#   - If region attention BINDS → mask wins → pink lands RIGHT.
#   - If the distilled model IGNORES the mask (OOD) → prompt wins → pink LEFT.
#
# Result (2026-06-30, qwen3-vl-4b verified, 3 seeds 100/137/211): the prompt
# won on every seed — region attention does NOT bind placement on the distilled
# Klein model. Quality-neutral (overall 6 / artifacts 5, same as baseline) but
# ~2× slower. See docs/multi-reference-architecture.md §6.
#
# Usage: bash scripts/region-attention-test.sh
set -euo pipefail
REPO="/Users/huangziyu/proj/video_generation"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
PY="$REPO/python/venv/bin/python"
OUT="$REPO/swift/flux2-image-director/test_cases/region-attn-ab"
mkdir -p "$OUT"

REF_A="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe, hands on hips, vivid neon PINK hair, red jacket, black pants, plain gray background, even lighting, sharp focus"
REF_B="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe, arms crossed, vivid TEAL green hair, blue jacket, white pants, plain gray background, even lighting, sharp focus"
# Prompt says pink LEFT / teal RIGHT (conflicts with the masks below).
SCENE="two young women standing side by side facing the camera, full body head to toe, the woman with vivid neon pink hair in a red jacket is on the LEFT with hands on hips, the woman with teal green hair in a blue jacket is on the RIGHT with arms crossed, plain neutral background, photorealistic, natural hands"

# Refs (reuse if present).
if [ ! -f "$OUT/refA.png" ] || [ ! -f "$OUT/refB.png" ]; then
  echo "==> refs"; "$ZIMAGE" t2i --prompt "$REF_A" --transformer moody-pro-mix --width 768 --height 1024 --seed 3311 --strict-gate --output-dir "$OUT" --name refA 2>&1 | tail -1
  "$ZIMAGE" t2i --prompt "$REF_B" --transformer moody-pro-mix --width 768 --height 1024 --seed 4422 --strict-gate --output-dir "$OUT" --name refB 2>&1 | tail -1
fi

# Conflict masks: pink→RIGHT half, teal→LEFT half (swapped vs the prompt).
"$PY" - <<PY
import numpy as np; from PIL import Image
W=H=1024
pink=np.zeros((H,W),np.uint8); pink[:,W//2:]=255
teal=np.zeros((H,W),np.uint8); teal[:,:W//2]=255
Image.fromarray(pink).save("$OUT/mask_pink_right.png")
Image.fromarray(teal).save("$OUT/mask_teal_left.png")
PY

echo "==> A: baseline (global refs, prompt placement)"
"$FLUX2" scene --ref "$OUT/refA.png" --ref "$OUT/refB.png" --prompt "$SCENE" \
  --width 1024 --height 1024 --steps 6 --seed 100 --strict-gate --output-dir "$OUT" --name A_baseline 2>&1 | tail -1

echo "==> B: region-attention (vertical strips, no conflict)"
"$FLUX2" scene --ref "$OUT/refA.png" --ref "$OUT/refB.png" --region-attention --prompt "$SCENE" \
  --width 1024 --height 1024 --steps 6 --seed 100 --strict-gate --output-dir "$OUT" --name B_strips 2>&1 | tail -1

echo "==> C: CONFLICT — mask pink→RIGHT / teal→LEFT vs prompt pink-LEFT"
for S in 100 137 211; do
  "$FLUX2" scene --ref "$OUT/refA.png" --ref "$OUT/refB.png" \
    --region-attention --ref-mask "$OUT/mask_pink_right.png" --ref-mask "$OUT/mask_teal_left.png" \
    --prompt "$SCENE" --width 1024 --height 1024 --steps 6 --seed "$S" --strict-gate \
    --output-dir "$OUT" --name "C_conflict_s${S}" 2>&1 | tail -1
done

echo "==> VLM placement verdict (qwen3-vl-4b)"
"$PY" - <<PY
import base64, json, urllib.request
URL="http://localhost:1234/v1/chat/completions"; M="qwen/qwen3-vl-4b"
def b64(p):
    with open(p,"rb") as f: return base64.b64encode(f.read()).decode()
def ask(path,q):
    pl={"model":M,"messages":[{"role":"user","content":[{"type":"text","text":q},
      {"type":"image_url","image_url":{"url":f"data:image/png;base64,{b64(path)}"}}]}],"temperature":0,"max_tokens":80}
    r=urllib.request.Request(URL,data=json.dumps(pl).encode(),headers={"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(r,timeout=120).read())["choices"][0]["message"]["content"].strip().replace("\\n"," ")
OUT="$OUT"
Q="The woman with neon PINK hair is on which side (LEFT/RIGHT)? The TEAL-green-hair woman? Format: PINK=<>, TEAL=<>"
import os
for n in ["A_baseline.png","B_strips.png","C_conflict_s100.png","C_conflict_s137.png","C_conflict_s211.png"]:
    p=os.path.join(OUT,n)
    if os.path.exists(p):
        print(f"{n:24s} {ask(p,Q)}")
print("binding check: if region-attn binds, C_* should read PINK=RIGHT,TEAL=LEFT")
PY
echo "==> DONE: $OUT"
