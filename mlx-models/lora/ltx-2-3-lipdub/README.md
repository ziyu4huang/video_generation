# ltx-2-3-lipdub — LoRA Adapter (ltx-2.3)

LipDub IC-LoRA: reference-video lip-dubbing for LTX-2.3. A two-stage IC-LoRA
pipeline that re-synthesizes a video with lips synced to the reference video's
own audio track (VAE-encoded as an appended reference-audio conditioning).

Source: [https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-LipDub](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-LipDub)
(HF-gated — accept the license at the model page before downloading.)

## Files

| File | Size | Description |
|------|------|-------------|
| `ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors` | ~2352 MB | LoRA weights (ltx-2.3) |

## Usage

```bash
# Lip-dub a reference video (which supplies both visual structure and the
# target speech audio) — the LoRA is auto-detected from mlx-models/lora/*lipdub*.
./python/venv/bin/python python/mlx-movie-director/run.py video lipdub \
  --lipdub-reference-video talking_head.mp4 \
  --prompt 'a person speaking to the camera, natural lip motion'

# Explicit LoRA path + scale
./python/venv/bin/python python/mlx-movie-director/run.py video lipdub \
  --lipdub-reference-video talking_head.mp4 --prompt '...' \
  --lipdub-lora mlx-models/lora/ltx-2-3-lipdub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors \
  --lora-scale 1.0
```
