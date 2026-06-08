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

**LoRA:** Supported by all three pipeline wrappers (`Flux2KleinT2IPipeline`, `Flux2KleinPipeline`, `Flux2KleinControlnetPipeline`) via `lora_paths`/`lora_scales` constructor arguments. LoRA is applied at model init time (not generate time).

**A/B test mode:** `run.py generate --prompt "..." --ab-test` runs both pipelines sequentially (ZImage first, then Klein) with explicit memory cleanup between them, and creates a side-by-side comparison PNG.

### Reference Conditioning: Flux2KleinEdit (`Flux2KleinEdit`)

Used by: `app/flux2_pipeline.py` (profile), `app/flux2_controlnet_pipeline.py` (controlnet)

`Flux2KleinEdit` is the edit variant of the Flux2 Klein model that supports reference image conditioning. Unlike traditional ControlNet (which uses a separate model with interleaved injection), Flux2KleinEdit concatenates VAE-encoded reference image latents with noise latents in the transformer's input sequence.

#### Architecture: Reference Conditioning Pipeline

1. **VAE encode** each reference image → 4D latent tensor `[1, C, H_lat, W_lat]`
2. **Ensure 4D** / **crop to even** spatial dimensions (patchify requires even H, W)
3. **Batch norm normalize** using `vae.bn.running_mean / running_var`: `(encoded - mean) / sqrt(var + eps)`
4. **Patchify** into `[1, C*4, H_lat//2, W_lat//2]` (2×2 spatial fold into channel dimension)
5. **Pack** into packed latent format `[batch, seq_len, hidden_dim]`
6. **Assign positional IDs** — each image gets a distinct `t_coord` (`t=10+10*i` for the i-th image), so the transformer treats repeated references as separate tokens
7. **Concatenate** `[noise_latents, image_latents]` along the sequence dimension (axis 1)
8. **Transformer forward pass** on the concatenated sequence
9. **Slice** output to `[:noise_latents.shape[1]]` — only the noise prediction tokens are kept

#### Pipeline Wrapper Inventory

| Wrapper | mflux Variant | Command | Use Case |
|---------|--------------|---------|----------|
| `Flux2KleinT2IPipeline` | `Flux2Klein` (txt2img) | `image t2i --pipeline flux2-klein` | Text-to-image, optional img2img |
| `Flux2KleinPipeline` | `Flux2KleinEdit` (edit) | `image profile` | Multi-view character sheets |
| `Flux2KleinControlnetPipeline` | `Flux2KleinEdit` (edit) | `image controlnet --pipeline flux2-klein` | ControlNet-style reference conditioning |

All three share the same model loading pattern:
1. Explicit `model_path` → use directly
2. Local pre-quantized INT8 components → symlink assembly into temp dir
3. HF auto-download + on-the-fly quantization → fallback

#### ControlNet Command: `--pipeline flux2-klein`

```
run.py image controlnet --input-image photo.png --prompt "..." --pipeline flux2-klein
run.py image controlnet --input-image photo.png --prompt "..." --pipeline flux2-klein --skip-preprocess --ref-count 3
```

Unlike Z-Image ControlNet (dedicated ControlNet model + 33-channel interleaved injection), Flux2 Klein uses reference latent concatenation. Best preprocessing: `--skip-preprocess` (raw image) or `--remove-outlines`. Canny edge maps are not effective — Flux2KleinEdit is not trained to interpret edge maps as structural guidance.

#### `ref_count` Parameter

Controls how many times the reference image is repeated in the `image_paths` list passed to `Flux2KleinEdit.generate_image()`. Each repeat gets a distinct `t_coord` (10, 20, 30) so the transformer processes them as separate reference tokens. More repeats = stronger conditioning signal in the concatenated latent sequence.

| Command | Default `ref_count` | Notes |
|---------|-------------------|-------|
| `image controlnet --pipeline flux2-klein` | 1 | Use 2-3 for stronger reference influence |
| `image profile` | 3 | Multiple views benefit from stronger conditioning |

#### `image_strength` Behavior

The `image_strength` parameter has different effects depending on the mflux variant:

- **Flux2Klein (txt2img):** Controls img2img denoising start step via `Config.init_time_step`. Higher value = start later in the denoising schedule = closer to original image. Mapping: `image_strength = 1.0 - denoise_strength`.
- **Flux2KleinEdit (edit):** `image_strength` is effectively a **no-op**. The edit variant uses reference latent concatenation (not noise interpolation), so `image_strength` has no effect on the denoising loop. Reference conditioning strength is controlled by `ref_count` (number of repeated reference tokens in the concatenated sequence).

In `Flux2KleinControlnetPipeline.generate()`, `image_strength` is always passed as `None` for this reason.

#### `guidance=1.0` (Hardcoded)

Flux2 Klein models are **distilled** from the full Flux.2 model and do not support classifier-free guidance (CFG). With `guidance=1.0`, the negative prompt encoding branch is skipped entirely (single forward pass per denoising step). Using `guidance > 1.0` would waste compute on an untrained unconditional branch with no quality improvement.

> **Note on code structure:** The three pipeline wrappers share ~80% identical `__init__()` code (symlink assembly, model loading). A shared base class could collapse this boilerplate, but the duplication is manageable at 3 files and would add indirection for minimal savings. Revisit if a 4th variant is added.
