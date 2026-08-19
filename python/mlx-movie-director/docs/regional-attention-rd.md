# Regional / Attention-Couple for the Z-Image DiT — R&D Spec (long-term goal)

> **Status: PLANNED, not started.** This is the durable record of the long-term
> goal so the design detail survives between sessions. The composite
> (`image multicouple`) and single-prompt + VLM (`image twosubject`) approaches
> are shipped; this is the third, "correct" approach that makes both unnecessary.

## Why this is the goal

Two earlier approaches were tried and both hit a wall:

1. **Latent-Couple composite (`image multicouple`)** — generate each character
   separately, composite the two **latents** side-by-side, resume-denoise one
   background. *Result:* background **color** unifies (color-match + lock-chars
   drives the cool/warm split +22→+8 edge / +41→0 corner), but the image still
   reads as "two photos pasted together." Root cause: each character is baked
   with its **own lighting direction, scale, and pose**; the resume pass only
   repaints the **background** and cannot touch the characters. That is a
   **structural ceiling** of compositing — not a knob.

2. **Single-prompt + VLM (`image twosubject`)** — the local VLM composes one
   anti-bleeding two-subject prompt, generates best-of-N, and the VLM judges each
   seed (both present? distinct? natural?) to pick the best. *Result:* a single
   pass is the most **natural** (one shared light/scale/scene), but it fights
   **token bleeding** statistically — the VLM + best-of-N beats it most of the
   time, not always, and never with a hard guarantee.

**Regional / attention-couple is the approach that gives both at once:** a single
coherent pass (natural, shared lighting/scale) **with** per-region prompts
(distinct subjects, no bleeding, guaranteed). It is how ComfyUI's Regional
Prompter / Attention Couple / Latent Couple nodes do it, and the hook point in
this MLX Z-Image port turns out to be unusually clean.

## The hook point (verified against `app/transformer.py`)

The Z-Image DiT already has everything needed:

- **`app/transformer.py:152`** — `Attention.__call__` runs
  `mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)`.
  The `mask` argument is **already plumbed** (signature at `:130`, threaded
  through `ZImageTransformerBlock.__call__` `:170`). Today it is always `None`.
  An MLX SDPA `mask` is an **additive bias** (added to `q@k^T * scale` before
  softmax), so a regional bias is just a negative offset on disallowed
  (query-image-token, key-text-token) pairs.
- **`app/transformer.py:278`** — joint self-attention concatenates image tokens
  and text tokens: `unified = mx.concatenate([x, cap_feats], axis=1)`. So the
  token layout in every attention layer is deterministic:
  `[image_tokens (N_img), text/caption_tokens (N_txt)]`. Image tokens map 1:1 to
  spatial latent patches → a 2D region (left half / right half) is a contiguous
  range of image-token indices. Text tokens are produced by the text encoder in
  prompt order → a prompt split on a delimiter (`BREAK` / `AND`) maps to
  contiguous text-token ranges.
- **`app/vendor_patches.py`** already demonstrates import-time monkey-patching of
  MLX attention internals — the same mechanism can inject a regional-bias `mask`
  behind a `--regional` flag without editing the vendor submodule.

So a regional mask is: build an additive bias `B` of shape
`(N_img+N_txt, N_img+N_txt)` (or just the cross part `(N_img, N_txt)`, since the
bias only needs to steer *which text tokens each image region attends to*), where
`B[image_token_i, text_token_j]` is `0` if token `j` is allowed to influence
region(i), and a large negative value (e.g. `-1e4` or a tunable `-strength`) if
not. Pass `B` as `mask` to SDPA at `:152`.

## Design

### 1. Prompt split

Extend the prompt grammar with region delimiters (ComfyUI-compatible):

```
<common prompt>, BREAK <region-A prompt> AND <region-B prompt>
```

- The **common** segment attends to **all** image tokens (global style/scene).
- **region-A** attends (mainly) to the **left** image region.
- **region-B** attends (mainly) to the **right** image region.

At tokenization, record the index ranges `[a0, a1)`, `[b0, b1)` for the regional
segments (the common segment is the complement).

### 2. Region map

