# VAE (AutoencoderKL — Flux/Z-Image)

16-channel FLUX-compatible VAE for latent-to-image encoding/decoding.
Used in Phase 0 (encode) and Phase 4 (decode) of the ZImage pipeline.
Converted to MLX BF16 for native MLX inference — no PyTorch/diffusers dependency.

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `model.safetensors` | ~160 MB | ✅ Yes — MLX BF16 weights |
| `config.json` | ~1 KB | ✅ Yes — VAE architecture config |

## Source

Downloaded from [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) (`vae/` subdirectory),
then converted from PyTorch FP32 to MLX BF16 via `convert.py --vae-mlx`.

## How to reproduce

```bash
# Step 1: Download PyTorch weights (one-time)
./python/venv/bin/python python/mlx-movie-director/convert.py --vae

# Step 2: Convert to MLX BF16
/Users/huangziyu/.local/bin/python3.13 convert.py --vae-mlx
```

## Runtime usage

```python
from mflux.models.z_image.model.z_image_vae import VAE
vae = VAE()
vae.load_weights("models/vae/flux-ae/model.safetensors")
mx.eval(vae.parameters())
# Encode: latent = vae.encode(image_array)
# Decode: image = vae.decode(latent_array)
```

## A/B Test Results

PSNR: 50.57 dB between PyTorch and MLX VAE decode (same latent, seed 42).
Mean pixel difference: 0.41/255. Quality validated 2026-06-07.

## Key config values

- `latent_channels`: 16 (matches transformer `in_channels`)
- `scaling_factor`: 0.3611
- `shift_factor`: 0.1159
- `spatial_scale`: 8
