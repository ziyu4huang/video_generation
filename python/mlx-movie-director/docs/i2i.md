# Z-Image Turbo Image-to-Image (I2I) — Native MLX

Native MLX implementation of Image-to-Image generation with Z-Image Turbo on Apple Silicon.
Optionally combines with ControlNet for pose/environment guidance from a separate reference.

## Quick Start

```bash
# Simple I2I: transform a photo into oil painting style
python/venv/bin/python run.py image i2i \
  --input-image photo.jpg \
  --denoise-strength 0.4 \
  --prompt "oil painting style portrait, rich brushstrokes, museum quality"

# I2I + ControlNet: keep person's identity, adopt reference pose
python/venv/bin/python run.py image i2i \
  --input-image person_a.jpg \
  --reference-image pose_reference.jpg \
  --denoise-strength 0.6 \
  --controlnet-strength 0.6 --skip-preprocess --blur-ref 5 \
  --prompt "person in studio lighting"

# Self-test: auto-generate source + reference, run variations
python/venv/bin/python run.py image i2i --self-test
```

## ControlNet Compatibility

| Pipeline | ControlNet Support | Notes |
|----------|-------------------|-------|
| Z-Image Turbo | ✅ Full support | Union 2.1 "broken" variant, 3 control layers |
| Flux2 Klein | ❌ Not supported | No ControlNet model; uses Flux2KleinEdit reference instead |
| LTX-2.3 | ❌ Not supported | Video pipeline, no ControlNet implementation |

> ⚠️ I2I + ControlNet uses the Z-Image Turbo pipeline exclusively.
> The `--pipeline` flag does not apply to I2I mode. Flux2 Klein does NOT have
> a ControlNet model and cannot be used with `--reference-image`.

## How It Works

### Noise Mixing

I2I starts by encoding the source image into latent space, then mixing it with
random noise based on `denoise_strength`:

```
clean_latent = VAE_encode(source_image)
noise = random_noise()
t_mix = scheduler.timesteps[start_step]
latents = (1 - t_mix) * clean_latent + t_mix * noise
```

- Low `denoise_strength` → mostly `clean_latent` → output similar to source
- High `denoise_strength` → mostly `noise` → output follows prompt more freely

The denoising loop starts from `start_step` (skipping already-completed early steps),
which is how ComfyUI implements img2img.

### Optional ControlNet

When `--reference-image` is provided, ControlNet conditioning adds pose/environment
guidance from the reference. This uses the same interleaved injection as
[controlnet.md](controlnet.md), with dual-sampler support (`--cnet-active-steps`).

**Important**: The dual-sampler `--cnet-active-steps` is measured relative to the
I2I start point (not absolute step 0). For example, with `denoise-strength 0.6`
and 15 steps, denoising starts at step 6. Setting `--cnet-active-steps 5` means
ControlNet is active for steps 6–10 (first 5 steps of the I2I process).

### Source Anchor Effect

With I2I + ControlNet, the source latent "anchors" the composition. At low
`denoise_strength` (0.3–0.4), the source signal is strong enough that ControlNet
cannot override the pose. For ControlNet to effectively change the pose, use
`denoise_strength ≥ 0.6`.

## Denoise Strength Guide

Based on community testing (WaveSpeed, Moody I2I workflow):

| Range | Use Case | Description |
|-------|----------|-------------|
| 0.15–0.25 | Polishing | Keep pose/layout exactly, change color/texture only |
| 0.30–0.45 | Controlled restyle | Maintain structure, shift vibe/style |
| 0.50–0.65 | Bold reinterpretation | Pose and scene hold loosely |
| 0.70+ | New idea with memory | Source becomes a suggestion |

**Tip**: Start at 0.4 for simple restyle. For I2I + ControlNet, use 0.6+ to allow
ControlNet to override the source pose. If output is too similar to source, increase.
If output loses source identity, decrease.

## CLI Reference

### I2I Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--input-image PATH` | required | Source image to transform (I2I input) |
| `--reference-image PATH` | none | ControlNet reference (pose/environment guide) |
| `--denoise-strength F` | 0.4 | How much to change (0.0 = keep source, 1.0 = full redraw) |
| `--controlnet-strength F` | 0.6 | ControlNet conditioning strength (only with `--reference-image`) |
| `--skip-preprocess` | off | Pass reference image directly to ControlNet (no edge detection) |
| `--blur-ref SIGMA` | off | Gaussian blur on reference (softens outlines) |
| `--cnet-active-steps N` | all steps | Dual-sampler: ControlNet only for first N steps |
| `--scale INT` | auto | Scale longest side to this resolution |

### Shared Arguments (from `_shared.py`)

| Flag | Default | Description |
|------|---------|-------------|
| `--prompt TEXT` | required | Generation prompt (describes target style/content) |
| `--steps INT` | 9 | Denoising steps |
| `--seed INT` | 42 | Random seed |
| `--self-test` | off | Run automated test suite |

## Recommended Settings

### Best Quality (I2I + ControlNet)

```bash
--denoise-strength 0.6 \
--reference-image pose.jpg \
--controlnet-strength 0.6 --skip-preprocess --blur-ref 5 \
--steps 15 --cnet-active-steps 5
```

Uses ControlNet winner settings from A/B testing (blur5 + dual-sampler) with
`denoise_strength ≥ 0.6` so ControlNet can override the source pose. At lower
denoise (0.3–0.4), the source latent anchors the composition too strongly.

### Fast I2I (no ControlNet)

```bash
--denoise-strength 0.4 --steps 9
```

Simple style transfer without ControlNet. 9 steps, ~25 seconds.

### Polishing

```bash
--denoise-strength 0.2 --steps 9
```

Minimal change — color grading, subtle texture, cleaner edges.

## Self-Test Mode

The `--self-test` flag runs a comprehensive automated test:

1. **Generates source image** via T2I — Asian woman standing, arms at sides (cached)
2. **Generates reference image** via T2I — Caucasian woman in V-pose (cached)
   Source and reference differ in BOTH pose and ethnicity for meaningful testing.
3. **Runs variations**:
   - Simple I2I: denoise sweep (0.2, 0.4, 0.6, 0.8)
   - I2I + ControlNet: denoise sweep (0.4, 0.6, 0.8) — shows source anchor effect
   - Full redraw + ControlNet (denoise=1.0) — verifies ControlNet itself works
4. **Opens bilingual review HTML** with scoring guide and pipeline metadata

```bash
python/venv/bin/python run.py image i2i --self-test
```

Takes ~30 minutes (2 T2I + 8 I2I images, ~3 min each including model loading).

## Memory Management

| Component | Size | Loaded |
|-----------|------|--------|
| Text encoder (4-bit) | ~1 GB | First, deleted after embedding |
| Transformer (4-bit) | ~5 GB | During denoising |
| ControlNet (bf16) | ~2 GB | Only with `--reference-image` |
| VAE decoder | ~0.2 GB | Last, for final decode |
| **Peak total** | **~17 GB** | Sequential loading/unloading |

## Files

| File | Purpose |
|------|---------|
| `app/commands/image-i2i.py` | I2I command, generation loop, self-test |
| `app/commands/image.py` | Subcommand registration |
| `app/transformer.py` | Transformer with ControlNet injection |
| `app/controlnet.py` | ControlNet model + weight loading |
| `docs/controlnet.md` | ControlNet documentation |

## Related

- [controlnet.md](controlnet.md) — ControlNet architecture and A/B test results
- [overview.md](overview.md) — All pipelines overview
