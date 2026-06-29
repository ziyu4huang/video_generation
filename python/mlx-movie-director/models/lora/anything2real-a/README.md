# anything2real-a — LoRA Adapter (flux2-klein-9b)

[Flux2Klein 9B] Anything2Real lrzjason F2K 9B Anything2Real A.

Source: [https://civitai.com/models/2121900](https://civitai.com/models/2121900)

## Files

| File | Size | Description |
|------|------|-------------|
| `f2k_anything2real_a_patched.safetensors` | ~272 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/anything2real-a/f2k_anything2real_a_patched.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/anything2real-a/f2k_anything2real_a_patched.safetensors \
  --lora-scale 0.8
```
