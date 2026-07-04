#!/usr/bin/env python3
"""Dump a real-checkpoint reference for LatentUpsampler (spatial_x1_5 variant).

Sibling of dump_latent_upsampler_reference.py (spatial_x2) — loads the real
spatial_upscaler_x1_5_v1_0.safetensors checkpoint (rational_resampler=true,
spatial_scale=1.5), runs it on the same small fixed-seed random latent, and
writes {input, output} to a safetensors file for the Swift parity test
(LatentUpsamplerX1_5RealCheckpointParityTests).

Run via: /Users/huangziyu/proj/video_generation__venv/bin/python
         swift/ltx-video-director/scripts/dump_latent_upsampler_x1_5_reference.py
"""

import os
import sys

_REPO_ROOT_FOR_VENDOR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_VENDOR_BASE = os.path.join(_REPO_ROOT_FOR_VENDOR, "python", "mlx-movie-director", "vendor", "ltx-2-mlx")
_SIBLING = os.path.expanduser("~/proj/ltx-2-mlx/packages/ltx-core-mlx/src")
_src = os.path.join(_VENDOR_BASE, "packages/ltx-core-mlx/src")
sys.path.insert(0, _src if os.path.isdir(_src) else _SIBLING)

import mlx.core as mx
from ltx_core_mlx.model.upsampler.model import LatentUpsampler

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CHECKPOINT = os.path.join(REPO_ROOT, "mlx-models", "vae", "ltx-2.3-vae", "spatial_upscaler_x1_5_v1_0.safetensors")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "latent_upsampler")


def main():
    if not os.path.exists(CHECKPOINT):
        print(f"SKIP: checkpoint not found at {CHECKPOINT}")
        return

    config = {
        "in_channels": 128, "mid_channels": 1024, "num_blocks_per_stage": 4,
        "spatial_upsample": True, "temporal_upsample": False,
        "spatial_scale": 1.5, "rational_resampler": True,
    }
    model = LatentUpsampler.from_config(config)

    raw = mx.load(CHECKPOINT)
    prefix = "spatial_upscaler_x1_5_v1_0."
    weights = {}
    for k, v in raw.items():
        stripped = k[len(prefix):] if k.startswith(prefix) else k
        weights[stripped] = v.astype(mx.float32)
    model.load_weights(list(weights.items()), strict=True)
    mx.eval(model.parameters())

    mx.random.seed(1234)
    # Same fixed-seed (1, 128, 2, 8, 8) latent as the spatial_x2 dump —
    # BCFHW, matching VideoEncoder/VideoDecoder's convention.
    latent = mx.random.normal((1, 128, 2, 8, 8), dtype=mx.float32) * 0.5

    output = model(latent)
    mx.eval(output)

    os.makedirs(OUT_DIR, exist_ok=True)
    mx.save_safetensors(os.path.join(OUT_DIR, "latent_upsampler_x1_5.safetensors"), {
        "input": latent.astype(mx.float32),
        "output": output.astype(mx.float32),
    })
    print(f"input shape:  {latent.shape}")
    print(f"output shape: {output.shape}")
    print(f"wrote {OUT_DIR}/latent_upsampler_x1_5.safetensors")


if __name__ == "__main__":
    main()
