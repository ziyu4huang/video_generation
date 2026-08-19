# Multi-Character Composition (MLX / Z-Image)

Put **two distinct characters** — same art style, different look/body/age — into
**one** picture, using the MLX pipeline (`run.py`) + a dynamic workflow.

This documents the technique shipped in this PR, the exact `run.py` commands,
and a known limitation (no regional prompting in MLX) with a planned R&D
follow-up.

## The problem

You want two girls in one frame: same dreamlike painterly style, but clearly
different people (different hair, age, build, outfit). There are three classic
ways to do this in diffusion tooling:

| Approach | Style consistency | Appearance differentiation | In MLX? |
|---|---|---|---|
| Single prompt ("A and B …") | high | **low** — token bleeding merges the two | ✅ but weak |
| Regional prompting / attention-couple | high | high (per-region attention mask) | ❌ not implemented |
| Composite + seam-blend | medium→high | very high (independent generations) | ✅ **(this PR)** |

**Why not a single prompt?** Cross-attention has no notion of which attribute
belongs to which subject — "black hair" and "blonde hair" both tug at every
pixel, so the two subjects bleed together (hair/eye/outfit swaps). It works
"well enough" only for very similar subjects.

**Why not regional prompting?** MLX has no regional-prompter / attention-couple
/ latent-couple. The ComfyUI mechanism (mask which spatial image tokens each
text-token may attend to, per region) has simply never been ported. See
**Planned follow-up** below — the hook point turns out to be unusually clean.

## `image twosubject` — single-prompt + local VLM (recommended today)

The composite below (`image multicouple`) hits a structural ceiling: each
character is baked with its own lighting/scale/pose, and the resume pass only
repaints the background, so the result reads as "two photos pasted together"
no matter how low the measured color split. `image twosubject` instead generates
**both characters in a single coherent pass** (one shared light/scale/scene —
the source of naturalness) and lets the **local VLM** (Qwen3-VL via LM Studio)
beat the single-prompt weakness (token bleeding) automatically:

1. **Prompt master** — the VLM composes ONE anti-bleeding two-subject prompt from
   two descriptions (or two reference images via i2t caption): a shared
   scene+lighting prefix, each subject anchored to FAR LEFT / FAR RIGHT, attributes
   grouped so the DiT binds them to the right subject.
2. **Best-of-N** — generate N seeds with that one prompt (serial, GPU-safe).
3. **VLM judge** — score every seed (both present? distinct? natural?) and pick the
   best; an objective background edge-split is the final tiebreak.
4. **Revise (opt)** — below `--min-overall` with `--rounds>1`, the VLM diagnoses the
   bleeding and rewrites the prompt.

```bash
python/venv/bin/python python/mlx-movie-director/run.py image twosubject \
  --char-a "<appearance A>" --char-b "<appearance B>" \
  --candidates 12 --detail      # --detail = 768x1152/20 for max facial/fabric detail
```

`--ref-a` / `--ref-b` feed two reference images (the VLM captions them and SEES
them while composing). Fully automatic — no human feedback. Validated 2026-06-25:
the `--detail` winner's per-face detail matches the single-subject benchmark, and
the single-prompt winner beats the composite on naturalness, distinctness, AND
background split simultaneously.

## Latent-Couple (current approach)

The current approach composites in **latent space**, not pixel space:

1. generate charA and charB each with a shared style anchor, but **return the
   latent** (pre-VAE-decode) instead of decoding to pixels;
2. composite the two latents side-by-side with a feathered vertical seam
   (`composite_latents_side_by_side`); then
3. **resume-denoise** the merged latent from a mid timestep — the DiT's joint
   self-attention crosses the seam and regenerates ONE coherent background.

