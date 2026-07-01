# singularity-omnicine-v1 — LoRA Adapter (ltx-2.3)

Singularity OmniCine V1 — quality enhancement LoRA: fixes anatomy, enables cinematic cuts, improves physics.

Source: [https://huggingface.co/WarmBloodAban/Singularity-LTX-2.3_OmniCine_V1](https://huggingface.co/WarmBloodAban/Singularity-LTX-2.3_OmniCine_V1)

## Files

| File | Size | Description |
|------|------|-------------|
| `singularity-temp.safetensors` | ~2571 MB | LoRA weights (ltx-2.3) |

## Trigger Words

`omnicine`, `singularity`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/singularity-omnicine-v1/singularity-temp.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/singularity-omnicine-v1/singularity-temp.safetensors \
  --lora-scale 0.8
```
