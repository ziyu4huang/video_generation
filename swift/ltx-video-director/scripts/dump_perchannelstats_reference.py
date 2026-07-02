"""Dump PerChannelStatistics.denormalize_latent reference for Swift parity testing.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_perchannelstats_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.model.video_vae.ops import PerChannelStatistics  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "perchannelstats")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    channels = 16
    stats = PerChannelStatistics(channels)
    stats.mean = mx.random.normal((channels,), key=mx.random.key(21)) * 0.5
    stats.std = mx.abs(mx.random.normal((channels,), key=mx.random.key(22))) + 0.5

    latent = mx.random.normal((1, 3, 4, 4, channels), key=mx.random.key(23))
    mean = stats.mean.reshape(1, 1, 1, 1, -1)
    std = stats.std.reshape(1, 1, 1, 1, -1)
    out = latent * std + mean
    mx.eval(out)

    save_file({
        "mean": np.array(stats.mean, copy=False),
        "std": np.array(stats.std, copy=False),
        "latent": np.array(latent, copy=False),
        "output": np.array(out, copy=False),
    }, os.path.join(OUT_DIR, "denorm.safetensors"))
    print("input", latent.shape, "-> output", out.shape, "->", OUT_DIR)
