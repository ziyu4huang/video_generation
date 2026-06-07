# LoRA Adapters

Low-rank adapters for the Z-Image transformer. Applied at runtime — no pre-conversion needed (see [lora_utils.py](../../app/lora_utils.py)).

## Files

| File | Size | Description |
|------|------|-------------|
| `zit_sda_v1.safetensors` | ~162 MB | Z-Image Style Diversity Adapter v1 |

## zit_sda_v1 — Source

Copied from the ComfyUI moody-zimage workflow's LoRA collection:

```
comfyui_data/models/loras/zit_sda_v1.safetensors
```

Used in the `moody-zimage-v7.5.json` ComfyUI workflow to increase output diversity while maintaining the moody photorealistic style.

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "moody portrait photo" \
  --lora-path python/mlx-movie-director/models/lora/zit_sda_v1.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "moody portrait photo" \
  --lora-path python/mlx-movie-director/models/lora/zit_sda_v1.safetensors \
  --lora-scale 0.8
```

## Why no MLX conversion?

LoRA files are converted on-the-fly at runtime (PyTorch → numpy → MLX bfloat16, in memory). This is fast (~1s for 162MB) because:

- LoRA weights are low-rank A/B matrices — small compared to the base model
- No quantization benefit — 4-bit would hurt quality for negligible savings
- Swappable — different LoRAs can be used per run without pre-converting each one

The base transformer (~3.6 GB) and text encoder (~2.3 GB) are pre-converted because they're large and always used; LoRA is an optional overlay.
