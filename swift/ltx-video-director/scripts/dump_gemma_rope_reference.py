"""Dump mlx nn.RoPE reference for Swift parity testing.

Isolates the #1 suspect in the layer-0 block diff: does MLXFast.RoPE (Swift)
match mx.nn.RoPE (Python) on a (B, n_heads, L, head_dim) input — the exact
shape Gemma attention uses? The LTX RoPE port precomputes cos/sin manually
rather than calling MLXFast.RoPE, so there's no prior verified usage.

Tests BOTH configs Gemma uses:
  - sliding: base=1e4, scale=1
  - global:   base=1e6, scale=1/8 (linear)

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_gemma_rope_reference.py
"""
import os
import sys

import mlx.core as mx
import mlx.nn as nn

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "gemma_rope")
os.makedirs(OUT_DIR, exist_ok=True)

HEAD_DIM = 256
N_HEADS = 16
B, L = 1, 8

key = mx.random.key(7)
key, sub = mx.random.split(key)
x = mx.random.normal((B, N_HEADS, L, HEAD_DIM), key=sub).astype(mx.float32)

arrays = {"input": x}
for name, (base, scale) in {
    "sliding": (10_000.0, 1.0),
    "global": (1_000_000.0, 1.0 / 8.0),
}.items():
    rope = nn.RoPE(dims=HEAD_DIM, traditional=False, base=base, scale=scale)
    out = rope(x)
    mx.eval(out)
    arrays[f"output_{name}"] = out
    print(f"{name}: base={base} scale={scale} -> out shape {out.shape}")

mx.save_safetensors(os.path.join(OUT_DIR, "ref.safetensors"), dict(arrays))
print(f"wrote {len(arrays)} tensors to {OUT_DIR}")
