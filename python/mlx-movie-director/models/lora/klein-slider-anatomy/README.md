# klein-slider-anatomy — LoRA Adapter (flux2-klein-9b)

LoRA adapter for flux2-klein-9b.

Source: [https://civitai.com/models/2324991/klein-anatomy-quality-fixer?modelVersionId=2615554](https://civitai.com/models/2324991/klein-anatomy-quality-fixer?modelVersionId=2615554)

## Files

| File | Size | Description |
|------|------|-------------|
| `klein_slider_anatomy.safetensors` | ~20 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/klein-slider-anatomy/klein_slider_anatomy.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/klein-slider-anatomy/klein_slider_anatomy.safetensors \
  --lora-scale 0.8
```
