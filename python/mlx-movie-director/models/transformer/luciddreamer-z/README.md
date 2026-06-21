# luciddreamer-z — ZImage-Turbo Transformer (8-bit MLX)

LucidDreamer Z v0.777A ZiT: Hyper-detailed, surreal, dreamlike image generator with cinematic lighting and imaginative surrealism..

Source: [https://civitai.com/models/2229037](https://civitai.com/models/2229037)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer luciddreamer-z \
  --prompt 'your prompt here'
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
