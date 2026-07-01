# ltx-2.3-dev-q8 — LTX-2.3 22B Stage-1 Dev Transformer (int8)

HF repo: [`dgrauet/ltx-2.3-mlx-q8`](https://huggingface.co/dgrauet/ltx-2.3-mlx-q8)
Comparison guide: [DaSiWa | Major LTX23 Model Comparison Part 1](https://civitai.red/articles/29961/dasiwa-or-major-ltx23-model-comparison-part-1)

## Files

- `transformer-dev.safetensors` (~19.18 GB) — Stage-1 dev transformer weights (int8)
- `quantize_config.json` — quantization config
- `split_model.json` — shard config

## Performance — 10 s video (241 frames @ 704×448)

| Mode | stage1 | stage2 | Est. time |
|------|--------|--------|-----------|
| Default (T2V/I2V) | 8 | 3 | **~6 min** |
| FLF2V | 20 | 3 | **~13 min** |
| `--hq` | 20 | 5 | **~26 min** |

Common frame counts: 97 (4s), 121 (5s), 241 (10s), 361 (15s) — all 8n+1.

## Usage

```bash
# T2V (text-to-video)
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --prompt "..." \
    --frames 241 --fps 24 --width 704 --height 448

# I2V (image-to-video) — --transformer dev can be omitted (dev is the default)
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --image input.png --prompt "..." \
    --frames 241 --fps 24 --width 704 --height 448

# FLF2V (begin + end keyframe interpolation)
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --image begin.png --begin-image end.png \
    --prompt "..." --frames 241
```

## Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `--stage1-steps` | 8 | T2V/I2V default; 20 for FLF2V; 30 for max quality |
| `--stage2-steps` | 3 | standard; keep as-is |
| `--cfg-scale` | 5.0 | T2V/I2V; auto-set to 3.0 for FLF2V (softer guidance) |
| `--stg-scale` | 1.0 | spatial-temporal guidance; 0.0 disables |
| `--fps` | 24 | training standard |
| `--width` | 704 | balanced quality / speed |
| `--height` | 448 | balanced quality / speed |

Higher resolutions (e.g. 768×512) are supported but require more RAM and slow down generation.
`--hq` uses res_2s second-order sampler (~2× slower per step); auto-sets stage1_steps=20.

## CFG / STG Notes

- `cfg_scale` controls text guidance only — does not affect keyframe enforcement (FLF2V) or image conditioning (I2V).
- `stg_scale` applies spatial-temporal guidance; 1.0 is a good default, 0.0 disables it.
- FLF2V: auto-set to `cfg_scale=3.0` (softer guidance → smoother interpolation between keyframes).

## Audio

dev has the original unmodified audio stream — native zh/en speech support without any
transplant. Use zh-TW prompts for Chinese speech; no `--dev-audio` needed.

## Download

```bash
python python/mlx-movie-director/app/ltx_downloader.py --component transformer
```

Or let `run.py video` auto-download on first run.
