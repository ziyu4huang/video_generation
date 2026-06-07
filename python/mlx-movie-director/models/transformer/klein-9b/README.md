# transformer/klein-9b — Flux2 Klein 9B Transformer (INT8)

## Source

Converted from `black-forest-labs/FLUX.2-klein-9B` (BF16 ~16.9 GB)
via `convert.py --klein-9b` using mflux `ModelSaver`.

## Files

| File | Size | Description |
|------|------|-------------|
| config.json | ~0.5 KB | Flux2Transformer2DModel architecture config |
| 0.safetensors | 2.0 GB | INT8 quantized shard 0 |
| 1.safetensors | 2.0 GB | INT8 quantized shard 1 |
| 2.safetensors | 1.9 GB | INT8 quantized shard 2 |
| 3.safetensors | 1.9 GB | INT8 quantized shard 3 |
| 4.safetensors | 1.1 GB | INT8 quantized shard 4 |
| model.safetensors.index.json | ~1 KB | Shard key → file mapping |

**Total: ~9.2 GB** (BF16 ~16.9 GB → INT8 ~9.2 GB, 45% reduction)

## Key Config

| Param | Value |
|-------|-------|
| attention_head_dim | 128 |
| num_attention_heads | 32 |
| num_layers | 8 |
| num_single_layers | 24 |
| joint_attention_dim | 12288 |
| in_channels | 128 |
| guidance_embeds | false |

## Used by

- `run.py profile` — multi-view character profile generation
- `app/flux2_pipeline.py` → assembled via symlink with text_encoder, vae, tokenizer

## Reproduce

```bash
/Users/huangziyu/.local/bin/python3.13 convert.py --klein-9b
```
