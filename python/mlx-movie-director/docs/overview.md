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
