# ltx-2.3-distilled-q8 — LTX-2.3 22B Distilled Transformer v1.1 (int8)

Knowledge-distilled version of LTX-2.3 22B for fast video generation.

HF repo: [`dgrauet/ltx-2.3-mlx-q8`](https://huggingface.co/dgrauet/ltx-2.3-mlx-q8)
Comparison guide: [DaSiWa | Major LTX23 Model Comparison Part 1](https://civitai.red/articles/29961/dasiwa-or-major-ltx23-model-comparison-part-1)

## Files

- `transformer-distilled-1.1.safetensors` (~19 GB) — distilled transformer weights (int8)
- `quantize_config.json` — quantization config
- `split_model.json` — shard config

## Usage

```bash
# Shorthand — auto-sets stage1_steps=8 and cfg_scale=1.0
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --distilled --prompt "..." \
    --frames 97 --fps 24 --width 704 --height 448

# Explicit form (equivalent)
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --transformer distilled --prompt "..." \
    --stage1-steps 8 --cfg-scale 1.0 --stg-scale 0.0 \
    --frames 97 --fps 24 --width 704 --height 448
```

## Recommended Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `--stage1-steps` | 8 | predefined sigma schedule; more steps don't help |
| `--stage2-steps` | 3 | default; keep as-is |
| `--cfg-scale` | 1.0 | no classifier-free guidance needed (distilled) |
| `--stg-scale` | 0.0 | STG not needed for distilled; set to 0 |
| `--frames` | 97 | 4 s at 24 fps (must be 8k+1) |
| `--fps` | 24 | training standard |
| `--width` | 704 | or higher — distilled tolerates 720×1280 well |
| `--height` | 448 | |

## Key Differences vs Dev

- **Speed**: 3–4× faster (fewer steps, no CFG/STG overhead)
- **Quality**: Slightly lower than dev — good for drafts and iteration
- **No LoRA support**: distilled transformer is a standalone checkpoint (incompatible with distilled LoRA stage)
- **No STG/CFG needed**: distilled was trained to generate in one pass without guidance amplification

## Notes

- The `--distilled` flag is shorthand — it sets `--transformer distilled --stage1-steps 8 --cfg-scale 1.0` automatically.
- Do NOT mix with `lora/ltx-2.3-distilled` — that LoRA is for the dev transformer, not this distilled checkpoint.