**Why latent, not pixel?** Each source latent already encodes *character + its
own background*. Compositing in pixel space bakes two incompatible backgrounds
in — the VAE encode of a hard seam is a fact a low-denoise i2i pass cannot undo,
so the central seam stayed visible (the v1 pixel pipeline scored ~**2/5**
background continuity: left half = sharp brown dappled shadows, right half =
soft green ethereal mist — two different environments pasted together). In
latent space there is no decode→encode round-trip, and the resume denoise gives
the model's self-attention the freedom to propagate background texture/lighting
across the join into a single scene.

```bash
# Two dreamlike girls (luciddreamer-z), merged in latent space.
python/venv/bin/python python/mlx-movie-director/run.py image multicouple \
  --pipeline zimage --transformer luciddreamer-z \
  --width 640 --height 960 --steps 9 \
  --prompt-a "<appearance A, left of frame, gaze right>" \
  --prompt-b "<appearance B, right of frame, gaze left>" \
  --merge-denoise 0.6 --merge-feather 8 --merge-seed 42 \
  --json-summary
```

Knobs:
- `--merge-denoise` (0.5–0.85): resume strength. Sentinel default — 0.6 normally,
  auto-bumps to 0.8 when `--lock-chars` is on (characters are pinned, so the
  background can repaint harder). Higher unifies the background more, at more
  character drift *unless* `--lock-chars` pins them.
- `--merge-feather` (latent cols; image px = ×8): the seam feather width.
- `--cfg-scale`: ON by default at 3.0 for every pass (CFG is the biggest Z-Image
  quality lever); override with `--cfg-scale 0` to disable.
- `--style`: trailing tags appended to BOTH prompts (the style-consistency lever).
- `--color-match` (DEFAULT ON; `--no-color-match` to disable): SAM3-segment each
  character, measure each image's BACKGROUND color temperature, and shift both
  images so their bg means land on a shared midpoint, then re-encode. **The fix
  for the cool-left/warm-right background split** — each character is generated in
  its own color-temperature world, baked into the latent; matching them at the
  source is the only lever (see "Why the split happens" below).
- `--lock-chars` (masked Repaint variant): pin the character region every resume
  step so the background can be denoised HARD (denoise auto→0.8) with zero
  character drift. On its own it does NOT fix the tone split (locking cold/warm
  characters re-injects their tones via attention), but combined with
  `--color-match` it is the strongest configuration (see below). Reuses the same
  SAM3 segmentation as `--color-match`.
- `--lock-dilate` (px, default 4): expand each character mask before locking, so
  the character's feather edge is pinned (no char-edge bleed into the repainted
  background).

**Recommended (best background unity): `--color-match --lock-chars` (the combo).**
Color-match unifies the source color-temperatures → lock-chars pins the now-
non-conflicting characters → the hard resume regenerates ONE coherent background.
This is the workflow default and produces the best samples.

This is implemented in `app/commands/image-multicouple.py`, on top of two small
`ZImagePipeline.generate()` additions: an `init_latent` param (start from a
latent, skip VAE encode) and `return_latent` (capture the pre-decode latent).
The latent composite lives in `app/pipeline.composite_latents_side_by_side`.

## v1: pixel composite + seam-blend (legacy baseline)

The first attempt used the third classic approach: generate each character
separately with a **shared style anchor**, composite them side-by-side in
**pixels**, then seam-blend with a low-denoise i2i. It works but cannot unify
two genuinely different backgrounds (see above) — kept here as the comparison
baseline and as the fallback if a future model lacks the `init_latent` path.

## The pipeline (4 phases)

All GPU steps are **serial** — one model process at a time (Apple Silicon).

```
1. Generate   charA, charB  (run.py image t2i — same transformer + style tags, diff look + seed)
2. Compose    side-by-side  (PIL — feathered vertical seam in the background gap)
3. Harmonize  seam-blend     (run.py image i2i — NO ControlNet — heal seam + unify lighting)
4. Reflect    self-explain   (run.py caption — VLM describes/assesses the result; default on)
```

