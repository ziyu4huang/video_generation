# eye-9b — LoRA Adapter (flux2-klein-9b)

Slider-LORA : Face control - eyes size eyes size.

Source: [https://civitai.com/models/2507651](https://civitai.com/models/2507651)

## Files

| File | Size | Description |
|------|------|-------------|
| `Eye_9B.safetensors` | ~40 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/eye-9b/Eye_9B.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/eye-9b/Eye_9B.safetensors \
  --lora-scale 0.8
```
