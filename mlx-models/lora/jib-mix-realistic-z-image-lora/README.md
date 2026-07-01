# jib-mix-realistic-z-image-lora — LoRA Adapter (zimage-turbo)

Jib Mix Realistic Z-image Lora V1 (Style LoRA).

Source: [https://civitai.com/models/2194714](https://civitai.com/models/2194714)

## Files

| File | Size | Description |
|------|------|-------------|
| `Jibs_Realistic_z-image_lora_V1.safetensors` | ~162 MB | LoRA weights (zimage-turbo) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/jib-mix-realistic-z-image-lora/Jibs_Realistic_z-image_lora_V1.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/jib-mix-realistic-z-image-lora/Jibs_Realistic_z-image_lora_V1.safetensors \
  --lora-scale 0.8
```
