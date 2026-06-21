# dark-beast-dbzit9 — ZImage-Turbo Transformer (8-bit MLX)

Dark Beast | 黑兽 DBZiT9🟥DIM RClaw ZImage-Turbo transformer, converted to 8-bit MLX.

Source: [https://civitai.com/models/2242173](https://civitai.com/models/2242173)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer dark-beast-dbzit9 \
  --prompt 'your prompt here'
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
