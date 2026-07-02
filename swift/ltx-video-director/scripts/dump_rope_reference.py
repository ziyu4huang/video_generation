"""Dump RoPE (SPLIT layout) references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.transformer.rope functions this
project's Python MLX pipeline runs (production checkpoints all use
SPLIT layout). Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_rope_reference.py
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

from ltx_core_mlx.model.transformer.rope import apply_rope_split, precompute_rope_freqs  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "rope")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    # Video-like: 3 position dims (temporal, height, width), small token count.
    B, N, num_pos_dims = 1, 6, 3
    inner_dim = 32
    num_heads = 4
    # Integer positions within [0, max_pos) per axis.
    max_pos = [20, 64, 64]
    key = mx.random.key(51)
    positions = mx.stack([
        mx.random.randint(0, max_pos[i], (B, N), key=mx.random.split(key)[1])
        for i in range(num_pos_dims)
    ], axis=-1).astype(mx.int32)

    cos_f, sin_f, rope_type = precompute_rope_freqs(
        positions, inner_dim=inner_dim, num_heads=num_heads, theta=10000.0,
        max_pos=max_pos, rope_type="split")
    assert rope_type == "split"

    head_dim = inner_dim // num_heads
    x = mx.random.normal((B, num_heads, N, head_dim), key=mx.random.key(52))
    y = apply_rope_split(x, cos_f, sin_f)
    mx.eval(cos_f, sin_f, y)

    save_file({
        "positions": np.array(positions, copy=False),
        "x": np.array(x, copy=False),
        "cos": np.array(cos_f, copy=False),
        "sin": np.array(sin_f, copy=False),
        "output": np.array(y, copy=False),
    }, os.path.join(OUT_DIR, "split_video.safetensors"))

    meta = {
        "B": B, "N": N, "num_pos_dims": num_pos_dims, "inner_dim": inner_dim,
        "num_heads": num_heads, "theta": 10000.0, "max_pos": max_pos,
        "positions_shape": list(positions.shape), "cos_shape": list(cos_f.shape),
        "output_shape": list(y.shape),
    }
    with open(os.path.join(OUT_DIR, "split_video.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("positions", positions.shape, "-> cos/sin", cos_f.shape, "-> output", y.shape)
    print("done ->", OUT_DIR)
