# anything2real-characters — LoRA Adapter (flux2-klein-9b)

Flux2 Klein_Anything to Real Characters v1.0.

Source: [https://civitai.com/models/2343188](https://civitai.com/models/2343188)

## Files

| File | Size | Description |
|------|------|-------------|
| `Flux2 Klein动漫转写实真人 AnythingtoRealCharacters.safetensors` | ~158 MB | LoRA weights (flux2-klein-9b) |

## Trigger Words

`realistic style of a young Asian girl`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/anything2real-characters/Flux2 Klein动漫转写实真人 AnythingtoRealCharacters.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/anything2real-characters/Flux2 Klein动漫转写实真人 AnythingtoRealCharacters.safetensors \
  --lora-scale 0.8
```
