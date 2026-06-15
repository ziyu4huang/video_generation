# Microsoft Lens MLX T2I — Porting the Forward Pass

How the Microsoft Lens 3.8B dual-stream MMDiT was ported to pure MLX for
text-to-image on Apple Silicon, including the two forward-pass bugs that broke
denoising and how each was found by diffing against the ComfyUI reference.

---

## Problem Statement

The port loaded cleanly — no shape/key mismatches, INT4 and BF16 weights produced
identical output — but the model did not denoise. At `sigma=1.0` (full noise),
`corr(predicted_velocity, noise) ≈ 0`, and the latent std grew (1.0 → 1.18)
instead of shrinking over Euler steps. Generated images were noise/artifacts.

---

## Diagnosis path

1. **Quantization ruled out** — ran the same forward with the BF16 source
   (`comfyui_data/models/diffusion_models/lens_bf16.safetensors`) and the INT4
   port. Identical output → the bug is in the forward computation, not the
   weights or quantization.
2. **Timestep ruled out** — swept `t ∈ [0, 1000]`; `corr ≈ 0` for all values.
   Confirmed `ModelSamplingFlux.timestep(sigma) = sigma` and the ×1000 lives
   inside `timestep_embedding`'s `time_factor`, so feeding `sigma·1000` matches
   the reference exactly.
3. **Diffed the forward against the reference** (`comfy/ldm/lens/model.py` +
   `comfy/ldm/flux/math.py`) → two structural bugs (below).

### Diagnostic gotchas that wasted time

- **Random context features cause a fake explosion.** Feeding random
  `[B,S,4·2880]` features (OOD) makes the UNet's internal hidden std blow up to
  millions through the large modulation gates. With **real** TE features this
  does not happen. Any behavioral test must use real TE features.
- **Double-depatchify.** A diagnostic that replicated the model forward (which
  unpatchified) and then applied `_depatchify` again reported `corr ≈ 0` — a
  script bug, not a model bug. Measure correlation in the model's native
  patchified space.

---

## Bug 1 — RoPE convention (half-split vs complex multiplication)

`app/lens_model.py` reimplemented RoPE with a **half-split** rotation: it paired
`q[:D/2]` with `q[D/2:]` and applied it to the whole 64-dim head at once.

The reference (`comfy/ldm/flux/math.py`) — identical to the working mflux
`EmbedND` — uses **interleaved complex multiplication**:

```python
# reference: comfy.ldm.flux.math.rope
def rope(pos, dim, theta):
    half = dim // 2
    scale = torch.linspace(0, (dim - 2) / dim, steps=dim // 2)  # = arange(0,dim,2)/dim
    omega = 1.0 / (theta ** scale)
    out = pos[..., None] * omega
    out = torch.stack([cos(out), -sin(out), sin(out), cos(out)], dim=-1)
    out = rearrange(out, "b n d (i j) -> b n d i j", i=2, j=2)  # per-freq 2×2 matrix
    return out

# reference: comfy.ldm.flux.math._apply_rope1  (interleaved pairs)
x_ = x.reshape(*x.shape[:-1], -1, 1, 2)            # (x[2i], x[2i+1]) as complex
x_out = freqs_cis[..., 0] * x_[..., 0] + freqs_cis[..., 1] * x_[..., 1]
```

Consecutive pairs `(x[2i], x[2i+1])` are treated as a complex number and rotated
by `[[cos, −sin], [sin, cos]]`. The three axes (frame=8, h=28, w=28) are
concatenated along the frequency axis → `freqs_cis` is `[B, 1, S, 32, 2, 2]`.

**Fix:** rewrote `EmbedND` and `_apply_rope` to match verbatim (see
`app/lens_model.py`). This is the same convention mflux uses for Flux, so any
Flux-family MMDiT port to MLX should reuse it.

---

## Bug 2 — internal output unpatchify scrambled channels

The Lens UNet is **linear on the flat 128-vector** (`img_in` and `proj_out` are
plain Linears with no spatial structure), so it operates entirely in PATCHIFIED
`[B, 128, h, w]` space. The reference `_forward` returns the patchified output
and lets the caller patchify/depatchify:

```python
# reference: comfy/ldm/lens/model.py, line 499
return out.reshape(B, h, w, C).permute(0, 3, 1, 2)   # [B, 128, h, w]
```

Our port internally "unpatchified" to `[B, 32, H, W]` with a `(ph, pw, ch)`
reshape that did **not** match the pipeline's `(ch, ph, pw)` `_patchify` order,
scrambling the output channels. The pipeline then also depatchified, double
mishandling the space.

**Fix:** the model returns patchified `[B, 128, h, w]`
(`out.reshape(B,H,W,patch²·out_ch).transpose(0,3,1,2)`). The pipeline runs the
Euler step in patchified space (`latents = latents + v·(σ_next − σ)`) and
depatchifies **once**, only for the final VAE decode. Because the model is a
linear map on the flat vector, this is self-consistent regardless of the specific
patchify channel convention.

