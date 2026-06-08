# Z-Image ControlNet (Union 2.1) — Native MLX

Native MLX implementation of the Z-Image Turbo ControlNet for Apple Silicon,
running entirely without ComfyUI. Based on the [ZImageTurbo ControlNet Union 2.1]
model (civitai.com/models/2192289).

## Quick Start

```bash
# Basic: Canny edge detection (default preprocessor)
python/venv/bin/python run.py image controlnet \
  --input-image ref.jpg \
  --prompt "A woman standing in a studio, high quality portrait" \
  --controlnet-strength 0.6

# Best quality: Raw + blur (recommended from A/B testing)
python/venv/bin/python run.py image controlnet \
  --input-image ref.jpg \
  --skip-preprocess --blur-ref 5 \
  --controlnet-strength 0.6 \
  --prompt "A woman standing in a studio, high quality portrait"

# Self-test: auto-generate test images + bilingual review HTML
python/venv/bin/python run.py image controlnet --self-test
```

## Architecture

### Overview

The ControlNet follows the "broken variant" pattern (Union 2.1):
- **2 noise refiners** — process latents alongside the main transformer's noise refiners
- **3 control layers** — inject residuals at stride-N positions in the main transformer layers
- **33-channel input** — control latent (16ch) + mask (1ch) + inpaint latent (16ch)

The "broken" variant means noise refiner `after_proj` weights are all zeros. The model
redirects: noise refiner execution → control layers instead (matching ComfyUI behavior).

### Injection Flow

```
Main Transformer              ControlNet
──────────────                ──────────
x_embedder(x) ──────────────► control_all_x_embedder(33ch) → control_context

noise_refiner[0]             forward_noise_refiner(0)
  → residual * strength ────►  control_layers[0]
  x += residual

noise_refiner[1]             forward_noise_refiner(1)
  → residual * strength ────►  control_layers[1..2]
  x += residual

layers[0]                    control_layers[0] (re-run via noise refiner)
layers[1]                    control_layers[1]
  → residual * strength
  unified_img += residual
layers[2]                    control_layers[2]
  → residual * strength
  unified_img += residual
...
```

The stride between main layers and control layers is computed dynamically:
`div = round(n_main_layers / n_control_layers)`. Residuals are injected at every
`div`-th main layer.

### 33-Channel Control Input

The control image is VAE-encoded and concatenated with mask + inpaint latents:

| Channels | Content |
|----------|---------|
| 0–15 | Control latent (VAE-encoded reference image) |
| 16 | Mask (zeros for non-inpaint) |
| 17–32 | Inpaint latent (VAE-encoded gray fill) |

The 33-channel tensor is patchified (2×2 patches → 132 dims) and linearly
projected to 3840 dims (the transformer hidden size).

### Flux Latent Format

Z-Image inherits the Lumina2 → Flux latent format. Control latents are
normalized before VAE encoding:

```python
shift, scale = 0.1159, 0.3611
latent = (latent - shift) * scale
```

## CLI Reference

### ControlNet Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--input-image PATH` | built-in ref | Reference image for ControlNet conditioning |
| `--controlnet-strength F` | 1.0 | Conditioning strength (0.0–1.0) |
| `--controlnet-type TYPE` | canny | Preprocessor type (currently: canny only) |
| `--skip-preprocess` | off | Pass raw image as control signal (no edge detection) |
| `--blur-ref SIGMA` | off | Gaussian blur sigma for reference image (softens outlines) |
| `--remove-outlines` | off | Remove thick dark outlines via cv2.inpaint |
| `--cnet-active-steps N` | all steps | Dual-sampler: only apply ControlNet for first N steps |
| `--scale INT` | auto | Scale longest side to this resolution |

### Shared Arguments (from `_shared.py`)

| Flag | Default | Description |
|------|---------|-------------|
| `--prompt TEXT` | required | Generation prompt |
| `--steps INT` | 9 | Denoising steps |
| `--seed INT` | 42 | Random seed |
| `--width/--height` | auto | Output dimensions (default: match reference) |

## Preprocessing

### Canny Edge Detection (default)

Uses `cv2.Canny` with automatic thresholding. Produces clean edge maps that
guide composition without introducing artifacts.

- **Pros**: Stable at any strength, no extra models needed
- **Cons**: Loses color/texture information, only preserves edges

### Raw Input (`--skip-preprocess`)

Passes the reference image directly to VAE encoding without edge detection.
Preserves color, texture, and pose information.

- **Pros**: Most control fidelity, preserves all visual information
- **Cons**: At strength ≥0.6, can cause **multi-limb artifacts** (extra arms/hands)
- **Fix**: Use with `--blur-ref 5` to soften edges and prevent artifacts

