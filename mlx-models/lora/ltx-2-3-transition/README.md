# ltx-2-3-transition — LoRA Adapter (ltx-2.3)

Smooth scene/style transition LoRA for LTX-2.3.

Source: [https://huggingface.co/joyfox/LTX-2.3-Transition-LORA](https://huggingface.co/joyfox/LTX-2.3-Transition-LORA)

## Files

| File | Size | Description |
|------|------|-------------|
| `ltx2.3-transition.safetensors` | ~372 MB | LoRA weights (ltx-2.3) |

## Trigger Words

`transition`, `smooth transition`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/ltx-2-3-transition/ltx2.3-transition.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/ltx-2-3-transition/ltx2.3-transition.safetensors \
  --lora-scale 0.8
```
