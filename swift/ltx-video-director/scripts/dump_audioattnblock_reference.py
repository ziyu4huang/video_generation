"""Dump AudioAttnBlock references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.audio_vae.AudioAttnBlock class
this project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_audioattnblock_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import mlx.utils
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.model.audio_vae.audio_vae import AudioAttnBlock  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "audio_attn")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    channels = 32  # must be divisible by GroupNorm's 32 groups -> 1 channel/group here; use 64 for cg=2
    channels = 64
    block = AudioAttnBlock(channels)
    key = mx.random.key(801)
    flat = mlx.utils.tree_flatten(block.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    block.update(mlx.utils.tree_unflatten(new_flat))
    # GroupNorm weight/bias should be near-identity-ish scale for a meaningful test; keep as random small values (already fine).

    x = mx.random.normal((1, 4, 5, channels), key=mx.random.key(802))
    y = block(x)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(block.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "attn.safetensors"))
    meta = {
        "channels": channels, "input_shape": [1, 4, 5, channels], "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(block.parameters())],
    }
    with open(os.path.join(OUT_DIR, "attn.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("input", x.shape, "-> output", y.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
