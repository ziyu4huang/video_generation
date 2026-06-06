# VAE (AutoencoderKL — Flux/Z-Image)

16-channel FLUX-compatible VAE for latent-to-image decoding. Used in Phase 4 of the pipeline via `diffusers.AutoencoderKL` on MPS (with tiling enabled).

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `config.json` | ~1 KB | ✅ Yes — VAE architecture config |
| `diffusion_pytorch_model.safetensors` | ~160 MB | ✅ Yes — PyTorch weights (FP32) |

## Source

Downloaded from [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) (`vae/` subdirectory).

## How to reproduce

```bash
./python/venv/bin/python python/mlx-movie-director/convert.py --vae
```

This runs `huggingface_hub.snapshot_download` with `allow_patterns=["vae/*"]`, placing files under `models/vae/`.

## Runtime usage

```python
from diffusers import AutoencoderKL
vae = AutoencoderKL.from_pretrained("models/vae").to("mps")
vae.enable_tiling()
```

## Key config values

- `latent_channels`: 16 (matches transformer `in_channels`)
- `scaling_factor`: 0.3611
- `shift_factor`: 0.1159