The **style-consistency lever** is identical for both characters:
- the **same transformer** (`luciddreamer-z` here, matching the reference run), and
- the **same trailing style tags** (`cinematic lighting, hyperdetailed, imaginative,
  soft ethereal glow, painterly fantasy atmosphere`).

Each character's prompt then only differs on **appearance + composition**: which
side of the frame, gaze direction (so the two face each other once composited),
age, hair, build, outfit.

### Commands (what produced the samples)

From the repo root (`python/venv/bin/python …`):

```bash
# 1a. Girl A — left, raven hair, white dress, looking right
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline zimage --transformer luciddreamer-z \
  --width 640 --height 960 --steps 9 --seed 42 \
  --prompt "a dreamlike surreal portrait of a young 19-year-old girl, standing on the \
left side of the frame, slim petite build, long straight raven-black hair, delicate \
porcelain skin, large dark eyes, soft natural makeup, wearing a flowing white summer \
dress with subtle silver embroidery, gentle shy smile, looking toward the right, \
cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere" \
  --json-summary

# 1b. Girl B — right, auburn hair, green gown, looking left
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline zimage --transformer luciddreamer-z \
  --width 640 --height 960 --steps 9 --seed 777 \
  --prompt "a dreamlike surreal portrait of a 26-year-old woman, standing on the right \
side of the frame, taller athletic curvy build, wavy auburn copper hair, warm tan skin, \
green eyes, elegant bold makeup, wearing a deep emerald silk gown, confident serene \
expression, looking toward the left, cinematic lighting, hyperdetailed, imaginative, \
soft ethereal glow, painterly fantasy atmosphere" \
  --json-summary

# 2. Compose — side-by-side with a 60px feathered vertical seam
python/venv/bin/python - <<'PY'
from PIL import Image
import numpy as np
A = "<charA>.png"; B = "<charB>.png"
W, H, O = 640, 960, 60                 # O = seam feather (overlap band)
a = np.array(Image.open(A).convert("RGB").resize((W, H))).astype(np.float32)
b = np.array(Image.open(B).convert("RGB").resize((W, H))).astype(np.float32)
cw = 2 * W - O
canvas = np.zeros((H, cw, 3), dtype=np.float32)
canvas[:, 0:W] = a
alpha = np.linspace(0.0, 1.0, O)[None, :, None]
canvas[:, W - O:W] = (1 - alpha) * a[:, W - O:W] + alpha * b[:, 0:O]
canvas[:, W:] = b[:, O:]
Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).save("multichar_compose.png")
PY

# 3. Harmonize — I2I seam-blend. NOTE: no --reference-image => ControlNet OFF,
#    pure img2img. Low denoise heals the seam + unifies lighting while keeping
#    each girl's identity. (Requires the i2i quant fix in this PR — see below.)
python/venv/bin/python python/mlx-movie-director/run.py image i2i \
  --pipeline zimage --transformer luciddreamer-z \
  --input multichar_compose.png \
  --prompt "two young women standing together in a dreamlike surreal fantasy scene, one \
on the left in a white dress, one on the right in a green gown, facing each other, \
unified cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly \
fantasy atmosphere" \
  --denoise-strength 0.35 --seed 42 --steps 9 --json-summary

# 4. Reflect — VLM understands + explains the result (default-on self-reflection)
python/venv/bin/python python/mlx-movie-director/run.py caption <final>.png --style default --lang en
```

### Why these choices

- **`image swap` is NOT used for the merge.** `swap` is a *replacement* op (SAM3
  segments a region in the source, pastes a reference there, blends). It cannot
  *add* a second character to empty space — SAM3 segments semantic content, not
  "the right half of the canvas." Composite-then-blend is the right tool.
- **The seam is placed in the background gap**, not across a face. The 60px
  feather pre-blends the two backgrounds; the I2I pass finishes the job.
