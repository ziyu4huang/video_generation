# Microsoft Lens MLX Pipeline — Progress Report

_Updated: 2026-06-14 — **T2I WORKING** ✅_

---

## Status: Lens T2I is working

End-to-end text-to-image generation produces coherent, prompt-accurate images:

- **Prompt:** "a cute corgi puppy sitting in a sunny garden, highly detailed, photorealistic"
  → VLM: "a charming, detailed photograph of a young Corgi puppy sitting outdoors …
  tan and white coat … lush green foliage, golden light" (full identity match).
- **Prompt:** "a majestic mountain lake at sunrise, snow-capped peaks reflected in
  calm water" → VLM: "mountain range at twilight or dawn, with a perfectly still
  [lake reflecting]".

`corr(predicted_velocity, noise) = 0.96` at sigma=1.0 (a working flow-matching
model predicts v ≈ noise − x0, so this should be ≫ 0.5). Latent std decreases
monotonically over Euler steps (1.0 → 0.64), confirming proper denoising.

**Generation cost:** ~7.4s for 20 steps at 512×512 (INT4 UNet 2.6GB + INT4 TE 13GB
+ BF16 Flux2 VAE), total incl. load ~12s.

---

## Completed Components

| Component | File | Status |
|-----------|------|--------|
| NVFP4 → MLX TE conversion | `scripts/convert_lens_te_mlx.py` | ✅ |
| MLX Text Encoder | `app/lens_text_encoder.py` | ✅ |
| MLX UNet | `app/lens_model.py` | ✅ (fixed) |
| MLX Pipeline | `app/lens_pipeline.py` | ✅ (fixed) |
| Tokenizer | `models/text_encoder/gpt-oss-20b/tokenizer.json` | ✅ |
| run.py CLI command | `app/commands/lens.py` | ✅ |

---

## Root Causes of "denoising not converging" — RESOLVED

The model loaded cleanly (no shape/key mismatch, BF16 ≡ INT4 numerically) but the
forward pass produced output uncorrelated with the input (`corr ≈ 0`, latent std
growing instead of shrinking). Two forward-pass bugs, both found by diffing
against the ComfyUI reference (`comfy/ldm/lens/model.py` + `comfy/ldm/flux/math.py`):

### Bug 1 — RoPE convention was wrong (half-split vs complex-multiplication)

`app/lens_model.py` reimplemented RoPE with a **half-split** rotation
(`q[:D/2]` paired with `q[D/2:]`) applied to the whole 64-dim head at once.
The reference (`comfy.ldm.flux.math.rope` / `_apply_rope1`, identical to the
working mflux `EmbedND`) uses **interleaved complex multiplication**: consecutive
pairs `(x[2i], x[2i+1])` rotated by a 2×2 matrix `[[cos,−sin],[sin,cos]]`, with
per-axis frequency blocks concatenated along the freq axis.

**Fix:** rewrote `EmbedND` to emit per-frequency `[B,1,S,D/2,2,2]` rotation
matrices and `_apply_rope` to do the complex-form rotation — verbatim match to
the reference (and mflux).

### Bug 2 — model unpatchified its output internally with a scrambled channel order

The UNet is **linear on the flat 128-vector** (`img_in`/`proj_out` are plain
Linears), so it operates entirely in PATCHIFIED `[B,128,h,w]` space. The reference
`_forward` (line 499) returns the patchified output and lets the caller
patchify/depatchify. Our model internally "unpatchified" to `[B,32,H,W]` using a
`(ph,pw,ch)` channel reshape that did **not** match the pipeline's
`(ch,ph,pw)` `_patchify` order — scrambling the output channels. The pipeline
then also depatchified, double-mishandling the space.

**Fix:** model now returns patchified `[B,128,h,w]`
(`out.reshape(B,H,W,patch²·out_ch).transpose(0,3,1,2)`, matching reference line
499). The pipeline does the Euler step in patchified space
(`latents = latents + v·dt`) and depatchifies **once**, only for the final VAE
decode. This is self-consistent regardless of the specific patchify channel
convention (the model is a linear map on the flat vector).

### Not bugs (confirmed correct, despite earlier suspicion)

- **INT4 quantization** — BF16 and INT4 produce identical forward output; not the
  culprit. The hypothesis "test BF16 directly" (old Step 1) was the right
  diagnostic and ruled quantization out.
- **Timestep scale** — `ModelSamplingFlux.timestep(sigma) = sigma` (no scale);
  the ×1000 happens inside `timestep_embedding`'s `time_factor=1000`. Pipeline
  feeds `sigma*1000` → sinusoidal receives `1000·sigma`, matching the reference
  exactly. (The old report's note "timestep = sigma*1000" described the effect,
  not `model_sampling.timestep`.)
- **Sinusoidal embedding** — convention `[cos, sin]` with
  `freqs = exp(−log(10000)·arange(half)/half)` already matched the reference.

### Diagnostic red-herring

