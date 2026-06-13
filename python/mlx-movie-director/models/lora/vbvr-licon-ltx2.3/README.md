# vbvr-licon-ltx2.3 — LoRA Adapter (ltx-2.3)

LiconStudio VBVR LoRA for LTX-2.3 — improves complex prompt following, motion dynamics, and temporal consistency. Trained on full VBVR dataset (~1M videos). ComfyUI format, compatible with MLX pipeline `LTXV_LORA_COMFY_RENAMING_MAP`.

Source: [https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V](https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V)

## Files

| File | Size | Description |
|------|------|-------------|
| `VBVR-official-comfyui.safetensors` | ~408 MB | LoRA weights (ltx-2.3) |

## Trigger Words

None (applies automatically to VBVR-type prompts)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
  --transformer dev \
  --lora vbvr-licon-ltx2.3
```
