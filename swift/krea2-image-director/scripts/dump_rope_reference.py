"""Dump Krea 2 RoPE references for Swift parity testing.

Uses app/krea2_transformer.PositionalEncoding + _rope_apply at the REAL Krea
config (axes [32,48,48], theta=1e3, interleaved-2x2 matrix convention). The
interleaved-2x2 + theta=1e3 (not 1e4) convention is easy to get wrong; this
locks it down. Run from repo root:

    ../video_generation__venv/bin/python swift/krea2-image-director/scripts/dump_rope_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO_ROOT, "python/mlx-movie-director"))

from app.krea2_transformer import PositionalEncoding, _rope_apply  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(SCRIPT_DIR, "..", "test_refs", "rope")
os.makedirs(OUT_DIR, exist_ok=True)

# Real Krea head_dim=128 -> axes [32,48,48] (sum=128, all even).
AXES = [32, 48, 48]
THETA = 1e3


def to_np(x):
    return np.array(x, copy=False)


def main():
    mx.random.seed(5)
    # pos: (B, L, 3). Text tokens at origin, image tokens at (0, h, w).
    pos = mx.array([[[0, 0, 0],
                     [0, 0, 0],
                     [0, 1, 0],
                     [0, 0, 2]]], dtype=mx.float32)   # (1, 4, 3)
    pe = PositionalEncoding(AXES, theta=THETA)
    freqs = pe(pos)                                     # (1, 4, 64, 2, 2)
    mx.eval(freqs)

    # Also dump rope_apply on a small q/k (GQA: H_q=2, H_kv=1).
    B, Lq = 1, 4
    Hq, Hkv, D = 2, 1, 128
    xq = mx.random.normal((B, Hq, Lq, D), key=mx.random.key(21))
    xk = mx.random.normal((B, Hkv, Lq, D), key=mx.random.key(22))
    rq, rk = _rope_apply(xq, xk, freqs)
    mx.eval(rq, rk)

    save_file({
        "pos": to_np(pos),
        "freqs": to_np(freqs),
        "xq_in": to_np(xq), "xk_in": to_np(xk),
        "xq_out": to_np(rq), "xk_out": to_np(rk),
    }, os.path.join(OUT_DIR, "rope.safetensors"))
    meta = {"axes": AXES, "theta": THETA, "pos_shape": list(pos.shape),
            "freqs_shape": list(freqs.shape), "xq_shape": list(xq.shape)}
    with open(os.path.join(OUT_DIR, "rope.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("rope freqs:", freqs.shape, "| xq", xq.shape, "->", rq.shape)
    print("done ->", os.path.abspath(OUT_DIR))


if __name__ == "__main__":
    main()
