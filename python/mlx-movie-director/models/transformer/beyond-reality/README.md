# beyond-reality — ZImage-Turbo Transformer (8-bit MLX)

BEYOND REALITY 3.0 FP8: Ultra-realistic image generation with enhanced detail and dynamic lighting in FP8 precision..

Source: [https://civitai.com/models/1090420](https://civitai.com/models/1090420)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer beyond-reality \
  --prompt 'your prompt here'
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
