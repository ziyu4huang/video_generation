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

## Performance — 10 s video (241 frames @ 704×448)

| Mode | stage1 | stage2 | Est. time | Sharpness |
|------|--------|--------|-----------|-----------|
| Default (no `--hq`) | 8 | 3 | **~4.5 min** | 850–970 ✓ |
| `--hq` (res_2s sampler) | 20 | 5 | **~20 min** | 165–279 |

Counter-intuitively, no-HQ produces higher sharpness — res_2s smooths edges in favour of
temporal coherence. Use `--hq` only when smooth camera motion matters more than per-frame detail.

Common frame counts: 97 (4s), 121 (5s), 241 (10s), 361 (15s) — all 8n+1.

## Usage

```bash
# Standard I2V via t2i2v pipeline (recommended — auto T2I + VLM expansion)
python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
    --prompt "一位女性站在花園中" \
    --action "她微笑走向鏡頭，輕聲說「你來了」" \
    --transformer dasiwa --dev-audio \
    --frames 241 --width 704 --height 448

# Direct I2V generation
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --transformer dasiwa --dev-audio \
    --image input.png \
    --prompt "..." \
    --frames 241 --fps 24 --width 704 --height 448

# HQ mode (~20 min, smoother motion)
python/venv/bin/python python/mlx-movie-director/run.py video generate \
    --transformer dasiwa --dev-audio --hq \
    --image input.png --prompt "..." --frames 241
```

## A/B-Verified Default Parameters

These are auto-applied by `run.py` when `--transformer dasiwa` is used — no need to pass explicitly.

| Parameter | Default | Reason |
|-----------|---------|--------|
| `--stage1-steps` | 8 | A/B sweep 2026-06-23 (21 cells × 3 seeds): 8 steps ≡ 16 steps in zh speech quality. `--hq` uses 20. |
| `--stage2-steps` | 3 | Standard sampler default. `--hq` uses 5 (res_2s A/B-optimum). |
| `--cfg-scale` | 5.0 | A/B-optimum for text guidance (T2V/I2V) |
| `--stg-scale` | 1.5 | A/B-optimum: 7.61 vs 7.03@2.0, 6.39@1.0 |
| `--audio-modality-scale` | 5.0 | A/B-optimum: composite 63.93 vs 62.98 @3.0 (default) |
| `--fps` | 24 | training standard |
| `--width` | 704 | balanced quality / speed |
| `--height` | 448 | balanced quality / speed |

LoRA strength: 0.3–1.2; start at 0.3. Compatible with `lora/ltx-2.3-distilled`.

## Key Notes

- **Dev-architecture finetune**: uses the same architecture as the dev transformer, loaded in the dev slot.
- **Not a distilled model**: requires full dev-model step counts and CFG; `--distilled` flag is NOT compatible.
- **LoRA compatible**: accepts LTX-2.3 LoRAs (including the distilled LoRA used for the dev pipeline).
- **LTX-2.3 stability caveat**: LTX23 outputs are sensitive to workflow settings; results vary significantly with prompt quality and parameter tuning. See comparison guide for per-model behavior differences.

## Audio — `--dev-audio` Required for zh Speech

The dasiwa finetuning disrupted the AV cross-attention weights. zh-TW prompts produce
Japanese-sounding audio unless the dev audio stream is transplanted at load time.

| Condition | Whisper | Result |
|-----------|---------|--------|
| dasiwa (no `--dev-audio`) | `ja` ✗ | "二層陣内路" / "2丁変な色" |
| distilled (no `--dev-audio`) | `ja` ✗ | "二層獣雷霊" |
| dasiwa + `--dev-audio` + zh prompt | `zh` ✓ | correct Mandarin |
| dasiwa + `--dev-audio` + English prompt | `ja` ✗ | LoRA audio delta dominates |

**Fix**: always pass `--dev-audio` with zh-TW speech content. The transplant replaces 4775
audio-stream keys from `ltx-2.3-dev-q8/transformer-dev.safetensors` at load time — no speed
penalty (one-time weight copy before inference).

Use `--dev-audio-path PATH` to override the audio source (e.g. point to the distilled
safetensors — confirmed equivalent since both derive from the same dev base).