A region is a 2D mask over the latent spatial grid (H_lat × W_lat), flattened to
the image-token index order. For two characters side-by-side this is a left/right
split (optionally from a SAM3 segmentation for non-rectangular regions, reusing
`image-multicouple.segment_char_pixel_masks`). Flatten to a per-image-token region
label ∈ {common, A, B}.

### 3. Additive bias

For each attention layer, build `B` once per forward (cache by token layout):

```
B[i, j] = 0                                   if text-token j is "common"
B[i, j] = 0                                   if region(i) == region(text-token j)
B[i, j] = -strength                           otherwise  (cross-region attenuation)
```

`strength` is the main tunable (start ~`-5` to `-1e4`; ComfyUI Attention Couple
uses a hard `-inf`-ish mask, but a soft `-strength` degrades more gracefully).
Image↔image and text↔text blocks of `B` stay `0` (only the image-query ×
text-key cross block carries the regional bias).

### 4. Timestep gating (empirical)

CFG aside, regional bias likely helps most at **mid timesteps** (when content is
being committed) and can be relaxed at the very start (layout) and end (detail).
A switchover `t` (cf. `--seed-variance-switchover` in t2i) gates the bias:
`strength(t) = strength if t < t_gate else 0`. Start with the bias on for all
steps; only gate if empirically needed.

### 5. Common-prompt ratio

How much of the prompt is common (global) vs regional controls style consistency
vs differentiation. ComfyUI default ~30 % common / 70 % regional. Expose as
`--common-ratio` or just let the prompt author control it via where they put
`BREAK`.

## Knobs (CLI)

A new `image twosubject --regional` mode (or a sibling `image regionalcouple`),
reusing the `image twosubject` VLM prompt-master to author the `BREAK/AND` prompt
from two descriptions:

- `--regional` — enable the attention-bias patch.
- `--bias-strength` — the attenuation (default ~`1e4`, i.e. near-hard mask).
- `--t-gate` — timestep below which the bias is active (default: all steps).
- `--region {half|sam3}` — left/right split (default) vs SAM3-segmented regions.
- `--break-token {BREAK|AND}` — the delimiter(s) in the prompt.

## Success criteria

Measured against the same two-girl case (raven/19 + auburn/26, `luciddreamer-z`)
that baselined the composite and single-prompt approaches:

- **Distinctness:** the two subjects keep their own hair/eyes/outfit with
  **zero** token bleeding, deterministically (not best-of-N luck). VLM judge
  `distinct == true` on every seed.
- **Naturalness:** reads as ONE photo (shared lighting/scale) — VLM judge
  `natural ≥ 8`, matching or beating the best `image twosubject` winner.
- **Background unity:** objective edge/corner split ≈ the composite's
  color-matched value (~+8 edge / 0 corner), but achieved in a single pass.
- No regressions on single-subject t2i when `--regional` is off (the patch is a
  no-op: `mask=None` path unchanged).

## How to drive it

The `self-improve-image` workflow (image-QA, not coupled to the code-health
self-improve) tunes the empirical knobs (`bias-strength`, `t-gate`,
`common-ratio`) against the two-girl case, using the VLM judge's
`distinct`/`natural`/`overall` as the reward — the same judge `image twosubject`
already uses. Baseline = `image twosubject`'s best winner; the regional mode must
beat it on distinctness deterministically before it ships as default.

## Why this supersedes the other two

| Approach | Natural (1 light/scale) | Distinct (no bleeding) | Guarantee |
|---|---|---|---|
| Composite (`multicouple`) | ❌ two baked worlds | ✅ independent gens | deterministic but unnatural |
| Single-prompt + VLM (`twosubject`) | ✅ one pass | ⚠️ statistical (best-of-N) | most of the time |
| **Regional attention (this)** | ✅ one pass | ✅ per-region prompts | **deterministic** |

## References

- ComfyUI: Regional Prompter / Latent Couple / Attention Couple nodes (the
  mechanism this ports).
- MLX hook: `app/transformer.py:152` (SDPA `mask=`), `:278` (joint-attn concat),
  `app/vendor_patches.py` (monkey-patch pattern).
- Baselines: `docs/multi-character-compose.md` (composite + single-prompt),
  `image multicouple` / `image twosubject` commands, project memories
  `multi-character-latent-couple` / `multi-character-regional-attention-rd`.
