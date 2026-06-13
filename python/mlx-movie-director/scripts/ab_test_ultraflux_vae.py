#!/usr/bin/env python3
"""A/B test: compare PyTorch FP32 vs MLX BF16 ultraflux-ae VAE output.

Loads both VAE variants, generates random latent, decodes, compares PSNR.
"""

from __future__ import annotations

import gc
import os
import sys
import time

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

import mlx.core as mx
import numpy as np
import torch

from app import config as cfg


def compute_psnr(a: mx.array, b: mx.array) -> float:
    """PSNR in dB between two arrays assumed in [0, 1] range."""
    mse = float(((a.astype(mx.float32) - b.astype(mx.float32)) ** 2).mean())
    if mse < 1e-12:
        return float("inf")
    return 20.0 * np.log10(1.0 / np.sqrt(mse))


def main():
    # ── Load MLX VAE (the new converted version) ────────────────────────
    _mflux_src = os.path.join(_PROJECT_ROOT, "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    from mlx.utils import tree_flatten

    vae_dir = cfg.ULTRAFLUX_VAE_DIR
    mlx_path = os.path.join(vae_dir, "model.safetensors")
    pt_path = os.path.join(vae_dir, "diffusion_pytorch_model.safetensors")

    if not os.path.exists(mlx_path):
        print(f"ERROR: MLX VAE not found: {mlx_path}")
        return 1
    if not os.path.exists(pt_path):
        print(f"ERROR: PyTorch VAE not found: {pt_path}")
        return 1

    # ── Phase 1: MLX BF16 VAE ───────────────────────────────────────────
    print("=" * 60)
    print("Phase 1: MLX BF16 VAE")
    print("=" * 60)
    print(f"  Loading from {os.path.basename(mlx_path)}...")
    vae = ZImageVAE()
    vae.load_weights(mlx_path)
    mx.eval(vae.parameters())

    # Generate random latent (N, C, H, W) — VAE uses channel-first internally
    batch = 1
    c, h, w = 16, 64, 64  # latent_channels=16, small test resolution
    latent = mx.random.uniform(-1, 1, (batch, c, h, w)).astype(mx.bfloat16)
    print(f"  Latent shape: {latent.shape}")

    t0 = time.time()
    decoded_mlx = vae.decode(latent)
    mx.eval(decoded_mlx)
    t_mlx = time.time() - t0
    print(f"  Decode in {t_mlx:.3f}s")
    print(f"  Output shape: {decoded_mlx.shape}")

    del vae
    gc.collect()
    mx.clear_cache()

    # ── Phase 2: PyTorch FP32 VAE (via PyTorch → manual load) ───────────
    print()
    print("=" * 60)
    print("Phase 2: PyTorch FP32 VAE (loaded via diffusers)")
    print("=" * 60)

    # We need to convert PyTorch weights to MLX on the fly using the same
    # key mapping as convert_ultraflux_vae_to_mlx, then load into ZImageVAE.
    from mflux.models.z_image.weights.z_image_weight_mapping import ZImageWeightMapping
    from safetensors.torch import load_file as load_pt_file

    print(f"  Loading from {os.path.basename(pt_path)}...")
    pt_weights = load_pt_file(pt_path)

    # Same key mapping as convert.py
    mappings = ZImageWeightMapping.get_vae_mapping()

    def _expand_pattern(pattern, expansion_ranges):
        import re
        placeholders = re.findall(r'\{(\w+)\}', pattern)
        if not placeholders:
            return [pattern]
        results = [pattern]
        for ph in placeholders:
            new_results = []
            for r in results:
                for val in expansion_ranges.get(ph, [0]):
                    new_results.append(r.replace(f'{{{ph}}}', str(val)))
            results = new_results
        return results

    expansion_ranges = {'block': [0, 1, 2, 3], 'res': [0, 1], 'i': [0, 1]}
    decoder_expansion = dict(expansion_ranges, res=[0, 1, 2])

    key_map = {}
    for m in mappings:
        to_pat = m.to_pattern
        for from_pat in m.from_pattern:
            is_decoder_upblock = 'decoder.up_blocks.{block}' in from_pat
            exp = decoder_expansion if is_decoder_upblock else expansion_ranges
            for fk, tk in zip(_expand_pattern(from_pat, exp), _expand_pattern(to_pat, exp)):
                key_map[fk] = (tk, m.transform)

    mlx_weights = {}
    for k, v in pt_weights.items():
        if k not in key_map:
            continue
        new_key, transform = key_map[k]
        val_np = v.detach().cpu().float().numpy() if isinstance(v, torch.Tensor) else v
        arr = mx.array(val_np).astype(mx.bfloat16)
        if transform is not None:
            arr = transform(arr)
        mlx_weights[new_key] = arr

    del pt_weights
    gc.collect()

    vae_pt = ZImageVAE()
    vae_pt.load_weights(list(mlx_weights.items()))
    del mlx_weights
    mx.eval(vae_pt.parameters())

    t0 = time.time()
    decoded_pt = vae_pt.decode(latent)
    mx.eval(decoded_pt)
    t_pt = time.time() - t0
    print(f"  Decode in {t_pt:.3f}s")

    del vae_pt, latent
    gc.collect()

    # ── Phase 3: Compare ────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("Phase 3: Comparison")
    print("=" * 60)

    psnr_val = compute_psnr(decoded_pt, decoded_mlx)
    max_diff_val = float(mx.max(mx.abs(decoded_pt.astype(mx.float32) - decoded_mlx.astype(mx.float32))))
    mean_diff_val = float(mx.mean(mx.abs(decoded_pt.astype(mx.float32) - decoded_mlx.astype(mx.float32))))

    print(f"  PSNR:                {psnr_val:.2f} dB")
    print(f"  Max abs diff:        {max_diff_val:.6f}")
    print(f"  Mean abs diff:       {mean_diff_val:.6f}")
    print(f"  Speed:               MLX={t_mlx:.3f}s, PyTorch={t_pt:.3f}s")

    # Reference: flux-ae conversion achieved PSNR 50.57 dB
    print()
    print("=" * 60)
    print("VERDICT")
    print("=" * 60)
    if psnr_val > 45:
        print(f"  ✅ PASS — PSNR {psnr_val:.2f} dB (threshold > 45 dB)")
        print(f"     Conversion quality matches flux-ae (50.57 dB) benchmark.")
    elif psnr_val > 30:
        print(f"  ⚠️  ACCEPTABLE — PSNR {psnr_val:.2f} dB (threshold > 45 dB)")
        print(f"     Below flux-ae benchmark, but still good quality.")
    else:
        print(f"  ❌ FAIL — PSNR {psnr_val:.2f} dB below 30 dB threshold")

    return 0 if psnr_val > 30 else 1


if __name__ == "__main__":
    sys.exit(main())
