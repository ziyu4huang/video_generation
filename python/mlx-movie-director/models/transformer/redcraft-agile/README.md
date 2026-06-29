# redcraft-agile — ZImage-Turbo Transformer (8-bit MLX)

RedCraft | 红潮 | KREA 2 赤佬 Red Mix Edition NSFW ZIB Distilled⚡️FUNxAGILE ZImage-Turbo transformer, converted to 8-bit MLX.

Source: [https://civitai.com/models/958009](https://civitai.com/models/958009)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer redcraft-agile \
  --prompt 'your prompt here'
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
