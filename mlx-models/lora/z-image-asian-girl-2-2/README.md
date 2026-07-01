# z-image-asian-girl-2-2 — LoRA Adapter (zimage-turbo)

Z-Image-Asian girl 2（小红书女孩2） v1.0.

Source: [https://civitai.com/models/2175220](https://civitai.com/models/2175220)

## Files

| File | Size | Description |
|------|------|-------------|
| `Z-xhs888.safetensors` | ~162 MB | LoRA weights (zimage-turbo) |

## Trigger Words

`xhs888 woman`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/z-image-asian-girl-2-2/Z-xhs888.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/z-image-asian-girl-2-2/Z-xhs888.safetensors \
  --lora-scale 0.8
```

## Test Prompt

```
xhs888 woman wearing a white sweater taking a selfie indoors with messy hair and winking at camera
```
