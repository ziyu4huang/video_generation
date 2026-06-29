# lips-9b — LoRA Adapter (flux2-klein-9b)

Slider-LORA : Face control - lips lips.

Source: [https://civitai.com/models/2603583](https://civitai.com/models/2603583)

## Files

| File | Size | Description |
|------|------|-------------|
| `Lips_9B.safetensors` | ~40 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/lips-9b/Lips_9B.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/lips-9b/Lips_9B.safetensors \
  --lora-scale 0.8
```
