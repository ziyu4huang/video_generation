# KleiNova NSFW v3.0

Fine-tuned Flux2 Klein 9B checkpoint for NSFW generation and editing (latest release).
Converted from CivitAI BF16/FP8 to MLX INT8 (group_size=64), merged with base klein-9b weights.

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline flux2-klein --transformer kleinova-nsfw-v3 \
  --prompt "..." --steps 20 --cfg-scale 3.5
```

## Source

- Model: [KleiNova NSFW Generation & Edit](https://civitai.com/models/2547526?modelVersionId=3054027)
- Version: 3.0 BF16/FP8
- Architecture: Flux2 Klein 9B (partial fine-tune, merged with base)

## Conversion notes

Converted via `convert.py --klein-9b-checkpoint`. The `final_layer.adaLN_modulation.1.weight`
from the ComfyUI checkpoint is intentionally **not used** — it is statistically uncorrelated
(r ≈ −0.002) with the HuggingFace `norm_out.linear.weight` and causes a severe burlap/canvas
texture when combined with mflux block weights. The base klein-9b `norm_out.linear.weight` is
preserved instead. See `project_klein9b_normlayer_fix.md` in memory for the full ablation study.

First converted: 2026-06-21.
