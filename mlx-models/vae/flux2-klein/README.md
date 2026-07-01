# vae/flux2-klein — Flux2 Klein VAE (INT8)

## Source

Converted from `black-forest-labs/FLUX.2-klein-9B/vae/` (BF16 ~160 MB)
via `convert.py --klein-9b` using mflux `ModelSaver`.

## Files

| File | Size | Description |
|------|------|-------------|
| config.json | ~0.5 KB | AutoencoderKLFlux2 architecture config |
| 0.safetensors | 158 MB | INT8 quantized weights |
| model.safetensors.index.json | ~0.3 KB | Shard key mapping |

**Total: ~158 MB**

## Key Config

| Param | Value |
|-------|-------|
| latent_channels | 32 |
| patch_size | [2, 2] |
| scaling_factor | 0.3611 |
| shift_factor | 0.1159 |
| block_out_channels | [128, 256, 512, 512] |

## Used by

- `run.py profile` — encodes reference images + decodes generated latents
- `app/flux2_pipeline.py` → assembled via symlink with transformer, text_encoder, tokenizer

## Reproduce

```bash
/Users/huangziyu/.local/bin/python3.13 convert.py --klein-9b
```
