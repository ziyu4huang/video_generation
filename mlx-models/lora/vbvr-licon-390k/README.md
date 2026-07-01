# vbvr-licon-390k — LoRA Adapter (ltx-2.3)

LiconStudio VBVR LoRA for LTX-2.3 — Stage 3 best checkpoint (240K + 150K reinforcement = 390K effective steps). LoRA rank 32. Recommended checkpoint for production use.

Source: [https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V](https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V)

## Files

| File | Size | Description |
|------|------|-------------|
| `Ltx2.3-Licon-VBVR-I2V-390K-R32.safetensors` | ~528 MB | LoRA weights (ltx-2.3) |

## Trigger Words

None (applies automatically to VBVR-type prompts)

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
  --transformer dev \
  --lora vbvr-licon-390k
```
