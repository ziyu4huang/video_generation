# moody-pro-mix — ZImage-Turbo Transformer (8-bit MLX)

Moody Pro Mix ZIT V13: Advanced ZImageTurbo checkpoint for expressive, emotionally rich, and stylistically diverse image generation..

Source: [https://civitai.com/models/620406](https://civitai.com/models/620406)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer moody-pro-mix \
  --prompt 'your prompt here'
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
