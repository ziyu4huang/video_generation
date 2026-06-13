# vbvr-licon-240k — LoRA Adapter (ltx-2.3)

LiconStudio VBVR LoRA for LTX-2.3 — Stage 2 extended checkpoint (240K training steps). LoRA rank 32, continued training from the 96K foundation on the full 240K VBVR dataset.

Source: [https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V](https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V)

## Files

| File | Size | Description |
|------|------|-------------|
| `Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors` | ~528 MB | LoRA weights (ltx-2.3) |

## Trigger Words

None (applies automatically to VBVR-type prompts)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
  --transformer dev \
  --lora vbvr-licon-240k
```