---

## Result

`corr(predicted_velocity, noise) = 0.96` at `sigma=1.0`; latent std decreases
monotonically over Euler steps. End-to-end generation:

| Prompt | VLM reading |
|--------|-------------|
| "a cute corgi puppy sitting in a sunny garden, photorealistic" | "a charming, detailed photograph of a young Corgi puppy … tan and white coat … lush green foliage, golden light" |
| "a majestic mountain lake at sunrise, snow-capped peaks reflected in calm water" | "mountain range at twilight or dawn, with a perfectly still [lake reflecting]" |

Cost: ~7.4s for 20 steps at 512×512 (INT4 UNet 2.6 GB + INT4 TE 13 GB + BF16
Flux2 VAE); ~12s total including model load.

---

## Quality bugs — soft / color-graded output (VLM 7/6/7 → 9/9/9)

After Bugs 1–2, denoising converged (corr 0.96) and images were prompt-accurate,
but the output read as soft and "AI-rendered" (VLM: detail 6, sharpness 7,
"Slight softness in fur texture", "Subtle color grading"). Diffing against the
**official** [`microsoft/Lens` `lens/pipeline.py`](https://github.com/microsoft/Lens/blob/master/lens/pipeline.py)
(the diffusers pipeline) found six sampling/decode bugs. After fixing all six,
the same 512²/20-step corgi scores detail 9 / sharpness 9 with no issues.

**Bug 3 — time-shift treated `shift` as `exp(mu)`, not `mu`.**
`flux_time_shift(mu,1,t) = exp(mu)/(exp(mu)+(1/t-1))`; the model's
`sampling_settings["shift"] = 1.829` IS `mu`. The port used
`shift*t/(1+(shift-1)*t)`, which treats 1.829 as `exp(mu)` (mu≈0.60) and
over-compresses the low-noise tail (lowest sigma 0.088 vs the correct 0.247).

**Bug 4 — Flux2 VAE BatchNorm de-normalization was skipped.** Flux2's VAE has a
`bn` layer (128-ch) whose running_mean/var normalize the diffusion latents
during training. The model predicts BN-normalized packed latents, so decode must
de-normalize (`packed × running_std + running_mean`) in 128-ch packed space
BEFORE unpatchify. The port depatchified+decoded directly → OOD latents → soft,
color-graded. **Flux2-specific** (Flux1's VAE has no BN).

**Bug 5 — `shift` was fixed at 1.829 (only correct at 1440²).**
`compute_empirical_mu(seq_len, num_steps)` calibrates mu from BOTH resolution
and step count: 512²/20st → 1.916, 1024²/20st → 2.198, 1440²/50st → 1.828. Now
computed dynamically.

**Bug 6 — CFG did not norm-rescale the velocity.** Official Lens rescales the
CFG-combined velocity to the cond velocity's per-token L2 norm
(`noise_pred = comb × cond_norm/comb_norm`); without it, CFG inflates the
velocity magnitude → over-exposure / over-contrast.

**Bug 7 — empty negative was encoded, not zeroed.** Empty negatives use zero
features + all-False mask (drops the negative tokens from attention entirely),
NOT an encoded empty chat string.

**Bug 8 — cfg default + sentinel.** The shared `--cfg-scale` arg defaults to
`None` (unused by zimage/flux2); the Lens path resolves `None → 5.0`, matching
the official `microsoft/Lens inference.py` argparse default of **5.0** (its
docstring example shows `--cfg 4.0`). Resolved via `getattr(args, "cfg_scale",
None)` + `if cfg_scale is None` — **never** compare against a concrete default
(see the `argparse-sentinel-for-user-override` lesson; cfg_scale was previously
bitten by magic-number comparison).

The Lens gallery is all 1440² / 1248×1664 / 1664×1248 — it is a high-resolution
model, so 512² is out-of-distribution; quality scales further with resolution
(high-freq detail +43% at 1024²) and steps (official default 50).

## Performance bug — naive attention (Bug 9, perf not correctness)

A 1168×1760/50-step run took **814s** and scaled ~4.5x slower than 832×1248 for
only ~2x the tokens — slightly super-quadratic, the signature of an S² memory
bottleneck. Root cause: `app/lens_model.py` implemented the joint attention with
a **manual einsum + fp32 softmax** that materialized the full `[B,H,S,S]` score
matrix (≈6 GB at S=8030) instead of MLX's fused kernel — despite the code comment
literally reading `# SDPA`.

**Fix:** swapped to `mx.fast.scaled_dot_product_attention(q, k, v, scale, mask)`
(cast the additive mask to `q.dtype` — SDPA requires the mask to promote to the
output dtype). Verified numerically equivalent to the manual form (**corr=1.0**,
with and without mask) and output-preserving (pixel diff vs the pre-fix 1440
output: mean 1.6/255 — imperceptible bf16 fusion-order noise).

**Speedup:** 832×1248 **3.56 → 0.845 s/step (4.2x)**; 1440 base **15.84 → 2.75
s/step (5.8x)** — the 1168×1760/50 run dropped **814s → 140s**. The win grows with
resolution because the eliminated S² materialization cost grows with S. After the
fix, 1440 base (140s) is faster than the pre-fix 832×1248 run (178s), so native-
resolution generation is no longer time-prohibitive. MLX ≥0.21 has the fused SDPA;
the port already required it transitively but never called it here.

## Quality levers ruled out — reasoner & token-cap (Bug 10, investigation)

Two hypothesized prompt-side quality levers were **empirically ruled out** with a
fixed-seed A/B/C test (`scripts/test_lens_reasoner.py`, 832×1248 / 50 steps / cfg
5.0 / seed 42, on the real 521-token portrait prompt):

| condition | text tokens seen | result |
|-----------|------------------|--------|
| (A) baseline, cap 512 | 415 (truncated tail) | reference |
| (B) cap enlarged 512→1024 | 543 (full prompt) | mean Δ 11.6/255 (15% px) vs A |
| (C) gemma-4-26b reasoner rewrite, cap 512 | 311 (condensed) | mean Δ 30/255 (48% px) vs A |

Objective pixel diffs prove the images **do** differ — but a critical VLM read
found the **same rendering defects in all three** (plastic skin, mushed fabric,
blur). So the reasoner changes *what* renders (it rewrites the prompt → a
different image), not the *quality*; cap enlargement barely moves anything. The
defects are rendering-capacity (resolution / 3.8B model size), not prompt-content.
Seed dominates composition/lighting; text conditioning only nudges content.

**Consequences:** do not wire a reasoner into the CLI for quality (it only helps
if the input prompt is vague/short and you want elaboration — a different goal;
`app/lens_reasoner.py` is kept opt-in for that). Do not raise `_MAX_TOKENS` past
512 expecting better images. The actual quality levers are native resolution,
steps 50, cfg 5.0, and **best-of-N seed selection** (official `--n 4`; we have
`--count`) — eyeball-pick the best of N, since per-seed rendering defects can't be
prompt-conditioned away. The reasoner needs `reasoning_effort:"none"` for the
thinking gemma-4-26b, or it spends the whole budget on `<think>` and emits nothing.

## Architecture facts (verified against the reference)

- **Latent format:** Flux2 VAE → 32-ch `[B,32,H/8,W/8]`; patchify 2×2 → 128-ch
  `[B,128,H/16,W/16]`. Model input **and** output are patchified.
- **Sampling:** `ModelSamplingFlux`, shift = 1.829, Euler velocity/flow space,
  timestep-embedding input = `sigma·1000`.
- **RoPE:** 3 axes (frame=8, h=28, w=28) = 64 = head_dim, complex-multiplication
  form. Text positions replicate across all 3 axes from `max(h//2, w//2)`; image
  positions are centered around 0.
- **Text encoder:** GPT-OSS-20B MoE; 4 selected layers (5,11,17,23) stacked →
  context dim 4·2880 = 11520; 97 prefix tokens trimmed.
- **Modulation:** Flux-style adaLN-zero per block — `img_mod`/`txt_mod` are
  `Sequential(SiLU, Linear(dim, 6·dim))`, chunked into `[shift,scale,gate]`×2.
- **TE feature magnitude:** selected-layer hidden states have `std ≈ 234`
  (`absmax ≈ 10k`). This is expected — the UNet's `txt_norm` (RMSNorm)
  normalizes it. Reusing the TE without an RMSNorm would need care.

---

## Running it

Lens is a `--pipeline lens` option of `image t2i` (alongside `zimage` and
`flux2-klein`). From the repo root:

```bash
./python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --prompt 'a cute corgi puppy, photorealistic'
./python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --self-test                       # built-in prompt
./python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --prompt '...' --json-summary     # for automation
```

Options: `--width/--height` (÷16; default 512²), `--steps` (20; official default
50), `--cfg-scale` (4.0, Lens-only), `--seed`, `--count`. The flow-matching shift
(`mu`) is computed dynamically (`compute_empirical_mu`) — no `--shift` flag.
Best quality at ≥1024² (Lens is a high-res model). The bare top-level `run.py lens`
still works (auto-rewritten to `image t2i --pipeline lens` with a deprecation
nudge) for backward compatibility.

For the raw denoising diagnostic (corr(v,noise) + 5-step Euler check):

```bash
cd python/mlx-movie-director
python/venv/bin/python scripts/diag_lens_real.py
```

See `output/lens-progress.md` for the full progress log.
