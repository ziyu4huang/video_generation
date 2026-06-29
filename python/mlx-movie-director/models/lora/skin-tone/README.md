# skin-tone — LoRA Adapter (flux2-klein-9b)

K-Slider : Body control pale skin - tanned skin.

Source: [https://civitai.com/models/2529815](https://civitai.com/models/2529815)

## Files

| File | Size | Description |
|------|------|-------------|
| `skin tone.safetensors` | ~40 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/skin-tone/skin tone.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/skin-tone/skin tone.safetensors \
  --lora-scale 0.8
```
