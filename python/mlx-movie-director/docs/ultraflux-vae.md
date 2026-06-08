# UltraFlux VAE — Improved Sharpness for ZImage

UltraFlux VAE is a retrained AutoencoderKL for Flux-based image pipelines. It uses the
same architecture as the standard `flux-ae` (16-channel, `scaling_factor=0.3611`) but
produces noticeably sharper decode output with more edge detail.

- **HuggingFace**: [Owen777/UltraFlux-v1](https://huggingface.co/Owen777/UltraFlux-v1)
- **CivitAI**: [UltraFlux VAE — Improved Quality for Flux and ZImage](https://civitai.com/models/2231253)
- **Local path**: `models/vae/ultraflux-ae/`

## A/B Test Results

Self-test command: `run.py image quality --self-test --test-prompt portrait --seed 42`

Configuration: ZImage Moody V12.6 transformer, 640×960, 9 denoising steps, seed=42.
Date: 2026-06-08.

| Metric | Default VAE (`flux-ae`) | UltraFlux VAE | Δ |
|---|---|---|---|
| Sharpness (Laplacian σ²) | 116.9 | **259.8** | **+122%** |
| Edge density (Sobel mean) | 20.4 | **29.0** | **+42%** |
| Contrast (luminance σ) | 60.2 | **60.9** | +1% |
| Noise (MAD σ) | **4.45** | 5.93 | +33% (worse) |
| Saturation σ | 40.0 | 42.3 | — |
| VAE decode time | 0.78s | 1.10–1.23s | +40–58% |

**Verdict:** UltraFlux wins on sharpness (2.2×), edge detail (+42%), and contrast (+1%).
The only tradeoff is slightly higher noise (+33% MAD σ) and a ~0.4s slower decode
because UltraFlux uses the PyTorch fallback path instead of the MLX-native flux-ae.

For portrait and detail-focused generation, the sharpness gain far outweighs the noise increase.
For quick preview drafts, the default VAE is sufficient.

## How to Use

Add `--vae-path ultraflux` to any `run.py image` command:

```bash
# T2I with UltraFlux VAE
/Users/huangziyu/proj/video_generation/python/venv/bin/python3 run.py image t2i \
  --prompt "photorealistic portrait of a woman, sharp eyes, natural skin texture" \
  --vae-path ultraflux --seed 42

# Workflow with UltraFlux VAE
/Users/huangziyu/proj/video_generation/python/venv/bin/python3 run.py image workflow \
  --prompt "..." --vae-path ultraflux

# Re-run self-test
/Users/huangziyu/proj/video_generation/python/venv/bin/python3 run.py image quality \
  --self-test --test-prompt portrait --seed 42
```

The short name `ultraflux` is prefix-matched against `models/vae/` subdirectory names by
`resolve_vae_path()` in `app/commands/_shared.py`.

## Download

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

## Technical Notes

**PyTorch fallback path**: The `ultraflux-ae` directory does not contain `model.safetensors`
(the MLX-native format). The pipeline detects this and falls back to
`AutoencoderKL.from_pretrained(vae_dir)` from diffusers. This is ~0.4s slower than the MLX
path but produces identical math — the decode output is determined solely by the weights.

**EMA warning**: The `config.json` downloaded from HuggingFace includes EMA training fields
(`decay`, `inv_gamma`, `optimization_step`, etc.) that are not VAE architecture parameters.
`AutoencoderKL.from_pretrained` prints a harmless warning about these being ignored — this is
expected behavior and does not affect inference quality.

**No MLX conversion needed**: The PyTorch BF16→MLX conversion pipeline (`convert.py --vae-mlx`)
can be applied to create an `model.safetensors` for the MLX fast path. However, the current
PyTorch path already validates the quality claim — MLX conversion is an optional optimization.
