# vbvr-licon-96k — LoRA Adapter (ltx-2.3)

LiconStudio VBVR LoRA for LTX-2.3 — Stage 1 foundation checkpoint (96K training steps). LoRA rank 32, trained on 96K VBVR general videos with lr=1e-4 cosine schedule.

Source: [https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V](https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V)

## Files

| File | Size | Description |
|------|------|-------------|
| `Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors` | ~528 MB | LoRA weights (ltx-2.3) |

## Trigger Words

None (applies automatically to VBVR-type prompts)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
  --transformer dev \
  --lora vbvr-licon-96k
```
