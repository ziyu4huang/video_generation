# midjourney-luneva-cinematic-lora — LoRA Adapter (zimage-turbo)

Midjourney Luneva Cinematic Lora LORA: R128-5000step.

Source: [https://civitai.com/models/2185167](https://civitai.com/models/2185167)

## Files

| File | Size | Description |
|------|------|-------------|
| `ZIT_Midjourney_Luneva_Cinematic_v1_r128.safetensors` | ~649 MB | LoRA weights (zimage-turbo) |

**Recommended scale:** `0.8`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/midjourney-luneva-cinematic-lora/ZIT_Midjourney_Luneva_Cinematic_v1_r128.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/midjourney-luneva-cinematic-lora/ZIT_Midjourney_Luneva_Cinematic_v1_r128.safetensors \
  --lora-scale 0.8
```

## Test Prompt

```
a cinematic photograph of a cityscape at dusk, using cinematic style
```
