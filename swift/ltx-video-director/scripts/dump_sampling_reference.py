"""Dump pixel_shuffle_3d / unpatchify_spatial references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.video_vae.sampling functions this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_sampling_reference.py
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

from ltx_core_mlx.model.video_vae.sampling import pixel_shuffle_3d, unpatchify_spatial  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "sampling")
os.makedirs(OUT_DIR, exist_ok=True)


def dump(name, fn, shape, **kwargs):
    x = mx.random.normal(shape, key=mx.random.key(11))
    y = fn(x, **kwargs)
    mx.eval(y)
    save_file({"input": np.array(x, copy=False), "output": np.array(y, copy=False)},
              os.path.join(OUT_DIR, f"{name}.safetensors"))
    meta = {"input_shape": list(shape), "output_shape": list(y.shape), "kwargs": kwargs}
    with open(os.path.join(OUT_DIR, f"{name}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"{name}: {shape} -> {tuple(y.shape)}")


if __name__ == "__main__":
    dump("pixel_shuffle_sf2_tf2", pixel_shuffle_3d, (1, 3, 4, 4, 8 * 2 * 2 * 2),
         spatial_factor=2, temporal_factor=2)
    dump("pixel_shuffle_sf2_tf1", pixel_shuffle_3d, (1, 2, 5, 5, 6 * 2 * 2 * 1),
         spatial_factor=2, temporal_factor=1)
    dump("unpatchify_ps4", unpatchify_spatial, (1, 2, 3, 3, 3 * 4 * 4), patch_size=4)
    print("done ->", OUT_DIR)