### Outline Removal (`--remove-outlines`)

Uses Otsu thresholding + `cv2.inpaint` (TELEA) to remove thick dark outlines
(苗框線) from anime reference images. Fills outlines with surrounding colors.

### Blur (`--blur-ref SIGMA`)

Applies Gaussian blur to the reference image before VAE encoding. Softens
harsh lines into gradients that still convey pose/composition.

## Recommended Settings (from A/B Testing)

Based on systematic A/B testing (2026-06-08) with the Z-Image Turbo pipeline:

### Best Quality

```bash
--controlnet-strength 0.6 --skip-preprocess --blur-ref 5
```

Raw + blur(5) at strength 0.6 scored **5/5 overall quality**. The blur prevents
the ControlNet from over-interpreting sharp features as separate limbs.

### Fast + Safe

```bash
--controlnet-strength 0.4 --skip-preprocess
```

Strength 0.4 with raw input provides decent ControlNet influence without
risking multi-limb artifacts. No blur needed.

### Canny (Stable)

```bash
--controlnet-strength 0.6  # or 1.0
```

Canny is stable at any strength. Both 0.6 and 1.0 scored 4/4/4/4 across all
criteria. Good when you only need pose/composition guidance.

### ⚠️ Avoid

```bash
--skip-preprocess --controlnet-strength 0.6  # WITHOUT --blur-ref
```

Raw input at strength ≥0.6 **without blur** causes multi-limb artifacts ("太多隻手").
The ControlNet over-injects and the model hallucinates extra limbs.

### A/B Test Summary

| Config | CN Influence | Pose Match | Artifacts | Overall |
|--------|:---:|:---:|:---:|:---:|
| baseline (no CN) | 1 | 1 | 5 | 3 |
| str=0.4 raw | 4 | 4 | 5 | 4 |
| str=0.6 raw | 5 | 4 | 1 | 2 |
| str=0.6 canny | 4 | 3 | 4 | 4 |
| str=1.0 canny | 4 | 3 | 4 | 4 |
| **str=0.6 raw+blur5** | **5** | **4** | **5** | **5** |
| str=0.6 raw+blur10 | 4 | 3 | 4 | 4 |

## Dual-Sampler Technique

The `--cnet-active-steps N` flag implements the dual-sampler technique:
ControlNet runs for the first N steps only, then the model continues denoising
freely. This can improve quality by letting the model refine on its own after
the initial composition is established.

```bash
# ControlNet for first 5 steps, then pure model for remaining 10
python/venv/bin/python run.py image controlnet \
  --input-image ref.jpg \
  --controlnet-strength 0.6 --skip-preprocess --blur-ref 5 \
  --steps 15 --cnet-active-steps 5
```

Note: In A/B testing, dual-sampler did not improve results when base strength
was already in the artifact-prone range. Use with the recommended settings above.

## Self-Test Mode

The `--self-test` flag runs a comprehensive automated test:

1. Downloads a standard reference image (Unsplash portrait, cached locally)
2. Generates 10 variations covering all parameter combinations
3. Opens a bilingual (EN/中文) review HTML with:
   - Star ratings for each image (4 criteria)
   - Scoring guide explaining what to look for
   - Winner selection and comment fields
   - JSON export for analysis

```bash
python/venv/bin/python run.py image controlnet --self-test
```

Takes ~30 minutes to complete (10 images × ~3 min each including model loading).

## Memory Management

Running on Apple Silicon requires careful memory management:

| Component | Size | Notes |
|-----------|------|-------|
| Text encoder (4-bit) | ~1 GB | Loaded first, deleted after embedding |
| Transformer (4-bit) | ~5 GB | Main denoising model |
| VAE decoder | ~0.2 GB | Loaded for encoding control + final decode |
| ControlNet (bf16) | ~2 GB | Loaded after transformer, interleaved execution |
| **Peak total** | **~17 GB** | Sequential loading/unloading required |

The pipeline loads components sequentially: text encoder → (delete) → transformer +
controlnet → (delete both) → VAE decoder. This keeps peak memory within Apple
Silicon unified memory limits.

## Files

| File | Purpose |
|------|---------|
| `app/controlnet.py` | Model architecture + weight loading |
| `app/commands/image-controlnet.py` | CLI command, generation loop, self-test |
| `app/transformer.py` | Interleaved injection in transformer forward pass |
| `models/controlnet/zimage-turbo-fun-union-2.1/` | Model weights (safetensors) |

## Related

- [overview.md](overview.md) — All pipelines overview
- [models.md](models.md) — Model file locations and formats
