# ernie-redmix-redzit15-lora — LoRA Adapter (zimage-turbo)

LoRA adapter for zimage-turbo.

## Files

| File | Size | Description |
|------|------|-------------|
| `ernie-redmix-redzit15_lora_fp16.safetensors` | ~670 MB | LoRA weights (zimage-turbo) |

## Trigger Words

`ernie redmix`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/ernie-redmix-redzit15-lora/ernie-redmix-redzit15_lora_fp16.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/ernie-redmix-redzit15-lora/ernie-redmix-redzit15_lora_fp16.safetensors \
  --lora-scale 0.8
```
