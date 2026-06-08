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

### Best Quality (⭐ Winner — 5/5/5/5)

```bash
--controlnet-strength 0.6 --skip-preprocess --blur-ref 5 \
  --steps 15 --cnet-active-steps 5
```

Raw + blur(5) with dual-sampler (CN active for first 5 of 15 steps) scored
**perfect 5/5 on all criteria**. The CN guides composition early, then the model
refines freely — eliminating artifacts while maintaining strong pose fidelity.

### Fast + Safe

```bash
--controlnet-strength 0.4 --skip-preprocess --steps 9
```

Strength 0.4 with raw input provides 5/5 CN influence and 5/5 pose fidelity
without risking multi-limb artifacts. No blur needed. Good for quick iterations.

### Canny (Stable)

```bash
--controlnet-strength 0.6 --steps 9
```

Canny is stable at moderate strength. Good when you only need pose/composition
guidance without texture/color transfer.

### ⚠️ Avoid

```bash
--skip-preprocess --controlnet-strength 0.6  # WITHOUT --blur-ref → multi-limb
--controlnet-strength 1.0 --controlnet-type canny  # Overcooks → "bad bad"
```

Raw input at strength ≥0.6 **without blur** causes multi-limb artifacts.
Canny at strength 1.0 scored 1/1/1/1 in testing.

### Self-Test Summary (2026-06-08, seed=42)

| Config | CN Influence | Pose Match | Artifacts | Overall |
|--------|:---:|:---:|:---:|:---:|
| baseline (no CN) | 0 | 0 | 0 | 0 |
| str=0.2 raw 9st | 1 | 1 | 3 | 2 |
| str=0.4 raw 9st | 5 | 5 | 4 | 4 |
| str=0.6 raw 9st | 4 | 2 | 1 | 1 |
| str=0.6 canny 9st | 3 | 3 | 1 | 2 |
| str=1.0 canny 9st | 1 | 1 | 1 | 1 |
| str=0.6 raw+blur5 9st | 4 | 4 | 2 | 2 |
| str=0.6 raw+blur10 9st | 4 | 4 | 2 | 2 |
| str=0.6 raw+blur5 15st | 5 | 5 | 2 | 2 |
| **str=0.6 raw+blur5 15st act5** | **5** | **5** | **5** | **5** ✅ |

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

This was the **winning configuration** in self-test (5/5/5/5 all criteria). The
dual-sampler technique is critical at 15 steps with raw input: without it, the
extra steps amplify artifacts (score drops to 2/2). With `act=5`, the model gets
5 steps of strong CN guidance for composition, then 10 steps of free refinement
for clean detail.

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
