# ltx-2.3-dev-q8 — LTX-2.3 22B Stage-1 Dev Transformer (int8)

HF repo: [`dgrauet/ltx-2.3-mlx-q8`](https://huggingface.co/dgrauet/ltx-2.3-mlx-q8)
Comparison guide: [DaSiWa | Major LTX23 Model Comparison Part 1](https://civitai.red/articles/29961/dasiwa-or-major-ltx23-model-comparison-part-1)

## Files

- `transformer-dev.safetensors` (~19.18 GB) — Stage-1 dev transformer weights (int8)
- `quantize_config.json` — quantization config
- `split_model.json` — shard config

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --prompt "..." \
    --stage1-steps 30 --cfg-scale 5.0 --stg-scale 1.0 \
    --frames 97 --fps 24 --width 704 --height 448
```

`--transformer dev` can be omitted (dev is the default).

## Recommended Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `--stage1-steps` | 30 | 20 for faster / 8 for quick draft |
| `--stage2-steps` | 3 | default; keep as-is |
| `--cfg-scale` | 5.0 | T2V / I2V; use 3.0 for FLF2V |
| `--stg-scale` | 1.0 | spatial-temporal guidance |
| `--frames` | 97 | 4 s at 24 fps (must be 8k+1) |
| `--fps` | 24 | training standard |
| `--width` | 704 | balanced quality / speed |
| `--height` | 448 | balanced quality / speed |

Higher resolutions (e.g. 768×512) are supported but require more RAM and slow down generation.
`--hq` mode uses res_2s second-order sampler for better quality (~2× slower); default stage1_steps becomes 15.

## CFG / STG Notes

- `cfg_scale` controls text guidance only — does not affect keyframe enforcement (FLF2V) or image conditioning (I2V).
- `stg_scale` applies spatial-temporal guidance; 1.0 is a good default, 0.0 disables it.
- FLF2V: use `--cfg-scale 3.0` (softer guidance → smoother interpolation between keyframes).

## Download

```bash
python python/mlx-movie-director/app/ltx_downloader.py --component transformer
```

Or let `run.py video` auto-download on first run.
