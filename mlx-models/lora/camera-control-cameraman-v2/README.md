# camera-control-cameraman-v2 — LoRA Adapter (ltx-2.3)

Cseti Cameraman v2 IC-LoRA for camera-movement conditioning (dolly_in/tilt_up in v1).

## Files

| File | Size | Description |
|------|------|-------------|
| `LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors` | ~624 MB | LoRA weights (ltx-2.3) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/camera-control-cameraman-v2/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/camera-control-cameraman-v2/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors \
  --lora-scale 0.8
```
