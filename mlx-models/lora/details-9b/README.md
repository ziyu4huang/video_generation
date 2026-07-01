# details-9b — LoRA Adapter (flux2-klein-9b)

Flux2 Klein 9B Realistic Detail v1.0.

Source: [https://civitai.com/models/2662689](https://civitai.com/models/2662689)

## Files

| File | Size | Description |
|------|------|-------------|
| `Flux2 Klein 9B Realistic Detail LoRA.safetensors` | ~158 MB | LoRA weights (flux2-klein-9b) |

## Trigger Words

`srx_detail`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/details-9b/Flux2 Klein 9B Realistic Detail LoRA.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/details-9b/Flux2 Klein 9B Realistic Detail LoRA.safetensors \
  --lora-scale 0.8
```
