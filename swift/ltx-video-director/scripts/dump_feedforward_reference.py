"""Dump FeedForward references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.transformer.feed_forward.FeedForward
class this project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_feedforward_reference.py
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

from ltx_core_mlx.model.transformer.feed_forward import FeedForward  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "feed_forward")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    dim = 16
    module = FeedForward(dim, mult=4.0)

    key = mx.random.key(81)
    flat = mlx.utils.tree_flatten(module.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    module.update(mlx.utils.tree_unflatten(new_flat))

    x = mx.random.normal((2, 5, dim), key=mx.random.key(82))
    y = module(x)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(module.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "feed_forward.safetensors"))

    meta = {
        "dim": dim, "input_shape": list(x.shape), "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(module.parameters())],
    }
    with open(os.path.join(OUT_DIR, "feed_forward.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("input", x.shape, "-> output", y.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
