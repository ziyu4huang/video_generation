# klein-slider-bodyweight-50 — LoRA Adapter (flux2-klein-9b)

LoRA adapter for flux2-klein-9b.

Source: [https://civitai.com/models/2318844/klein-9b-body-weight-slider?modelVersionId=2608738](https://civitai.com/models/2318844/klein-9b-body-weight-slider?modelVersionId=2608738)

## Files

| File | Size | Description |
|------|------|-------------|
| `klein_slider_bodyweight_50.safetensors` | ~20 MB | LoRA weights (flux2-klein-9b) |

## Trigger Words

`slider`, `bodyweight`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/klein-slider-bodyweight-50/klein_slider_bodyweight_50.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/klein-slider-bodyweight-50/klein_slider_bodyweight_50.safetensors \
  --lora-scale 0.8
```
