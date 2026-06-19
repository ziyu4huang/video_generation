# nsfw-master — LoRA Adapter (zimage-turbo)

NSFW MASTER Z-Image Turbo V2.

Source: [https://civitai.com/models/667086](https://civitai.com/models/667086)

## Files

| File | Size | Description |
|------|------|-------------|
| `NSFW_master_ZIT_000017532.safetensors` | ~593 MB | LoRA weights (zimage-turbo) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/nsfw-master/NSFW_master_ZIT_000017532.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/nsfw-master/NSFW_master_ZIT_000017532.safetensors \
  --lora-scale 0.8
```
