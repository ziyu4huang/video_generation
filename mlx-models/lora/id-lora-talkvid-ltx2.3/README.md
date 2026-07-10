# id-lora-talkvid-ltx2.3 — LoRA Adapter (ltx-2.3)

ID-LoRA (ECCV 2026): a joint appearance+voice In-Context LoRA for LTX-2.3.
This is the **TalkVid** checkpoint variant, tuned for static talking-head
videos and digital avatars — the counterpart CelebV-HQ variant is tuned for
complex motion/singing instead. Same shape as the existing LipDub IC-LoRA
(1728 audio-branch tensors, byte-identical key naming/shapes, confirmed via
safetensors-header inspection — see
`docs/id-lora-mlx-compatibility-check-20260710.md`), so it is a drop-in
checkpoint swap through the same `--lipdub-lora` flag, no new MLX code.

Source: [https://huggingface.co/AviadDahan/LTX-2.3-ID-LoRA-TalkVid-3K](https://huggingface.co/AviadDahan/LTX-2.3-ID-LoRA-TalkVid-3K)
(not gated, unlike the LipDub LoRA — no license click-through needed.)

## Files

| File | Size | Description |
|------|------|-------------|
| `lora_weights.safetensors` | ~1.16 GB | LoRA weights (ltx-2.3) |

## Usage

```bash
./python/venv/bin/python python/mlx-movie-director/run.py video lipdub \
  --lipdub-reference-video talking_head.mp4 --prompt '...' \
  --lipdub-lora mlx-models/lora/id-lora-talkvid-ltx2.3/lora_weights.safetensors \
  --lora-scale 1.0
```
