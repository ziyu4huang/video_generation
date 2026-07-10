# ZImage-Turbo vs Flux2 Klein: Reference Conditioning Analysis

Can ZImage-Turbo replicate Flux2 Klein Edit's reference latent conditioning for character profile generation?

**Short answer: No — it's architecturally impossible without retraining.**

---

## How Flux2 Klein Edit Reference Conditioning Works

The mechanism lives in `vendor/mflux/src/mflux/models/flux2/variants/edit/`:

1. **VAE Encode**: Reference image → VAE → latent tensor `(batch, channels, H/16, W/16)`
2. **Patchify + BN Normalize**: Latents are divided into 4×4 patches, batch-normalized, and flattened into a sequence
3. **Position IDs**: A 3D coordinate grid `[t, h, w]` is created with `t_coord=10+10*i` for each reference image — this lets the model distinguish reference tokens from generation tokens
4. **Concatenation** (the critical step in `_predict()`):
   ```python
   hidden_states = mx.concatenate([latents, image_latents], axis=1)  # noise + reference
   img_ids = mx.concatenate([latent_ids, image_latent_ids], axis=1)  # position IDs
   ```
5. **Joint Attention**: The transformer processes the combined sequence — the model attends to both its own denoising trajectory and the reference image simultaneously
6. **Features like `--double-ref`**: Pass same image twice to double the attention signal; `--chain-ref`: use generated front as reference for back/side

This is **not** img2img (noise interpolation). It's true reference conditioning — the model sees the reference image as a separate input throughout the entire denoising process.

---

## How ZImage-Turbo Works

ZImage-Turbo (`app/pipeline.py` + `app/transformer.py` + `vendor/mflux/src/mflux/models/z_image/`):

1. **Architecture**: 30-layer DiT, 3840 hidden dim, 30 attention heads, Qwen3-4B text encoder
2. **Input**: Noise latents `[1, 16, H/8, W/8]` → patchified to tokens
3. **Img2img support**: Via `refine` command — **simple noise interpolation**:
   ```python
   latents = (1 - sigma) * clean + sigma * noise  # just blending
   ```
4. **No dual-stream**: Single latent sequence; text features (`cap_feats`) are injected via cross-attention modulation
5. **Position IDs**: Simple `[h, w, t]` coordinate grid — no mechanism for separating reference vs generation tokens

---

## Why ZImage-Turbo Cannot Do Reference Conditioning

### 1. Model Weights Were Never Trained For It
Flux2 Klein Edit was specifically trained (fine-tuned) to understand concatenated reference latents. The attention layers learned to route information from the reference portion of the sequence into the generation portion. ZImage-Turbo's weights have zero exposure to this pattern — concatenating reference latents would be noise to the model.

### 2. Different Position Encoding Semantics
Flux2 Klein uses `t_coord=10+10*i` to create a clear "reference region" vs "generation region" in the position embedding space. ZImage's position IDs are purely spatial/temporal with no concept of a "reference channel."

### 3. Different Attention Architecture
Flux2 Klein uses **dual-stream modulation** (separate modulation parameters for image vs text streams). ZImage uses **unified attention** with noise refiner + context refiner paths that merge. The architectural inductive biases are fundamentally different.

### 4. Not a Code-Level Fix
You can't just modify the code to concatenate latents — the model would need to be retrained/fine-tuned with reference conditioning data. This is a training-time feature, not an inference-time trick.

---

## Comparison Table

| Feature | Flux2 Klein Edit | ZImage-Turbo |
|---------|-----------------|-------------|
| **Conditioning Method** | Latent concatenation with position IDs | Simple noise interpolation |
| **Reference Handling** | Dual-stream (latents + IDs) | Single-stream blending |
| **Architecture** | Edit-specific with conditioning | Generic img2img |
| **Multi-Reference** | Supported | Not supported |
| **BN Normalization** | Applied to reference latents | Not applied |
| **Position Awareness** | Separate image/latent IDs | No position awareness |
| **Training** | Fine-tuned with reference latents | Never trained with reference inputs |

---

## What ZImage-Turbo *Can* Do (Weaker Alternatives)

| Approach | Mechanism | Quality vs Flux2 Klein |
|----------|-----------|----------------------|
| **Text-only** (`--base-prompt`) | Pure text conditioning with clothing description | Lowest — no visual reference |
| **VLM auto-caption** | Generate clothing description from reference image, use as text prompt | Low-medium — loses visual details |
| **Img2img refine** | VAE encode + noise interpolation | Medium — but changes image rather than generating new view |
| **IP-Adapter** | External reference adapter module | Possible but requires ZImage-specific IP-Adapter training |

---

## Key Files Reference

| File | Role |
|------|------|
| `python/mlx-movie-director/app/commands/profile.py` | Profile command — pipeline selection, view generation loop |
| `python/mlx-movie-director/app/flux2_pipeline.py` | Flux2 Klein Edit wrapper (loads model, calls generate_image with reference) |
| `python/mlx-movie-director/app/pipeline.py` | ZImage pipeline — text-to-image only |
| `python/mlx-movie-director/app/transformer.py` | ZImage DiT transformer — single-stream attention |
| `vendor/mflux/src/mflux/models/flux2/variants/edit/flux2_klein_edit.py` | Flux2 Klein Edit model — `mx.concatenate([latents, image_latents])` |
| `vendor/mflux/src/mflux/models/flux2/variants/edit/flux2_klein_edit_helpers.py` | `prepare_reference_image_conditioning()` — VAE encode + patchify + BN + position IDs |
| `vendor/mflux/src/mflux/models/z_image/` | ZImage model — no reference conditioning support |
