# klein-9b-dark-beast-bfs — Flux2 Klein 9B Transformer (INT8)

Dark Beast KLEIN 9b V2.0 BFS — face-swap specialized variant of Flux2 Klein 9B.
Converted from Civitai FP8 checkpoint to MLX INT8.

Source: [Civitai — DBKleinV2 BFS](https://civitai.com/models/2242173/dark-beast-or?modelVersionId=2740209)

## Key Features

- **BFS (Best Face Swap)** technology for seamless face replacement
- Built on Flux2 Klein 9B accelerated architecture
- Ultra-low steps (4-5), CFG=1 fixed
- Converted from FP8 → BF16 → MLX INT8 for Apple Silicon

## Files

| File | Size | Description |
|------|------|-------------|
| `0-4.safetensors` | ~9.2 GB | Sharded INT8 transformer weights |
| `model.safetensors.index.json` | 36 KB | Shard mapping |
| `config.json` | 467 B | Architecture config |
| `manifest.json` | — | Model registry metadata |

## Shared Components (reuse from base Klein 9B)

This transformer reuses the architecture-compatible components from the base Klein 9B setup:

| Component | Path |
|-----------|------|
| Text Encoder | `text_encoder/qwen3-8b/` |
| VAE | `vae/flux2-klein/` |
| Tokenizer | `tokenizer/qwen3-klein/` |

## Conversion

```bash
# Convert from Civitai FP8 checkpoint
./python/venv/bin/python python/mlx-movie-director/convert.py \
  --klein-9b-checkpoint /path/to/darkBeast_dbkleinv2BFS.safetensors \
  --name klein-9b-dark-beast-bfs
```

## Usage

This model is used with the `flux2-klein` pipeline. Select it by pointing to the transformer directory.
