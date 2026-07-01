# longface-9b — LoRA Adapter (flux2-klein-9b)

FaceControl LoRA for long face generation.

Source: [https://huggingface.co/NO8D/FaceControl/resolve/main/LongFace_9B.safetensors](https://huggingface.co/NO8D/FaceControl/resolve/main/LongFace_9B.safetensors)

## Files

| File | Size | Description |
|------|------|-------------|
| `LongFace_9B.safetensors` | ~40 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/longface-9b/LongFace_9B.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/longface-9b/LongFace_9B.safetensors \
  --lora-scale 0.8
```
