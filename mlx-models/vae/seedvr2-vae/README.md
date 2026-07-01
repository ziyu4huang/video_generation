# Upscaler VAE (SeedVR2 3D VAE — MLX BF16)

SeedVR2 3D causal VAE for latent encode/decode in the AI upscaling pipeline. Handles spatial-temporal latent compression with 3D convolutions. Converted from ComfyUI FP16 to MLX BF16 (no quantization — Conv3D layers must stay full precision).

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `model.safetensors` | ~478 MB | ✅ Yes — MLX BF16 weights |
| `manifest.json` | ~0.3 KB | ✅ Yes — model metadata |

## Source

Converted from the ComfyUI-compatible checkpoint:

```
comfyui_data/models/SEEDVR2/ema_vae_fp16.safetensors   (~500 MB, PyTorch FP16)
```

## How to reproduce

```bash
# Requires source model at comfyui_data/models/SEEDVR2/ema_vae_fp16.safetensors
./python/venv/bin/python python/mlx-movie-director/convert.py --seedvr2-vae
```

### Conversion steps

1. Load source `.safetensors` via `safetensors.torch.load_file` (~500 MB in RAM)
2. Cast all weights to bfloat16 numpy → MLX `mx.array`
3. **Conv3D transpose**: PyTorch `(O, I, kT, kH, kW)` → MLX `(O, kT, kH, kW, I)` (channel-last convention)
4. Load into `SeedVR2VAE` model
5. Save as `model.safetensors` (no quantization)

## Runtime usage

```python
from app.seedvr2.pipeline import SeedVR2Upscaler
upscaler = SeedVR2Upscaler(model_size="7b")
# VAE is loaded lazily inside the upscaler pipeline
result = upscaler.upscale(pil_image, resolution=2160, softness=0.5, seed=42)
```

## Key details

- **3D causal convolutions** for temporal consistency in video upscaling (single-frame = temporal dim = 1)
- **Not quantized** — Conv3D weights need full precision for quality
- Paired with `seedvr2-7b` transformer in the upscaler pipeline
