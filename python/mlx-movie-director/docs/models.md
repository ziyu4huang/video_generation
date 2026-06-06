# Models Reference

All model paths and defaults are configured in [`app/config.py`](../app/config.py). This document explains where each model lives, where it comes from, and how to reproduce it.

## Directory Layout

```
python/mlx-movie-director/models/
├── transformer/         # Z-Image Moody V12.6 (4-bit MLX)
│   ├── config.json
│   ├── model.safetensors        (~3.6 GB)
│   └── README.md
├── text_encoder/        # Qwen3-4B (4-bit MLX)
│   ├── config.json
│   ├── model.safetensors        (~2.3 GB)
│   └── README.md
├── tokenizer/           # Qwen2.5 BPE tokenizer
│   ├── tokenizer.json           (~11 MB, fast tokenizer)
│   ├── tokenizer_config.json
│   ├── tmp/                     # slow tokenizer fallback (not needed at runtime)
│   └── README.md
├── vae/                 # AutoencoderKL (Flux/Z-Image)
│   ├── config.json
│   ├── diffusion_pytorch_model.safetensors  (~160 MB)
│   └── README.md
└── lora/                # LoRA adapters (optional, applied at runtime)
    ├── zit_sda_v1.safetensors   (~162 MB)
    └── README.md
```

## Source → Converted Mapping

| Component | Source (ComfyUI) | Converted (MLX) | How |
|-----------|-----------------|-----------------|-----|
| **Transformer** | `comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors` (~11 GB) | `models/transformer/model.safetensors` (~3.6 GB) | `convert.py --transformer` — key remap + 4-bit quantize |
| **Text Encoder** | `comfyui_data/models/text_encoders/qwen_3_4b.safetensors` (~7.5 GB) | `models/text_encoder/model.safetensors` (~2.3 GB) | `convert.py --text-encoder` — 4-bit quantize |
| **Tokenizer** | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) HuggingFace | `models/tokenizer/` (~7 MB) | `convert.py --tokenizer` — download |
| **VAE** | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) HuggingFace | `models/vae/` (~160 MB) | `convert.py --vae` — download |
| **LoRA** | `comfyui_data/models/loras/zit_sda_v1.safetensors` (~162 MB) | Used directly (no conversion needed) | Runtime in-memory PyTorch → MLX |
| **Upscale** | `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` (~28 MB) | Used directly (PyTorch MPS) | No conversion — spandrel loads .pth on MPS |

## Defaults in Code

### `app/config.py` — Paths

```python
SRC_TRANSFORMER    = comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors
SRC_TEXT_ENCODER   = comfyui_data/models/text_encoders/qwen_3_4b.safetensors
TRANSFORMER_DIR    = models/transformer/
TEXT_ENCODER_DIR   = models/text_encoder/
TOKENIZER_DIR      = models/tokenizer/
VAE_DIR            = models/vae/
```

### `run.py` — CLI Defaults

| Flag | Default | Source |
|------|---------|--------|
| `--lora-path` | None (no LoRA) | `models/lora/zit_sda_v1.safetensors` if used |
| `--upscale-model` | `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` | `DEFAULT_UPSCALE_MODEL` in `run.py` |

### `app/config.py` — Architecture Configs

**Transformer** (`TRANSFORMER_CONFIG`):

| Param | Value |
|-------|-------|
| dim | 3840 |
| in_channels | 16 |
| n_layers | 30 |
| n_refiner_layers | 2 |
| n_heads / n_kv_heads | 30 |
| cap_feat_dim | 2560 |
| rope_theta | 256.0 |
| t_scale | 1000.0 |

**Text Encoder** (`TEXT_ENCODER_CONFIG`):

| Param | Value |
|-------|-------|
| hidden_size | 2560 |
| intermediate_size | 9728 |
| num_attention_heads | 32 |
| num_key_value_heads | 8 (GQA) |
| num_hidden_layers | 36 |
| head_dim | 128 |
| vocab_size | 151,936 |

## Reproduce All Models

```bash
# One-time conversion (order matters: tokenizer/vae first, then heavy conversions)
./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
./python/venv/bin/python python/mlx-movie-director/convert.py --vae
./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
./python/venv/bin/python python/mlx-movie-director/convert.py --transformer

# LoRA — copy from ComfyUI (no conversion needed)
cp comfyui_data/models/loras/zit_sda_v1.safetensors python/mlx-movie-director/models/lora/
```

## External Sources

| Model | HuggingFace | Notes |
|-------|-------------|-------|
| Z-Image Turbo | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | Tokenizer + VAE + architecture reference |
| Qwen3-4B | [Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B) | Text encoder (used as ComfyUI checkpoint) |
| Moody V12.6 DPO | Community fine-tune on ComfyUI | Transformer base model |
| 4xNomosWebPhoto | [NomosWebPhoto_RealPLKSR](https://openmodeldb.info/models/4xNomosWebPhoto_RealPLKSR) | ESRGAN upscaler |
