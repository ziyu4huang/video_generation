"""Dump timestep-embedding references for Swift parity testing.

Uses the SAME mlx_arsenal.diffusion functions this project's Python MLX
pipeline runs (re-exported by ltx_core_mlx.model.transformer.timestep_embedding).
Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_timestep_embedding_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import mlx.utils
import numpy as np
from safetensors.numpy import save_file
from mlx_arsenal.diffusion import TimestepEmbedding, get_timestep_embedding

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "timestep_embedding")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    timesteps = mx.array([0.0, 250.0, 999.5, 42.0])
    embedding_dim = 16
    sinusoidal = get_timestep_embedding(timesteps, embedding_dim)
    mx.eval(sinusoidal)

    mlp = TimestepEmbedding(embedding_dim, 32)
    key = mx.random.key(61)
    flat = mlx.utils.tree_flatten(mlp.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    mlp.update(mlx.utils.tree_unflatten(new_flat))

    mlp_out = mlp(sinusoidal)
    mx.eval(mlp_out)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(mlp.parameters())}
    weights_out["timesteps"] = np.array(timesteps, copy=False)
    weights_out["sinusoidal"] = np.array(sinusoidal, copy=False)
    weights_out["mlp_output"] = np.array(mlp_out, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "timestep_embedding.safetensors"))

    meta = {
        "embedding_dim": embedding_dim, "sinusoidal_shape": list(sinusoidal.shape),
        "mlp_output_shape": list(mlp_out.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(mlp.parameters())],
    }
    with open(os.path.join(OUT_DIR, "timestep_embedding.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("timesteps", timesteps.shape, "-> sinusoidal", sinusoidal.shape, "-> mlp_out", mlp_out.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
