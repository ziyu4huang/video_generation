"""Dump SpaceToDepthDownsample + space_to_depth references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.video_vae.sampling components this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_spacetodepthdownsample_reference.py
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

from ltx_core_mlx.model.video_vae.sampling import SpaceToDepthDownsample, space_to_depth  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "space_to_depth")
os.makedirs(OUT_DIR, exist_ok=True)


def dump_space_to_depth():
    x = mx.random.normal((1, 4, 6, 6, 2), key=mx.random.key(31))
    y = space_to_depth(x, (2, 2, 2))
    mx.eval(y)
    save_file({"input": np.array(x, copy=False), "output": np.array(y, copy=False)},
              os.path.join(OUT_DIR, "space_to_depth.safetensors"))
    print("space_to_depth:", x.shape, "->", tuple(y.shape))


def dump_downsample(name, in_ch, out_ch, stride, shape):
    module = SpaceToDepthDownsample(in_ch, out_ch, stride=stride)
    key = mx.random.key(41)
    flat = mlx.utils.tree_flatten(module.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    module.update(mlx.utils.tree_unflatten(new_flat))

    x = mx.random.normal(shape, key=mx.random.key(42))
    y = module(x)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(module.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, f"{name}.safetensors"))
    meta = {
        "in_channels": in_ch, "out_channels": out_ch, "stride": list(stride),
        "input_shape": list(shape), "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(module.parameters())],
    }
    with open(os.path.join(OUT_DIR, f"{name}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"{name}: {shape} -> {tuple(y.shape)}, group_size={module.group_size}, keys={meta['weight_keys']}")


if __name__ == "__main__":
    dump_space_to_depth()
    dump_downsample("downsample_st2", in_ch=4, out_ch=8, stride=(2, 2, 2), shape=(1, 5, 4, 4, 4))
    dump_downsample("downsample_spatial_only", in_ch=4, out_ch=8, stride=(1, 2, 2), shape=(1, 3, 4, 4, 4))
    print("done ->", OUT_DIR)
