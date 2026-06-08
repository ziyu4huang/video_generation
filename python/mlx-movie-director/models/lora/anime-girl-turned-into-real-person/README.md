# anime-girl-turned-into-real-person — LoRA Adapter (flux2-klein-9b)

Anime Girl Turned into Real Person v2.0.

Source: [https://civitai.com/models/2349471](https://civitai.com/models/2349471)

## Files

| File | Size | Description |
|------|------|-------------|
| `anything2real_v1_f2k.safetensors` | ~79 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/anime-girl-turned-into-real-person/anything2real_v1_f2k.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/anime-girl-turned-into-real-person/anything2real_v1_f2k.safetensors \
  --lora-scale 0.8
```

## Test Prompt

```
a photo of an anime girl turned into a real person
```