- **`--denoise-strength 0.35`** is the sweet spot: high enough to heal the seam
  and unify lighting (and even re-align gazes toward "facing each other"), low
  enough to preserve each girl's identity. Bump to ~0.45 if the seam/gaze needs
  more correction (at higher identity-drift risk).

## Sample result

Reference style anchor: the run at
`../video_generation__output/output_20260621_103926.run.json`
(`zimage` / `luciddreamer-z`, dreamlike surreal portrait). Samples live in
`../video_generation__output/` (externalized, not committed). Same two girls
(A=raven-hair/white-dress seed 42, B=auburn-hair/green-gown seed 777) generated
both ways for a direct comparison:

| File | Approach | bg edge-split | bg corner-split | brightness-gap |
|---|---|---|---|---|
| `i2i_dn0.35_9st-s42.png` | **v1** pixel composite + low-denoise i2i | — (hard seam) | — | — |
| `multicouple_dn0.6_f8_9st-s42.png` | **v2** Latent-Couple (plain resume) | +22.7 | +40.7 | 107 |
| `multicouple_masked_dn0.8_f8_9st-s42.png` | **v3** + `--lock-chars` (Repaint) | +21.6 | +36.5 | 113 |
| `multicouple_cm_dn0.6_f8_9st-s42.png` | **v4** + `--color-match` | +12.7 | +27.3 | 90 |
| `multicouple_masked_cm_dn0.85_f8_9st-s42.png` | **v5** + `--color-match --lock-chars` (combo) | **+8.3** | **−0.5** | 76 |

(splits = `warm(R−B)_right − warm(R−B)_left` over background edge/corner strips;
0 = unified. brightness-gap = `|lum_right − lum_left|`.)

### Why the split happens, and why the combo wins

The v2 plain resume left a cool-left / warm-right background split. Three
follow-up variants were measured objectively (background edge/corner color split
+ brightness gap), and the diagnosis refines with each:

- **`--lock-chars` alone (v3) does NOT help** (+22→+22 edge). The split is not a
  compositing seam — it is each character generated in its own color-temperature
  *world* (cool for the black-hair/white-dress/pale subject, warm for the
  orange-hair/green-gown/tan subject), baked into the latent. Locking the
  characters re-injects those conflicting tones into the adjacent background via
  the DiT's spatial self-attention every step, so the hard background repaint
  cannot unify them. Locking *preserves* (even reinforces) the split.
- **`--color-match` alone (v4) halves it** (+22→+13 edge). Shifting both source
  images so their background means land on a shared midpoint removes the
  temperature gap *at the source*, before the resume. Residual remains because
  the two worlds also differ in **brightness/lighting structure** (dappled
  spotlight vs flat wash), which a mean-shift cannot equalize.
- **The combo (v5) wins** (+22→+8 edge, **+41→0 corner**). The three levers
  complement: color-match unifies the source temperature → lock-chars now pins
  *non-conflicting* characters → the hard resume (denoise 0.85) is free to
  regenerate one coherent background/lighting. The residual reads as a natural
  single-source gradient, not a pasted seam.

## The dynamic workflow

`.claude/workflows/multi-character-compose.js` orchestrates all four phases
(serial, GPU-safe). Run with defaults (reproduces the samples above):

```js
Workflow({ scriptPath: "<repo>/.claude/workflows/multi-character-compose.js" })
```

Or parameterize (`charA`/`charB` prompts, transformer, dimensions, denoise,
`reflect:false` to skip self-reflection):

```js
Workflow({ scriptPath: ".../multi-character-compose.js", args: {
  transformer: "luciddreamer-z", width: 640, height: 960, steps: 9,
  denoise: 0.35, feather: 60, reflect: true, captionStyle: "default",
  charA: { prompt: "<appearance A>", seed: 42 },
  charB: { prompt: "<appearance B>", seed: 777 },
}})
```

