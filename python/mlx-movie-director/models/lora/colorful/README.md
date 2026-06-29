# colorful — LoRA Adapter (flux2-klein-9b)

K-Slider : Imaging control Colorful.

Source: [https://civitai.com/models/2425555](https://civitai.com/models/2425555)

## Files

| File | Size | Description |
|------|------|-------------|
| `Colorful.safetensors` | ~79 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/colorful/Colorful.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/colorful/Colorful.safetensors \
  --lora-scale 0.8
```
