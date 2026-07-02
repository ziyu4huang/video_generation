"""Dump AMPBlock1 references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.vocoder.AMPBlock1 class this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_ampblock1_reference.py
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

from ltx_core_mlx.model.audio_vae.vocoder import AMPBlock1  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "ampblock1")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    channels = 4
    block = AMPBlock1(channels, kernel_size=3, dilations=(1, 3, 5))
    key = mx.random.key(1201)
    flat = mlx.utils.tree_flatten(block.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        if "filter" in k:
            # Anti-aliasing filters must be near-unity-gain low-pass kernels
            # (real ones are Kaiser-window sinc taps) -- an UNNORMALIZED
            # random filter (e.g. 12 taps averaging ~1.0 each) has gain ~12x
            # per pass. Through 6 activation passes (act1+act2 x 3
            # dilations) that compounds to ~12^6 (~3e6x), which blew up an
            # earlier version of this dump into fp32-noise territory
            # (~1e11) where the "parity" test was really just comparing
            # numerical chaos, not the actual port. Normalizing each
            # filter's random taps to sum to 1 keeps the whole block in a
            # numerically stable regime that actually exercises correctness.
            noisy = mx.random.normal(v.shape, key=sub) * 0.1 + 1.0
            new_flat.append((k, noisy / mx.sum(noisy)))
        else:
            new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.05))
    block.update(mlx.utils.tree_unflatten(new_flat))

    x = mx.random.normal((1, 20, channels), key=mx.random.key(1202))
    y = block(x)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(block.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "ampblock1.safetensors"))

    meta = {
        "channels": channels, "input_shape": list(x.shape), "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(block.parameters())],
    }
    with open(os.path.join(OUT_DIR, "ampblock1.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("input", x.shape, "-> output", y.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
