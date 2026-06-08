# mlx-movie-director — Overview

Native MLX inference toolkit on Apple Silicon with three pipelines:

| Pipeline | Model | Purpose | Command |
|----------|-------|---------|---------|
| **Z-Image Turbo** (Moody V12.6) | Pre-converted 4-bit, local `models/` | Text-to-image, img2img, upscale | `run.py generate` |
| **Flux2 Klein 9B** | Pre-converted INT8, local `models/` | Character profile sheets with reference conditioning | `run.py profile` |
| **LTX-2.3 Video** (22B) | Pre-converted Q8 + vendored submodule | Text/image/audio-to-video with joint audio | `run.py video generate` |

## What Works (Verified 2026-06-07)

| Feature | Pipeline | Status |
|---------|----------|--------|
| Text-to-image (640×960, 9 steps) | Z-Image | ✅ Working |
| 4-bit MLX quantization (transformer + text encoder) | Z-Image | ✅ Pre-converted on disk |
| On-the-fly BF16→INT8 quantization | Klein | ✅ `--quantize 8` |
| Reference image conditioning (profile sheets) | Klein | ✅ Working |
| Chain reference (front → back/side) | Klein | ✅ `--chain-ref` (default) |
| VLM auto-caption (Qwen3-VL via LM Studio) | Klein | ✅ `--vlm` (default) |
| FlowMatch Euler scheduler with dynamic time-shifting | Z-Image | ✅ Working |
| VAE decode via diffusers AutoencoderKL on MPS | Both | ✅ Working |
| LoRA loading (zit_sda_v1) | Z-Image | ✅ Working |
| ESRGAN / SeedVR2 upscale | Z-Image | ✅ Working |
| No-reference image quality analysis (7 metrics) | Z-Image | ✅ `run.py image quality` |
| LoRA A/B review with quality metrics + voting | Z-Image | ✅ `run.py image --self-test sda` |
| VAE A/B review with quality metrics | Z-Image | ✅ `run.py image --self-test ultraflux` |
| HTML viewer output | Both | ✅ Self-contained HTML per run |
| Speed: ~7s/step (INT8, 1024×1536) | Klein | ✅ Measured |
| Speed: ~1.2 s/step, ~14s total for 9 steps | Z-Image | ✅ Measured |

## Quick Start

```bash
cd /Users/huangziyu/proj/video_generation

# --- Z-Image Turbo (text-to-image) ---
# First time — convert models (one-time, ~20 min total)
./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
./python/venv/bin/python python/mlx-movie-director/convert.py --vae
./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
./python/venv/bin/python python/mlx-movie-director/convert.py --transformer

# Inference (matches moody flow JSON base stage)
/Users/huangziyu/.local/bin/python3.13 python/mlx-movie-director/run.py generate \
  --prompt "cinematic portrait photo, beautiful woman, moody dramatic lighting, photorealistic" \
  --width 640 --height 960 --steps 9 --seed 42

# With LoRA (zit diversity adapter)
/Users/huangziyu/.local/bin/python3.13 python/mlx-movie-director/run.py generate \
  --prompt "..." --width 640 --height 960 --steps 9 --seed 42 \
  --lora-path comfyui_data/models/loras/zit_sda_v1.safetensors \
  --lora-scale 1.0

# --- Flux2 Klein (character profile sheets) ---
# Model auto-downloads from HuggingFace on first run (~32 GB)
/Users/huangziyu/.local/bin/python3.13 python/mlx-movie-director/run.py profile \
  --input-image /path/to/character.png \
  --quantize 8 --ratio standing

# Output: output/profile_YYYYMMDD_HHMMSS/{front.png, back.png, side.png, index.html}
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

### Actions (Sub-commands)

| Command | Description |
|---------|-------------|
| `run.py generate` | Text-to-image, img2img, batch (Z-Image Turbo) |
| `run.py image quality` | No-reference image quality analysis (7 metrics) |
| `run.py image review lora` | LoRA A/B test with quality metrics + HTML voting |
| `run.py image review vae` | VAE A/B comparison with quality metrics |
| `run.py image --self-test <id>` | Named self-tests (sda, sda-fullbody, ultraflux, etc.) |
| `run.py profile` | Multi-view character profile sheet (Flux2 Klein) |
| `run.py video generate` | Text/image/audio-to-video with audio (LTX-2.3) |
| `run.py video review` | A/B variation review gallery |
| `run.py upscale` | ESRGAN / SeedVR2 upscale |
| `run.py caption` | VLM image captioning (Qwen3-VL via LM Studio) |
| `run.py replay` | Reproduce a previous run from `.run.json` |

## Python Environment

mlx-movie-director uses Python 3.13 via `uv`:

```bash
/Users/huangziyu/.local/bin/python3.13 ...
# NOT: python3 (system 3.9), ComfyUI/.venv/bin/python (separate venv for ComfyUI)
```

## Model Sizes

### Z-Image Turbo (pre-converted on disk)

| Model | Source | Converted |
|-------|--------|-----------|
| Transformer (Moody V12.6) | ~11 GB (.safetensors) | ~3.6 GB (4-bit MLX) |
| Text Encoder (Qwen3-4B) | ~7.5 GB (.safetensors) | ~2.3 GB (4-bit MLX) |
| Tokenizer | — | ~7 MB (HF download) |
| VAE | — | ~160 MB (HF download) |

### Flux2 Klein 9B (on-the-fly quantization)

| Component | Disk (BF16) | Memory (INT8) |
|-----------|-------------|---------------|
| Transformer | 16.9 GB | ~8.5 GB |
| Text Encoder | 15.3 GB | ~7.6 GB |
| VAE | 160 MB | 160 MB (not quantized) |
| Tokenizer | 15 MB | 15 MB |
| **Total** | **~32 GB** | **~16 GB** |

## Output

- **generate**: `output/output_YYYYMMDD_HHMMSS.png`
- **profile**: `output/profile_YYYYMMDD_HHMMSS/{front.png, back.png, side.png, index.html, run.json, manifest.json}`
- **upscale**: `output/upscale_YYYYMMDD_HHMMSS.png`
- **caption**: `<image>.caption.json` alongside the input image
