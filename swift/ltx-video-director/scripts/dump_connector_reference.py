"""Dump Embeddings1DConnector references for Swift parity testing.

Uses the SAME ltx_core_mlx.text_encoders.gemma.embeddings_connector.
Embeddings1DConnector class this project's Python MLX pipeline runs, with
attention_mask=None (registers appended path — matches
EmbeddingsConnector.swift's current scope). Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_connector_reference.py
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

from ltx_core_mlx.text_encoders.gemma.embeddings_connector import Embeddings1DConnector  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "connector")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    dim, num_heads, head_dim, num_layers, num_registers = 16, 2, 8, 2, 4

    connector = Embeddings1DConnector(
        dim=dim, num_heads=num_heads, head_dim=head_dim,
        num_layers=num_layers, num_registers=num_registers,
        ff_mult=4.0, max_pos=64, norm_output=True,
    )
    key = mx.random.key(601)
    flat = mlx.utils.tree_flatten(connector.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    connector.update(mlx.utils.tree_unflatten(new_flat))

    B, seq_len = 1, 6
    hidden_states = mx.random.normal((B, seq_len, dim), key=mx.random.key(602))

    output = connector(hidden_states, attention_mask=None)
    mx.eval(output)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(connector.parameters())}
    weights_out["hidden_states"] = np.array(hidden_states, copy=False)
    weights_out["output"] = np.array(output, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "connector.safetensors"))

    meta = {
        "dim": dim, "num_heads": num_heads, "head_dim": head_dim, "num_layers": num_layers,
        "num_registers": num_registers, "max_pos": 64,
        "input_shape": list(hidden_states.shape), "output_shape": list(output.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(connector.parameters())],
    }
    with open(os.path.join(OUT_DIR, "connector.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("input", hidden_states.shape, "-> output", output.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
