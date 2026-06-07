# Upscaler Transformer (SeedVR2 7B — 4-bit MLX)

SeedVR2 7B diffusion transformer for AI upscaling. Converts low-resolution images to high-resolution with realistic detail synthesis (single-step denoising). Converted from ComfyUI format and quantized to 4-bit (group_size=32, Conv3D and small dims skipped).

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `model.safetensors` | ~4.8 GB | ✅ Yes — 4-bit quantized MLX weights |
| `manifest.json` | ~0.3 KB | ✅ Yes — model metadata |

## Source

Converted from the ComfyUI-compatible checkpoint:

```
comfyui_data/models/SEEDVR2/seedvr2_ema_7b_fp16.safetensors   (~15 GB, PyTorch FP16)
```

## How to reproduce

```bash
# Requires source model at comfyui_data/models/SEEDVR2/seedvr2_ema_7b_fp16.safetensors
./python/venv/bin/python python/mlx-movie-director/convert.py --seedvr2-dit
```

### Conversion steps

1. Load source `.safetensors` via `safetensors.torch.load_file` (~15 GB in RAM)
2. **Key remapping** — ComfyUI `blocks.N.{vid,txt,all}.*` keys mapped to MLX model structure:
   - Shared blocks (`i >= mm_layers`): `vid` → `all`, `txt` skipped (duplicate)
   - Non-shared blocks: `vid` / `txt` kept separate
   - Last layer vid-only: `txt` keys dropped
   - Attention QKV/norm keys split into `proj_qkv_{vid,txt}`, `norm_{q,k}_{vid,txt}`
3. Cast to bfloat16 → MLX `mx.array`
4. Load into `SeedVR2Transformer` model
5. Quantize to 4-bit with `mlx.nn.quantize(model, bits=4, group_size=32, class_predicate=...)`
   - Conv2d/Conv3d layers skipped
   - Linear layers with last dim not divisible by 64 skipped
6. Save as `model.safetensors`

**Result**: ~15 GB → ~4.8 GB (3× compression).

## Architecture config (7B)

| Parameter | Value |
|-----------|-------|
| vid_dim | 3072 |
| txt_in_dim | 5120 |
| txt_dim | 3072 |
| emb_dim | 18432 |
| heads | 24 |
| num_layers | 36 |
| mm_layers | 36 (all shared) |
| rope_dim | 64 |
| rope_on_text | false |
| rope_freqs_for | pixel |
| use_output_ada | false |
| last_layer_vid_only | true |
| window | (4, 3, 3) |
| mlp_type | normal (GELU) |

## Runtime usage

```python
from app.seedvr2.pipeline import SeedVR2Upscaler
upscaler = SeedVR2Upscaler(model_size="7b")
result = upscaler.upscale(pil_image, resolution=2160, softness=0.5, seed=42)
```
