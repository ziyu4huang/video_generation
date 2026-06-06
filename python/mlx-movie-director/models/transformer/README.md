# Transformer (Z-Image Moody V12.6 — 4-bit MLX)

Z-Image Turbo diffusion transformer (Moody V12.6 DPO fine-tune) converted from ComfyUI format and quantized to 4-bit (group_size=32). This is the core denoising model.

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `config.json` | ~0.5 KB | ✅ Yes — model architecture config |
| `model.safetensors` | ~3.6 GB | ✅ Yes — 4-bit quantized MLX weights |

## Source

Converted from the ComfyUI-compatible checkpoint:

```
comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors   (~11 GB, PyTorch)
```

## How to reproduce

```bash
# Requires source model at comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors
./python/venv/bin/python python/mlx-movie-director/convert.py --transformer
```

### Conversion steps

1. Load source `.safetensors` via `safetensors.torch.load_file` (~11 GB in RAM)
2. **Key remapping** — ComfyUI uses different weight names than the diffusers/Z-Image convention:
   - `all_final_layer.2-1.` → `final_layer.`
   - `all_x_embedder.2-1.` → `x_embedder.`
   - Fused QKV `.qkv.` → split `.to_q.` / `.to_k.` / `.to_v.`
   - `attention.to_out.0.` → `attention.out.`
   - `adaLN_modulation.0/1` → `adaLN_modulation` / `adaLN_modulation.layers.1`
   - `cap_embedder.0/1` → `cap_embedder.layers.0/1`
   - `t_embedder.mlp.0/2` → `t_embedder.linear1/linear2`
   - Drop `model.diffusion_model.norm_final.weight` (unused)
3. Cast to bfloat16 → MLX `mx.array`
4. Load into `ZImageTransformerMLX` model
5. Quantize to 4-bit with `mlx.nn.quantize(model, bits=4, group_size=32)`
6. Save as `model.safetensors` + `config.json`

**Result**: ~11 GB → ~3.6 GB (3× compression).

## Architecture config

| Parameter | Value |
|-----------|-------|
| dim | 3840 |
| in_channels | 16 |
| n_layers | 30 |
| n_refiner_layers | 2 |
| n_heads / n_kv_heads | 30 |
| cap_feat_dim | 2560 |
| rope_theta | 256.0 |
| t_scale | 1000.0 |
| qk_norm | true |
| patch_size | 2 |
