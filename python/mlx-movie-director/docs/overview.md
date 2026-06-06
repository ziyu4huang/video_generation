# mlx-movie-director — Overview

Native MLX inference pipeline for **Z-Image Turbo** (Moody V12.6) on Apple Silicon.
Replicates the base text-to-image stage of the ComfyUI `moody-zimage-v7.5.json` workflow
without ComfyUI, running fully on MPS via MLX + diffusers VAE.

## What Works (Verified 2026-06-06)

| Feature | Status |
|---------|--------|
| Text-to-image (640×960, 9 steps) | ✅ Working |
| 4-bit MLX quantization (transformer + text encoder) | ✅ Working |
| FlowMatch Euler scheduler with dynamic time-shifting | ✅ Working |
| VAE decode via diffusers AutoencoderKL on MPS | ✅ Working |
| LoRA loading (zit_sda_v1) | ✅ Working |
| Speed: ~1.2 s/step, ~14s total for 9 steps | ✅ Measured |

## Quick Start

```bash
cd /Users/huangziyu/proj/video_generation

# First time — convert models (one-time, ~20 min total)
./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
./python/venv/bin/python python/mlx-movie-director/convert.py --vae
./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
./python/venv/bin/python python/mlx-movie-director/convert.py --transformer

# Inference (matches moody flow JSON base stage)
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "cinematic portrait photo, beautiful woman, moody dramatic lighting, photorealistic" \
  --width 640 --height 960 --steps 9 --seed 42

# With LoRA (zit diversity adapter)
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "..." --width 640 --height 960 --steps 9 --seed 42 \
  --lora-path comfyui_data/models/loras/zit_sda_v1.safetensors \
  --lora-scale 1.0
```

## Run Config & Manifest

Every run produces three files with a shared base name:

```
output/output_20260606_220112.png          # generated image
output/output_20260606_220112.run.json     # full run configuration
output/output_20260606_220112.manifest.json # timing, memory, results
```

### `.run.json` — Run Configuration

Captures all parameters (including defaults) before execution. Schema versioned for forward compatibility.

```json
{
  "schema_version": 1,
  "action": "text2img",
  "prompt": "cinematic portrait photo",
  "prompt_file": null,
  "width": 640,
  "height": 960,
  "steps": 9,
  "seed": 42,
  "lora_path": null,
  "lora_scale": 1.0
}
```

### `.manifest.json` — Post-Run Metrics

Written after execution (success or error). Contains phase-level timing, peak memory, output file info, or error details.

```json
{
  "run_file": "output_20260606_220112.run.json",
  "status": "success",
  "start_time": "2026-06-06T22:01:12.345678+00:00",
  "end_time": "2026-06-06T22:01:26.789012+00:00",
  "elapsed_seconds": 14.44,
  "memory_peak_mb": 8234.5,
  "timings": {
    "text_encoding_seconds": 3.12,
    "transformer_load_seconds": 2.87,
    "lora_apply_seconds": 0.0,
    "denoising_seconds": 7.20,
    "denoising_step_times": [0.82, 0.79, 0.80, 0.81, 0.79, 0.80, 0.81, 0.79, 0.79],
    "vae_decode_seconds": 1.01
  },
  "output_files": [{ "path": "output_20260606_220112.png", "size_bytes": 774464, "width": 640, "height": 960 }],
  "error": null
}
```

### Replay

Reproduce any previous run with identical parameters:

```bash
./python/venv/bin/python python/mlx-movie-director/run.py \
  --replay output/output_20260606_220112.run.json
```

Replay generates a **new** output with a fresh timestamp (original is preserved). Same seed → same image.

### Actions

| Action | Description |
|--------|-------------|
| `text2img` | Text-to-image generation (default) |
| *(future)* `img2img` | Image-to-image transformation |
| *(future)* `batch` | Batch generation from prompt list |
| *(future)* `variation` | Generate variations of an existing image |

## Python Environment

Always use `python/venv/` (Python 3.13, has mlx, diffusers, transformers):

```bash
./python/venv/bin/python ...
# NOT: python3, python3.13, ComfyUI/.venv/bin/python
```

## Model Sizes After Conversion

| Model | Source | Converted |
|-------|--------|-----------|
| Transformer (Moody V12.6) | ~11 GB (.safetensors) | ~3.6 GB (4-bit MLX) |
| Text Encoder (Qwen3-4B) | ~7.5 GB (.safetensors) | ~2.3 GB (4-bit MLX) |
| Tokenizer | — | ~7 MB (HF download) |
| VAE | — | ~160 MB (HF download) |

## Source Model Paths

```
comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors
comfyui_data/models/text_encoders/qwen_3_4b.safetensors
comfyui_data/models/loras/zit_sda_v1.safetensors
```

## Output

Images saved to `python/mlx-movie-director/output/output_YYYYMMDD_HHMMSS.png`.
