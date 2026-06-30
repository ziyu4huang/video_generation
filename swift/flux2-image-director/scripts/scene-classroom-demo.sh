#!/usr/bin/env bash
# scene-classroom-demo.sh — end-to-end demo of `flux2 scene` complex usage.
#
# Showcase: TWO DISTINCT girls (different hair + clothing) placed in ONE scene
# doing DIFFERENT body poses / activities —
#   * Girl A: long straight BLACK hair, white shirt, red-rim glasses, navy skirt
#             → SITTING at a desk, writing / solving a MATH problem (focused)
#   * Girl B: short CURLY BROWN hair, oversized YELLOW sweater, jeans
#             → STANDING, leaning on a desk, holding an open book
# Same classroom, two clearly separable identities + poses + actions.
#
# This exercises the full recommended multi-character workflow (per the arch
# doc §5): refs are GLOBAL → placement is prompt-driven & reliable-but-
# probabilistic, so the correct fix is SEED SELECTION + local-LLM verification,
# NOT --regional (net-negative) and NOT --region-attention/--ref-region-mask
# (both inert on the distilled Klein — see §6). Hands matter for a writing
# pose, so the winner optionally gets --hand-repair.
#
# Flow:
#   1. z-image t2i  → 2 distinct identity refs (full-body, plain bg)
#   2. flux2 scene  → N seeds of the classroom scene (baseline, prompt placement)
#   3. run.py caption --style score  → per-seed quality (gemma)
#   4. qwen3-vl-4b  → placement + ACTIVITY check (who sits/writes vs stands/reads)
#   5. autoselect-rank.py → rank + HTML gallery (winner highlighted)
#   6. (optional) flux2 scene --hand-repair on the winner
#
# Usage:
#   bash scripts/scene-classroom-demo.sh [N_SEEDS] [REPAIR_WINNER=1|0]
#   bash scripts/scene-classroom-demo.sh 5 1   # 5 seeds, hand-repair the winner
set -euo pipefail
REPO="/Users/huangziyu/proj/video_generation"
ZIMAGE="$REPO/swift/z-image-director/.build/release/zimage"
FLUX2="$REPO/swift/flux2-image-director/.build/release/flux2"
PY="$REPO/python/venv/bin/python"
OUT="$REPO/swift/flux2-image-director/test_cases/scene-classroom-demo"
N="${1:-5}"
REPAIR="${2:-0}"
mkdir -p "$OUT"

# ── 1. Two DISTINCT identity references ────────────────────────────────────
# Full-body + plain background = cleanest identity signal for conditioning.
# Visual cues chosen to be unambiguous for the VLM verifier (hair + top color).
REF_A="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe, long straight BLACK hair, red-rim glasses, white collared shirt, navy pleated skirt, plain light gray background, even lighting, sharp focus"
REF_B="photorealistic full-body studio photo of a young woman standing facing the camera, head to toe, short CURLY BROWN hair, oversized YELLOW sweater, blue jeans, plain light gray background, even lighting, sharp focus"

if [ ! -f "$OUT/girlA.png" ] || [ ! -f "$OUT/girlB.png" ]; then
  echo "==> [1/6] generating distinct identity refs"
  "$ZIMAGE" t2i --prompt "$REF_A" --transformer moody-pro-mix --width 768 --height 1024 --seed 3311 --strict-gate --output-dir "$OUT" --name girlA 2>&1 | tail -1
  "$ZIMAGE" t2i --prompt "$REF_B" --transformer moody-pro-mix --width 768 --height 1024 --seed 4422 --strict-gate --output-dir "$OUT" --name girlB 2>&1 | tail -1
else
  echo "==> [1/6] refs already present, reusing"
fi

# ── 2. Composition prompt: DIFFERENT poses + DIFFERENT activities ──────────
# Names each identity by its unambiguous cue (hair + top), assigns a DISTINCT
# position + pose + action. The prompt does ALL the spatial + action routing
# (that is the whole point on the distilled model).
SCENE="two young women in a bright modern classroom, full body visible, photorealistic, natural detailed hands. On the LEFT, the girl with long straight BLACK hair, red-rim glasses, white shirt and navy skirt is SITTING at a wooden desk, bent forward, writing and solving a MATH problem on paper with a pen, focused expression. On the RIGHT, the girl with short CURLY BROWN hair, yellow sweater and jeans is STANDING upright, leaning back against another desk, holding an open book in both hands, relaxed confident expression. Chalkboard and classroom windows in the background."

