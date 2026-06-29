# chest-9b — LoRA Adapter (flux2-klein-9b)

K-Slider : Body control chest.

Source: [https://civitai.com/models/2529815](https://civitai.com/models/2529815)

## Files

| File | Size | Description |
|------|------|-------------|
| `Chest_9B.safetensors` | ~40 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/chest-9b/Chest_9B.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/chest-9b/Chest_9B.safetensors \
  --lora-scale 0.8
```
