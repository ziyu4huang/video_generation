# ltx-2.3-dasiwa-golden-lace-v3-q8 — DaSiWa Golden Lace V3 (int8)

LTX-2.3 dev-architecture finetune by DaSiWa (darksidewalker). Tuned for stylistic video generation.

Source: [Civitai 2543443/2967331](https://civitai.com/models/2543443)
HF mirror: [`darksidewalker/DaSiWa-LTX2.3`](https://huggingface.co/darksidewalker/DaSiWa-LTX2.3)
Comparison guide: [DaSiWa | Major LTX23 Model Comparison Part 1](https://civitai.red/articles/29961/dasiwa-or-major-ltx23-model-comparison-part-1)

## Files

- `transformer-dev.safetensors` (~19 GB) — DaSiWa finetune weights (int8, in dev-architecture slot)
- `quantize_config.json` — quantization config
- `split_model.json` — shard config

## Conversion

Converted from `DasiwaLTX23_goldenLaceV3.safetensors` (baseModel: LTXV 2.3, BF16 safetensors):

```bash
python/venv/bin/python python/mlx-movie-director/convert.py --ltx-checkpoint DasiwaLTX23_goldenLaceV3.safetensors
```

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --transformer dasiwa --prompt "..." \
    --stage1-steps 30 --cfg-scale 5.0 --stg-scale 1.0 \
    --frames 97 --fps 24 --width 704 --height 448
```

## Recommended Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `--stage1-steps` | 30 | same as dev; 20 for faster |
| `--stage2-steps` | 3 | default; keep as-is |
| `--cfg-scale` | 5.0 | T2V / I2V; use 3.0 for FLF2V |
| `--stg-scale` | 1.0 | spatial-temporal guidance |
| `--frames` | 97 | 4 s at 24 fps (must be 8k+1) |
| `--fps` | 24 | training standard |
| `--width` | 704 | |
| `--height` | 448 | |

LoRA strength: most LoRAs work at 0.3–1.2; start at 0.3. Compatible with `lora/ltx-2.3-distilled`.

## Key Notes

- **Dev-architecture finetune**: uses the same architecture as the dev transformer, loaded in the dev slot.
- **Not a distilled model**: requires full dev-model step counts and CFG; `--distilled` flag is NOT compatible.
- **LoRA compatible**: accepts LTX-2.3 LoRAs (including the distilled LoRA used for the dev pipeline).
- **LTX-2.3 stability caveat**: LTX23 outputs are sensitive to workflow settings; results vary significantly with prompt quality and parameter tuning. See comparison guide for per-model behavior differences.