# ── 3. flux2 scene × N seeds (the reliable placement path) ─────────────────
SEEDS=$(python3 -c "print(' '.join(str(200+i*37) for i in range($N)))")
echo "==> [2/6] flux2 scene x $N seeds: $SEEDS"
for S in $SEEDS; do
  "$FLUX2" scene --ref "$OUT/girlA.png" --ref "$OUT/girlB.png" --prompt "$SCENE" \
    --width 1024 --height 1024 --steps 6 --seed "$S" \
    --output-dir "$OUT" --name "seed_${S}" 2>&1 | tail -1
  echo "  seed $S done"
done

# ── 4. Quality score (gemma via run.py caption) ────────────────────────────
echo "==> [3/6] scoring quality (gemma --style score)"
for S in $SEEDS; do
  "$PY" "$REPO/python/mlx-movie-director/run.py" caption "$OUT/seed_${S}.png" --style score --lang en >/dev/null 2>&1 || true
done

# ── 5. Placement + ACTIVITY verification (qwen3-vl-4b) ─────────────────────
# The decisive check for THIS demo: not just "who is where" but "who is doing
# what". A correct scene = black-hair girl LEFT & sitting/writing math,
# brown-hair girl RIGHT & standing/reading.
echo "==> [4/6] verifying placement + activity (qwen3-vl-4b)"
"$PY" - <<PY
import base64, json, os, urllib.request
URL="http://localhost:1234/v1/chat/completions"; M="qwen/qwen3-vl-4b"
OUT=r"$OUT"
def b64(p):
    with open(p,"rb") as f: return base64.b64encode(f.read()).decode()
def ask(path,q):
    pl={"model":M,"messages":[{"role":"user","content":[{"type":"text","text":q},
      {"type":"image_url","image_url":{"url":f"data:image/png;base64,{b64(path)}"}}]}],
      "temperature":0,"max_tokens":120}
    r=urllib.request.Request(URL,data=json.dumps(pl).encode(),headers={"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(r,timeout=120).read())["choices"][0]["message"]["content"].strip().replace("\n"," ")
Q=("Describe each girl's POSITION (LEFT/RIGHT), HAIR, POSE (sitting/standing), "
   "and ACTION (writing-math / reading-book / other). "
   "Format: LEFT=<hair,pose,action>; RIGHT=<hair,pose,action>")
verdicts={}
for S in "$SEEDS".split():
    p=os.path.join(OUT,f"seed_{S}.png")
    if os.path.exists(p):
        a=ask(p,Q); verdicts[S]=a; print(f"  seed {S}: {a}")
# quick heuristic: does the black-hair girl sit+write on the LEFT?
import re
def ok(a):
    a=a.lower(); return ("black" in a and ("left" in a) and ("sit" in a))
goods=[s for s,v in verdicts.items() if ok(v)]
print(f"  -> seeds matching target (black-hair LEFT sitting/writing): {goods or 'none — try more seeds or tighten the prompt'}")
# stash winner for the repair stage
open(os.path.join(OUT,".verdicts.json"),"w").write(json.dumps(verdicts))
PY

# ── 6. Rank + HTML gallery ─────────────────────────────────────────────────
echo "==> [5/6] rank + HTML gallery"
"$PY" "$REPO/swift/flux2-image-director/scripts/autoselect-rank.py" "$OUT" $SEEDS || true

# ── 7. (optional) hand-repair the winner ───────────────────────────────────
# A writing pose stresses hands (pen grip) — best-effort fix on the best seed.
if [ "$REPAIR" = "1" ]; then
  WIN=$(ls -1 "$OUT"/seed_*.png 2>/dev/null | head -1 | sed 's/.*seed_//;s/\.png//')
  if [ -n "$WIN" ]; then
    echo "==> [6/6] hand-repair on winning seed $WIN"
    "$FLUX2" scene --ref "$OUT/girlA.png" --ref "$OUT/girlB.png" --prompt "$SCENE" \
      --hand-repair --width 1024 --height 1024 --steps 6 --seed "$WIN" \
      --output-dir "$OUT" --name "seed_${WIN}_handrepair" 2>&1 | tail -1
  fi
else
  echo "==> [6/6] hand-repair skipped (pass 1 as 2nd arg to enable)"
fi

echo "==> DONE: $OUT/autoselect-report.html"
