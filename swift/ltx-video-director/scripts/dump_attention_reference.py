"""Dump Attention references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.transformer.attention.Attention class
this project's Python MLX pipeline runs. Covers self-attention with RoPE
and cross-attention (no RoPE, different kv_dim) — the two attention
"shapes" the 48-layer DiT actually uses. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_attention_reference.py
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

from ltx_core_mlx.model.transformer.attention import Attention  # noqa: E402
from ltx_core_mlx.model.transformer.rope import precompute_rope_freqs  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "attention")
os.makedirs(OUT_DIR, exist_ok=True)


def randomize(module, seed):
    key = mx.random.key(seed)
    flat = mlx.utils.tree_flatten(module.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    module.update(mlx.utils.tree_unflatten(new_flat))


def dump_self_attention_with_rope():
    num_heads, head_dim = 4, 8
    query_dim = num_heads * head_dim
    module = Attention(query_dim, num_heads=num_heads, head_dim=head_dim, use_rope=True)
    randomize(module, 91)

    B, N = 2, 6
    x = mx.random.normal((B, N, query_dim), key=mx.random.key(92))

    # Video-like 3D positions for RoPE.
    max_pos = [20, 64, 64]
    key = mx.random.key(93)
    positions = mx.stack([
        mx.random.randint(0, max_pos[i], (B, N), key=mx.random.split(key)[1])
        for i in range(3)
    ], axis=-1).astype(mx.int32)
    cos_f, sin_f, rtype = precompute_rope_freqs(
        positions, inner_dim=query_dim, num_heads=num_heads, max_pos=max_pos, rope_type="split")

    y = module(x, rope_freqs=(cos_f, sin_f, rtype))
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(module.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["cos"] = np.array(cos_f, copy=False)
    weights_out["sin"] = np.array(sin_f, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "self_attn_rope.safetensors"))
    meta = {
        "num_heads": num_heads, "head_dim": head_dim, "input_shape": list(x.shape),
        "output_shape": list(y.shape), "weight_keys": [k for k, _ in mlx.utils.tree_flatten(module.parameters())],
    }
    with open(os.path.join(OUT_DIR, "self_attn_rope.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("self_attn_rope:", x.shape, "->", y.shape, "keys:", meta["weight_keys"])


def dump_cross_attention_no_rope():
    num_heads, head_dim = 4, 8
    query_dim = num_heads * head_dim
    kv_dim = 12
    module = Attention(query_dim, kv_dim=kv_dim, num_heads=num_heads, head_dim=head_dim, use_rope=False)
    randomize(module, 94)

    B, N, Nkv = 2, 5, 7
    x = mx.random.normal((B, N, query_dim), key=mx.random.key(95))
    encoder_hidden_states = mx.random.normal((B, Nkv, kv_dim), key=mx.random.key(96))

    y = module(x, encoder_hidden_states=encoder_hidden_states)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(module.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["encoder_hidden_states"] = np.array(encoder_hidden_states, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "cross_attn.safetensors"))
    meta = {
        "num_heads": num_heads, "head_dim": head_dim, "input_shape": list(x.shape),
        "kv_shape": list(encoder_hidden_states.shape), "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(module.parameters())],
    }
    with open(os.path.join(OUT_DIR, "cross_attn.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("cross_attn:", x.shape, encoder_hidden_states.shape, "->", y.shape, "keys:", meta["weight_keys"])


if __name__ == "__main__":
    dump_self_attention_with_rope()
    dump_cross_attention_no_rope()
    print("done ->", OUT_DIR)
