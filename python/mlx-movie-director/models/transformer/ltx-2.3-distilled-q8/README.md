# ltx-2.3-distilled-q8 — LTX-2.3 22B Distilled Transformer v1.1 (int8)

Knowledge-distilled version of LTX-2.3 22B for fast video generation.

HF repo: [`dgrauet/ltx-2.3-mlx-q8`](https://huggingface.co/dgrauet/ltx-2.3-mlx-q8)
Comparison guide: [DaSiWa | Major LTX23 Model Comparison Part 1](https://civitai.red/articles/29961/dasiwa-or-major-ltx23-model-comparison-part-1)

## Files

- `transformer-distilled-1.1.safetensors` (~19 GB) — distilled transformer weights (int8)
- `quantize_config.json` — quantization config
- `split_model.json` — shard config

## Performance — 10 s video (241 frames @ 704×448)

| Mode | stage1 | stage2 | Est. time |
|------|--------|--------|-----------|
| Default | 8 | 3 | **~5 min** |

Note: `--hq` is incompatible with `--distilled` (mutually exclusive).

Common frame counts: 97 (4s), 121 (5s), 241 (10s), 361 (15s) — all 8n+1.

## Usage

```bash
# Shorthand — auto-sets stage1_steps=8 and cfg_scale=1.0
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --distilled --prompt "..." \
    --frames 241 --fps 24 --width 704 --height 448

# Explicit form (equivalent)
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --transformer distilled --prompt "..." \
    --frames 241 --fps 24 --width 704 --height 448
```

## Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `--stage1-steps` | 8 | predefined sigma schedule; more steps don't help |
| `--stage2-steps` | 3 | standard; keep as-is |
| `--cfg-scale` | 1.0 | no CFG needed (distilled) |
| `--stg-scale` | 0.0 | STG disabled in distilled mode |
| `--fps` | 24 | training standard |
| `--width` | 704 | or higher — distilled tolerates 720×1280 well |
| `--height` | 448 | |

## Key Differences vs Dev

- **Speed**: ~17% faster per step (smaller per-step compute), same step count → ~5 min vs ~6 min
- **Quality**: Slightly lower than dev — good for drafts and iteration
- **No CFG/STG overhead**: distilled was trained to generate in one pass without guidance amplification

## Notes

- The `--distilled` flag is shorthand — it sets `--transformer distilled --stage1-steps 8 --cfg-scale 1.0` automatically.
- Do NOT mix with `lora/ltx-2.3-distilled` — that LoRA is for the dev transformer, not this distilled checkpoint.

## Audio — `--dev-audio` Recommended for zh Speech

The distillation finetuning disrupted AV cross-attention weights. zh-TW prompts produce
Japanese-sounding audio by default (Whisper detects `ja`).

**Fix**: pass `--dev-audio` to transplant the dev audio stream (4775 keys) at load time.
With a zh-TW prompt, this restores correct Mandarin speech — confirmed equivalent to dev audio
(both derived from the same base weights before distillation).

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --distilled --dev-audio \
    --prompt "她說「你終於來了，我等你好久了」" \
    --frames 241
```

For video-only generation (no speech in prompt), distilled works well without `--dev-audio`.
