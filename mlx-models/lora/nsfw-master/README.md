# nsfw-master — LoRA Adapter (zimage-turbo)

NSFW MASTER Z-Image Turbo V2.

Source: [https://civitai.com/models/667086](https://civitai.com/models/667086)

## Recommended Parameters

| Parameter | SFW (style enhancement) | NSFW (content generation) |
|-----------|--------------------------|---------------------------|
| Steps | 9–12 | 9–12 |
| CFG scale | 2.5 | 2.5 |
| LoRA scale | **0.65** | **1.0** |

> **No trigger words** — this LoRA is trigger-word-free; content type in the prompt drives activation.
> Creator recommended weight: 0.8 (middle ground, not optimal for either mode).

## Scale Behavior (A/B tested)

Scale behaves **opposite** for SFW vs NSFW content:

### SFW portrait sweep (seed=42, 9 steps, style review)
| Scale | Overall | Notes |
|-------|---------|-------|
| 0.50 | 8 | clean |
| **0.65** | **9** | best — composition + adherence highest |
| 0.75 | 8 | clean |
| 0.85 | 8 | clean |
| 1.00 | 7 | FAIL: painterly/watercolor, prompt adherence 5/10 |

### NSFW content sweep (seed=42, 12 steps, cfg=2.5, adversarial score)
| Scale | Overall | Detail | Notes |
|-------|---------|--------|-------|
| 0.50 | 3 | 4 | LoRA under-activated |
| 0.65 | 3 | 4 | LoRA under-activated |
| 0.80 | 3 | 4 | LoRA under-activated |
| **1.00** | **7** | **5** | full LoRA activation — best for NSFW |

**Root cause**: The LoRA was trained on NSFW content. At low scale it cannot overcome
the base model's distribution toward SFW-style output. At scale=1.0 it fully activates
and produces NSFW-appropriate results matching the base model's SFW quality level.

> Note: skin oversmoothing (detail≈5–6) is a **4-bit zimage base-model characteristic**,
> not caused by this LoRA. Without LoRA, NSFW content scores detail=4; with LoRA at 1.0, detail=5.

## Usage

```bash
# SFW style enhancement — scale auto-read from manifest (0.65)
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --prompt 'cinematic studio portrait, professional photography' \
  --lora-path python/mlx-movie-director/models/lora/nsfw-master/NSFW_master_ZIT_000017532.safetensors \
  --cfg-scale 2.5

# NSFW content generation — explicit scale=1.0
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --prompt 'your nsfw prompt here' \
  --lora-path python/mlx-movie-director/models/lora/nsfw-master/NSFW_master_ZIT_000017532.safetensors \
  --lora-scale 1.0 \
  --cfg-scale 2.5 --steps 12
```

## Files

| File | Size | Description |
|------|------|-------------|
| `NSFW_master_ZIT_000017532.safetensors` | ~593 MB | LoRA weights (zimage-turbo) |
