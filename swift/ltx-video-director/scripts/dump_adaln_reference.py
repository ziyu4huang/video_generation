"""Dump AdaLayerNormSingle references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.transformer.adaln.AdaLayerNormSingle
class this project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_adaln_reference.py
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

from ltx_core_mlx.model.transformer.adaln import AdaLayerNormSingle  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "adaln")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    dim = 16
    num_params = 6
    module = AdaLayerNormSingle(dim=dim, num_params=num_params)

    key = mx.random.key(71)
    flat = mlx.utils.tree_flatten(module.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    module.update(mlx.utils.tree_unflatten(new_flat))

    timestep_emb = mx.random.normal((3, dim), key=mx.random.key(72))
    params, embedded = module(timestep_emb)
    mx.eval(params, embedded)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(module.parameters())}
    weights_out["timestep_emb"] = np.array(timestep_emb, copy=False)
    weights_out["params"] = np.array(params, copy=False)
    weights_out["embedded"] = np.array(embedded, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "adaln.safetensors"))

    meta = {
        "dim": dim, "num_params": num_params,
        "params_shape": list(params.shape), "embedded_shape": list(embedded.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(module.parameters())],
    }
    with open(os.path.join(OUT_DIR, "adaln.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("timestep_emb", timestep_emb.shape, "-> params", params.shape, "embedded", embedded.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
