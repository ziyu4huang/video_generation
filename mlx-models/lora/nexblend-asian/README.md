# nexblend-asian — LoRA Adapter (flux2-klein-9b)

NexBlend Asian Semi Realistic Flux 2 Klein 9B Flux 2 Klein 9B.

Source: [https://civitai.com/models/2535707](https://civitai.com/models/2535707)

## Files

| File | Size | Description |
|------|------|-------------|
| `NexBlend Asian Semi Realistic Flux 2 Klein 9B.safetensors` | ~158 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/nexblend-asian/NexBlend Asian Semi Realistic Flux 2 Klein 9B.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/nexblend-asian/NexBlend Asian Semi Realistic Flux 2 Klein 9B.safetensors \
  --lora-scale 0.8
```
