"""Dump a ResBlockStage reference for Swift parity testing.

Uses the SAME ltx_core_mlx.model.video_vae.resnet.ResBlockStage this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_resblock_reference.py
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

from ltx_core_mlx.model.video_vae.resnet import ResBlockStage  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "resblock")
os.makedirs(OUT_DIR, exist_ok=True)


def dump_case(name: str, channels: int, num_blocks: int, causal: bool,
               spatial_padding_mode: str, shape) -> None:
    stage = ResBlockStage(channels, num_blocks, causal=causal, spatial_padding_mode=spatial_padding_mode)

    # Deterministic weights: reseed and overwrite every leaf parameter.
    key = mx.random.key(7)
    flat = mlx.utils.tree_flatten(stage.parameters())
    new_flat = []
    for i, (k, v) in enumerate(flat):
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.2))
    stage.update(mlx.utils.tree_unflatten(new_flat))

    x = mx.random.normal(shape, key=mx.random.key(99))
    y = stage(x)
    mx.eval(y)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(stage.parameters())}
    weights_out["input"] = np.array(x, copy=False)
    weights_out["output"] = np.array(y, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, f"{name}.safetensors"))

    meta = {
        "channels": channels, "num_blocks": num_blocks, "causal": causal,
        "spatial_padding_mode": spatial_padding_mode,
        "input_shape": list(shape), "output_shape": list(y.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(stage.parameters())],
    }
    with open(os.path.join(OUT_DIR, f"{name}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"{name}: input={shape} -> output={tuple(y.shape)}, keys={meta['weight_keys']}")


if __name__ == "__main__":
    dump_case("stage_2blocks", channels=8, num_blocks=2, causal=True,
               spatial_padding_mode="zeros", shape=(1, 4, 5, 5, 8))
    print("done ->", OUT_DIR)
