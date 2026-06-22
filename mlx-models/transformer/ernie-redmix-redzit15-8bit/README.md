# ernie-redmix-redzit15-8bit — ZImage-Turbo Transformer (8-bit MLX)

RedZiT 1.5 AIO, 8-bit MLX (A/B vs the 4-bit ernie-redmix-redzit15). Same pruned bf16 source, 8-bit quantization..

Source: [https://civitai.com/models/958009](https://civitai.com/models/958009)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer ernie-redmix-redzit15-8bit \
  --prompt 'your prompt here'
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
