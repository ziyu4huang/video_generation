# vbvr-ltx2.3 — LoRA Adapter (ltx-2.3)

VBVR (Video Benchmark for Video Reasoning) LoRA — improves temporal consistency, multi-object interactions, complex sequential actions, and causal/physics reasoning for LTX-2.3.

Source: [https://huggingface.co/siraxe/VBVR-LTX2.3-diffsynth_comfyui](https://huggingface.co/siraxe/VBVR-LTX2.3-diffsynth_comfyui)

## Files

| File | Size | Description |
|------|------|-------------|
| `Video-Reason_VBVR-LTX2.3-diffsynth_comfyui.safetensors` | ~408 MB | LoRA weights (ltx-2.3) |

## Trigger Words

None

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
  --transformer dev \
  --lora vbvr-ltx2.3
```