**Self-reflection by default:** the workflow's final phase runs
`run.py caption` so it understands and explains its own output. It degrades
gracefully — caption needs LM Studio running locally; if it is down, the step is
skipped rather than failing the run.

## Bonus bug fix: `image i2i` could not load 8-bit transformers

While building the harmonize step, `image i2i` crashed on every current Z-Image
transformer:

```
ValueError: Expected shape (1024, 32) but received shape (1024, 64)
  for parameter t_embedder.linear1.weight
```

Root cause: `image-i2i.py`'s Z-Image loader **hardcoded `nn.quantize(bits=4,
group_size=32)`** and **ignored `--transformer`** (always loading
`cfg.TRANSFORMER_DIR`). The repo's default transformer (`moody-pro-mix`) and
most variants are now `mlx-8bit`, so the hardcoded 4-bit quant crashed on load.
(`image t2i` was unaffected — `ZImagePipeline` already detects bits via
`_detect_transformer_quant` and respects `--transformer`.)

Fixed in this PR (`app/commands/image-i2i.py`):
- `_generate` + the self-test `_generate_t2i` now detect `(bits, group_size)`
  from the model manifest (via `_detect_transformer_quant`) instead of
  hardcoding 4-bit.
- `_generate` now resolves the transformer dir from `--transformer` (mirroring
  `_shared.execute_generation`), so `image i2i --transformer luciddreamer-z`
  works and the harmonize pass can use the same transformer as generation.
- The i2i `run.json` now records the transformer used.

Regression tests: `app/tests/test_transformer_quant_detect.py` (CPU-only) guard
the manifest-driven detection the loader now relies on.

## Limitations & planned follow-up

- **No regional prompting.** The composite approach is seamless but not a true
  single-pass generation — at very high scrutiny the two halves can still differ
  slightly in micro-style, and composing N>2 characters compounds the seam work.
- **Gaze/pose alignment is not guaranteed** per-character (a character may
  generate centered/facing viewer despite the prompt). Mitigated by the
  harmonize prompt ("facing each other") and by best-of-N seed selection.
- **Planned R&D (separate PR): regional / attention-couple for the Z-Image DiT** —
  the long-term goal that supersedes BOTH the composite (`image multicouple`) and
  the single-prompt + VLM approach (`image twosubject`). The hook point is clean:
  `app/transformer.py:152`
  `mx.fast.scaled_dot_product_attention(q, k, v, scale=…, mask=mask)` already
  accepts a `mask` (currently always `None`), the joint attention concatenates
  `[image_tokens, text_tokens]` (`transformer.py:278`) so a 2D region maps
  cleanly to image-token indices, and `vendor_patches.py` already demonstrates
  monkey-patching MLX attention. A regional-attention patch behind a `--regional`
  flag — split the prompt on `BREAK`/`AND`, build an additive attention bias so
  each region's text tokens attend mainly to their spatial region — would give
  true single-pass two-character generation (natural AND distinct, deterministically).
  Full design, knobs (`--bias-strength`/`--t-gate`/`--common-ratio`), and success
  criteria: [`docs/regional-attention-rd.md`](regional-attention-rd.md). The real
  cost is empirical tuning, driven by the `self-improve-image` workflow against the
  `image twosubject` winner as the baseline.

## ComfyUI technique reference

For context, the ComfyUI mechanisms this pipeline replaces/defers:

- **Regional Prompter / Latent Couple / Attention Couple** — split one prompt
  into common + N regional prompts (BREAK/AND separated); each region's tokens
  are spatially constrained at the cross-attention layer. Best single-pass
  style-consistent + appearance-differentiated result. *(= the planned MLX
  regional-attention R&D.)*
- **Regional IP-Adapter** — two reference images → two image-embedding regions,
  for hard identity locking. (No MLX IP-adapter branch today.)
- **Composite + seam inpaint** — exactly what this PR does.
- **Multi-subject prompt alone** — token bleeding; the weak baseline.
