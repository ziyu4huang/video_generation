#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
"""
dump_vae_reference.py — Phase 4 verification scaffold.

Dumps a fixed latent + the Python VAE decoder's output so the Swift port
(`ZImageVAEDecoder`) can be compared numerically.

Run from repo root:
  python/venv/bin/python swift/z-image-director/scripts/dump_vae_reference.py
"""

import os, sys
import mlx.core as mx
import numpy as np

sys.path.insert(0, "python/mlx-movie-director")
from app.pipeline import _load_mlx_vae, _vae_mlx_available, cfg

OUT_DIR = os.path.join("swift", "z-image-director", ".scratch", "ref")
os.makedirs(OUT_DIR, exist_ok=True)

VAE_DIR = os.environ.get("VAE_DIR", cfg.VAE_DIR)
print(f"[vae] {VAE_DIR}  available={_vae_mlx_available(VAE_DIR)}")
vae = _load_mlx_vae(VAE_DIR)

# Fixed small latent: (1, 16, 4, 4) → decodes to ~32×32 pixels.
np.random.seed(42)
latents = mx.array(np.random.randn(1, 16, 4, 4).astype(np.float32))

# Python decode path (matches pipeline.py lines ~730-740).
decoded = vae.decode(latents.astype(mx.bfloat16))  # (1, C, 1, H, W)
if decoded.ndim == 5:
    decoded = decoded[:, :, 0, :, :]
# pixel post-process: clip(/2 + 0.5, 0, 1)
image_np = np.array(mx.clip(decoded.astype(mx.float32) / 2.0 + 0.5, 0, 1))

mx.save_safetensors(
    os.path.join(OUT_DIR, "ref_vae.safetensors"),
    {
        "latents": latents,
        "decoded_raw": decoded.astype(mx.float32),  # raw VAE output (1,3,H,W)
        "decoded_image": mx.array(image_np),  # post clip/shift (1,3,H,W)
    },
)
print(f"[dump] {OUT_DIR}/ref_vae.safetensors")
print(
    f"  latents {latents.shape} → decoded_raw {decoded.shape} → image {image_np.shape}"
)
print("[done]")
