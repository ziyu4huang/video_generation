# qualitya — LoRA Adapter (flux2-klein-9b)

K-Slider : Imaging control Quality.

Source: [https://civitai.com/models/2425555](https://civitai.com/models/2425555)

## Files

| File | Size | Description |
|------|------|-------------|
| `quality.safetensors` | ~40 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/qualitya/quality.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/qualitya/quality.safetensors \
  --lora-scale 0.8
```
