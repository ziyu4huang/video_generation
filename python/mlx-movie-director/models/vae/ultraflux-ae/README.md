# `ultraflux-ae` — UltraFlux Improved AutoencoderKL

Drop-in replacement for `flux-ae` with improved sharpness. Same architecture (AutoencoderKL,
16-ch, `scaling_factor=0.3611`, `shift_factor=0.1159`) but retrained weights that produce
crisper edges and higher Laplacian variance on decode output.

Loaded via the PyTorch diffusers fallback path (`AutoencoderKL.from_pretrained`) — no MLX
conversion required. Decode is slightly slower than the MLX flux-ae (1.1–1.2s vs 0.8s).

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `diffusion_pytorch_model.safetensors` | ~320 MB | ✅ Yes — PyTorch FP32 weights |
| `config.json` | ~1 KB | ✅ Yes — VAE architecture config (from HuggingFace) |

## Source

- **HuggingFace**: [Owen777/UltraFlux-v1](https://huggingface.co/Owen777/UltraFlux-v1) — `vae/` subdirectory
- **CivitAI**: [UltraFlux VAE (model 2231253)](https://civitai.com/models/2231253)

## How to download

```bash
cd python/mlx-movie-director
../../ComfyUI/.venv/bin/python - <<'EOF'
from huggingface_hub import hf_hub_download
import os, shutil
os.makedirs("models/vae/ultraflux-ae", exist_ok=True)
for fname in ["config.json", "diffusion_pytorch_model.safetensors"]:
    src = hf_hub_download("Owen777/UltraFlux-v1", filename=f"vae/{fname}",
                          local_dir="/tmp/ultraflux_hf")
    shutil.copy(f"/tmp/ultraflux_hf/vae/{fname}", f"models/vae/ultraflux-ae/{fname}")
    print(f"Saved: models/vae/ultraflux-ae/{fname}")
EOF
```

## Runtime usage

Pass `--vae-path ultraflux` to any `run.py image` command:

```bash
/Users/huangziyu/proj/video_generation/python/venv/bin/python3 run.py image t2i \
  --prompt "photorealistic portrait, sharp eyes" \
  --vae-path ultraflux --seed 42
```

The short name `ultraflux` is resolved by `resolve_vae_path()` in `_shared.py` — it prefix-matches
against `models/vae/` subdirectories and expands to `models/vae/ultraflux-ae/`.

## A/B Test Results

Self-test: `run.py image quality --self-test --test-prompt portrait --seed 42`
Conditions: 640×960, 9 steps, seed=42, ZImage Moody V12.6 transformer.
Date: 2026-06-08.

| Metric | Default VAE (flux-ae) | UltraFlux VAE | Δ |
|---|---|---|---|
| Sharpness (Laplacian σ²) | 116.9 | **259.8** | **+122%** |
| Edge density (Sobel mean) | 20.4 | **29.0** | **+42%** |
| Contrast (luminance σ) | 60.2 | **60.9** | +1% |
| Noise (MAD σ) | **4.45** | 5.93 | +33% (worse) |
| Saturation σ | 40.0 | 42.3 | — |
| VAE decode time | 0.78s (MLX) | 1.10–1.23s (PyTorch) | +40–58% |

**Summary:** UltraFlux VAE delivers a 2.2× sharpness improvement and 42% more edge detail.
The tradeoff is a slight noise increase (+33% MAD σ) and a ~0.4s slower decode due to the
PyTorch fallback path (no MLX-native weights available).

## Key config values

- `latent_channels`: 16 (matches transformer `in_channels`)
- `scaling_factor`: 0.3611
- `shift_factor`: 0.1159
- `spatial_scale`: 8

## Known issues

The `config.json` contains EMA training fields that are not VAE architecture parameters.
`AutoencoderKL.from_pretrained` prints a harmless warning at load time:

```
The config attributes {'decay': 0.9999, 'inv_gamma': 1.0, 'min_decay': 0.0,
'optimization_step': 45531, 'power': 0.6666...} were passed to AutoencoderKL,
but are not expected and will be ignored.
```

This warning is safe to ignore — it does not affect inference.
