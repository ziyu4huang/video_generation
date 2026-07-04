# ltx-2-3-ingredients — LoRA Adapter (ltx-2.3)

Ingredients IC-LoRA: single-reference-image conditioning for LTX-2.3.

Source: [https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients)

## Files

| File | Size | Description |
|------|------|-------------|
| `ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors` | ~1248 MB | LoRA weights (ltx-2.3) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/ltx-2-3-ingredients/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/ltx-2-3-ingredients/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors \
  --lora-scale 0.8
```
