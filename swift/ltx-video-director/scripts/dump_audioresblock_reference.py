"""Dump AudioResBlock references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.audio_vae.AudioResBlock class
this project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_audioresblock_reference.py
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

from ltx_core_mlx.model.audio_vae.audio_vae import AudioResBlock  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "audio_resblock")
os.makedirs(OUT_DIR, exist_ok=True)


def dump(name, in_ch, out_ch, causal, shape):
    block = AudioResBlock(in_ch, out_ch, causal=causal)
    key = mx.random.key(701)
    flat = mlx.utils.tree_flatten(block.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    block.update(mlx.utils.tree_unflatten(new_flat))

    x = mx.random.normal(shape, key=mx.random.key(702))
    y = block(x)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(block.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, f"{name}.safetensors"))
    meta = {
        "in_channels": in_ch, "out_channels": out_ch, "causal": causal,
        "input_shape": list(shape), "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(block.parameters())],
    }
    with open(os.path.join(OUT_DIR, f"{name}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"{name}: {shape} -> {tuple(y.shape)}, keys={meta['weight_keys']}")


if __name__ == "__main__":
    dump("same_channels_causal", in_ch=8, out_ch=8, causal=True, shape=(1, 5, 6, 8))
    dump("diff_channels_noncausal", in_ch=8, out_ch=16, causal=False, shape=(1, 5, 6, 8))
    print("done ->", OUT_DIR)
