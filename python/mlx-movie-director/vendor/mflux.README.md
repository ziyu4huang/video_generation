# mflux — vendored submodule

Source: https://github.com/pcuenq/mflux  
Used by: `app/flux2_pipeline.py` (profile), `app/flux2_t2i_pipeline.py` (generate), `app/commands/_shared.py` (A/B test)

---

## mlx-movie-director Integration Notes

This section documents project-specific findings from integrating mflux into the [mlx-movie-director](../../) pipeline on Apple Silicon.

### Weight Conversion Patterns

#### VAE (Z-Image / Flux) — PyTorch → MLX

The mflux `ZImageWeightMapping.get_vae_mapping()` provides all key mappings with correct Conv2d transpose rules. The mapping uses placeholder expansion:

| Placeholder | Encoder range | Decoder range |
|-------------|---------------|---------------|
| `{block}` | 0–3 (down_blocks) | 0–3 (up_blocks) |
| `{res}` | 0–1 (2 resnets per block) | 0–2 (3 resnets per block) |
| `{i}` | 0–1 (mid_block resnets) | 0–1 (mid_block resnets) |

**Conv2d transpose**: PyTorch stores Conv2d weights as `(O, I, kH, kW)`. MLX expects `(O, kH, kW, I)`. The `WeightTransforms.transpose_conv2d_weight` handles this automatically when used via the mapping.

```python
from mflux.models.z_image.weights.z_image_weight_mapping import ZImageWeightMapping
from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE

# Expand placeholder patterns into concrete key mappings
mappings = ZImageWeightMapping.get_vae_mapping()
# Each mapping has: to_pattern, from_pattern (list), transform (optional callable)
```

Result: 244/244 weights mapped, 0 missing keys. A/B PSNR: 50.57 dB vs PyTorch/diffusers decode.

#### VAE (SeedVR2) — Conv3d Transpose

SeedVR2 VAE uses `CausalConv3d` throughout (encoder, decoder, all resnets). PyTorch stores Conv3d as `(O, I, kT, kH, kW)`, MLX expects `(O, kT, kH, kW, I)` — transpose indices `(0, 2, 3, 4, 1)`.

#### SeedVR2 VAE — Not Worth Quantizing

`nn.quantize(bits=8, group_size=64)` with a predicate that skips Conv3d layers saves negligible disk (478 → 476 MB). Conv3d weights dominate the model and cannot be quantized by standard MLX `nn.quantize()`. Kept at BF16.

### Auto-detect Pattern

The pipeline auto-detects the VAE backend by checking filenames:

```python
def _vae_mlx_available():
    return os.path.exists(os.path.join(cfg.VAE_DIR, "model.safetensors"))
```

- `model.safetensors` → MLX VAE (native `VAE.encode()` / `VAE.decode()`)
- `diffusion_pytorch_model.safetensors` → PyTorch fallback (requires `diffusers`)

### MLX VAE Normalization

`ZImageVAE` applies `scaling_factor` (0.3611) and `shift_factor` (0.1159) internally:

```python
# Encode: latent = (mean - shift_factor) * scaling_factor
# Decode: scaled_latents = (latents / scaling_factor) + shift_factor
```

No external normalization needed — unlike the PyTorch path which required manual scaling.

### Model Inventory (Converted)

| Model | Category | Format | Size | Status |
|-------|----------|--------|------|--------|
| zimage-moody-v126 | transformer | mlx-4bit-gs32 | 3.6 GB | ✅ Pre-quantized |
| klein-9b | transformer | mlx-8bit | 9.6 GB | ✅ Pre-quantized |
| seedvr2-7b | transformer | mlx-4bit-gs32 | 4.8 GB | ✅ Pre-quantized |
| qwen3-4b | text_encoder | mlx-4bit-gs32 | 2.3 GB | ✅ Pre-quantized |
| qwen3-8b | text_encoder | mlx-8bit | 8.0 GB | ✅ Pre-quantized |
| flux-ae | vae | mlx-bf16 | 160 MB | ✅ Converted (was PyTorch) |
| flux2-klein | vae | mlx-8bit | 158 MB | ✅ Pre-quantized |
| seedvr2-vae | vae | mlx-bf16 | 478 MB | — Conv3d-dominated, kept BF16 |
| qwen3 | tokenizer | hf-tokenizer | 15 MB | ✅ No conversion needed |
| qwen3-klein | tokenizer | hf-tokenizer | 11 MB | ✅ No conversion needed |

### Text-to-Image: Flux2 Klein 9B (`run.py generate --pipeline flux2-klein`)

The `Flux2Klein` txt2img variant (`vendor/mflux/src/mflux/models/flux2/variants/txt2img/flux2_klein.py`) is wrapped in `app/flux2_t2i_pipeline.py` for use by the `generate` command. This reuses the same Klein 9B INT8 model components as the `profile` command (which uses `Flux2KleinEdit` for reference conditioning).

**Key differences from Z-Image pipeline:**

| Aspect | Z-Image Turbo | Flux2 Klein 9B |
|--------|--------------|----------------|
| Architecture | ZImageTransformer2DModel (6B) | Flux2Transformer2DModel (9B) |
| Quantization | 4-bit GS=32 (~3.6 GB) | INT8 (~9.6 GB transformer) |
| Default steps | 9 | 4 (distilled) |
| Guidance | N/A | 1.0 (must be 1.0 for distilled) |
| Total memory | ~8 GB | ~17 GB |

**img2img mapping:** Z-Image uses `denoise_strength` (0–1, higher = more change). mflux uses `image_strength` (0–1, higher = closer to original). The mapping: `image_strength = 1.0 - denoise_strength`.

**LoRA:** Not yet supported with flux2-klein pipeline. The `Flux2Klein` class accepts `lora_paths` in its constructor, so this can be added later.

**A/B test mode:** `run.py generate --prompt "..." --ab-test` runs both pipelines sequentially (ZImage first, then Klein) with explicit memory cleanup between them, and creates a side-by-side comparison PNG.
