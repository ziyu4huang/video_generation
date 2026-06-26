# moody-desire-mix — Flux2 Klein 9B Transformer (INT8 MLX)

Moody Desire Mix v3.0: Flux.2 Klein 9B checkpoint for evocative, emotionally rich, and atmospheric image generation..

Source: [https://civitai.com/models/2519616](https://civitai.com/models/2519616)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline flux2-klein --transformer moody-desire-mix \
  --prompt 'your prompt here'
```

## Notes

- Format: INT8 quantized MLX (group_size=64, sharded)
- Converted from CivitAI safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-8b, tokenizer/qwen3-klein, vae/flux2-klein
