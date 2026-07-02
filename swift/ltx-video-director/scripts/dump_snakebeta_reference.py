"""Dump SnakeBeta activation references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.vocoder.SnakeBeta class this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_snakebeta_reference.py
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

from ltx_core_mlx.model.audio_vae.vocoder import SnakeBeta  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "snakebeta")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    channels = 8
    act = SnakeBeta(channels)
    # Non-zero log-scale weights (zero-init would trivially give exp=1 for
    # both, not exercising the actual scale factors).
    act.alpha = mx.random.normal((channels,), key=mx.random.key(1001)) * 0.3
    act.beta = mx.random.normal((channels,), key=mx.random.key(1002)) * 0.3

    x = mx.random.normal((1, 5, channels), key=mx.random.key(1003))
    y = act(x)
    mx.eval(y)

    save_file({
        "alpha": np.array(act.alpha, copy=False), "beta": np.array(act.beta, copy=False),
        "input": np.array(x, copy=False), "output": np.array(y, copy=False),
    }, os.path.join(OUT_DIR, "snakebeta.safetensors"))
    meta = {"channels": channels, "input_shape": [1, 5, channels]}
    with open(os.path.join(OUT_DIR, "snakebeta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("input", x.shape, "-> output", y.shape)
    print("done ->", OUT_DIR)