The UNet's internal `final_hidden` std reaches millions/billions when fed
**random** (out-of-distribution) context features — a self-reinforcing feedback
through the large modulation gates. With **real** TE features this does not
occur; latent std decreases cleanly. Real features must be used for any
behavioral diagnostic.

---

## Step 4 — run.py CLI integration (DONE)

Lens is a `--pipeline lens` option of `image t2i` (alongside `zimage` and
`flux2-klein`). Implemented 2026-06-14, consolidated 2026-06-14:

- `app/commands/image-t2i.py` — `--pipeline` gained a `lens` choice (4th, after
  `zimage`/`flux2-klein`/`auto`); `_PIPELINE_DEFAULT_STEPS["lens"]=20`; the
  `run_t2i()` lens branch sets Lens defaults (512², not 640×960), validates ÷16,
  and dispatches to `run_lens`. Added `--cfg-scale` (Lens-only, default None → 4.0).
- `app/commands/lens.py` — reusable `run_lens(args, json_summary)` module (no
  longer a standalone command). Wraps the generation in `run_session` so output
  gets run.json + manifest.json + `output_files` (gallery-consistent, like
  zimage/flux2-klein). Lazy-imports `LensPipeline` so `--help`/schema stay fast.
- `app/cli.py` — `lens` removed from `COMMAND_NAMES`; the bare `t2i` alias
  removed (it duplicated `image`). `run.py`'s `_inject_default_subcommand`
  rewrites both removed commands to their canonical `image t2i` form with a
  deprecation nudge (avoids silently running the wrong model).
- `app/gpu_monitor.py` — lens is GPU-heavy via `command=="image"`,
  `action=="t2i"` (already in `_GPU_HEAVY_IMAGE_ACTIONS`); the standalone
  `command=="lens"` branch was removed.

Verified end-to-end: `run.py image t2i --pipeline lens --self-test` generates a
coherent corgi (VLM-confirmed 9/9/9) in 7.8s with a complete manifest; full
pytest suite green; `run.py schema` lists `lens` under `image t2i --pipeline`.
The GUI does not yet have a Lens view — the CLI/schema surface is complete, so a
GUI view is a pure frontend addition when wanted.

The TE outputs large-magnitude features (`std ≈ 234`, `absmax ≈ 10k` for the
selected intermediate layers 5/11/17/23). This is **expected** — the UNet's
`txt_norm` (RMSNorm) normalizes them — but worth noting if the TE is reused
elsewhere without an RMSNorm.

---

## Quality round 2 — soft/AI-rendered output → VLM 9/9/9 (DONE)

After the forward bugs (Bug 1–2) made denoising converge, output was still soft
and color-graded (VLM detail 6 / sharpness 7, "AI rendering feel"). Diffing
against the official `microsoft/Lens` `lens/pipeline.py` (diffusers pipeline)
found **six** sampling/decode bugs, all fixed 2026-06-14:

| # | Bug | Fix |
|---|-----|-----|
| 3 | time-shift treated `shift` as `exp(mu)` not `mu` | use `flux_time_shift(mu,1,t)` form |
| 4 | Flux2 VAE BN de-normalization skipped | `packed×std+mean` in 128ch space before unpatchify |
| 5 | `shift` fixed at 1.829 (only 1440²) | `compute_empirical_mu(seq_len, steps)` dynamic |
| 6 | CFG didn't norm-rescale velocity | `pred = comb × cond_norm/comb_norm` |
| 7 | empty negative encoded (not zeroed) | zeros + all-False mask |
| 8 | cfg default 3.5 | 4.0 (official) |

Result: same 512²/20-step corgi → VLM detail 9 / sharpness 9 / prompt 9, no
issues. Laplacian sharpness 128 → 160; pixel contrast 28 → 52. Lens is a
high-res model (gallery all ≥1440²); 512² is OOD, quality rises further at
1024² (high-freq +43%) and 50 steps (official default).

## Key Architecture Facts (verified against reference)

- **Latent format:** Flux2 VAE → 32-ch `[B,32,H/8,W/8]`. Patchify 2×2 spatial →
  128-ch `[B,128,H/16,W/16]`. Model input **and** output are patchified.
- **Sampling:** `ModelSamplingFlux`, shift = 1.829, Euler in velocity/flow space,
  `timestep embedding input = sigma·1000`.
- **RoPE:** 3 axes (frame=8, h=28, w=28) = 64 = head_dim, complex-multiplication
  form (interleaved pairs). Text positions replicate across all 3 axes starting
  at `max(h//2, w//2)`; image positions are centered around 0.
- **Text encoder:** GPT-OSS-20B MoE, 4 selected layers (5,11,17,23) stacked →
  context dim 4·2880 = 11520; 97 prefix tokens trimmed.
- **Modulation:** Flux-style adaLN-zero per block (`img_mod`/`txt_mod` produce
  `[shift,scale,gate]`×2 via `Sequential(SiLU, Linear)`), applied identically to
  the reference.
