"""Dump a Conv3dBlock reference (weights, input, output) for Swift parity testing.

Uses the SAME ltx_core_mlx.model.video_vae.convolution.Conv3dBlock this
project's Python MLX pipeline runs (not a reimplementation) — ground truth
for Swift's native port in Sources/LTXVideoDirector/VAE/Conv3dBlock.swift.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_conv3d_reference.py
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

from ltx_core_mlx.model.video_vae.convolution import Conv3dBlock  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "conv3d")
os.makedirs(OUT_DIR, exist_ok=True)


def dump_case(name: str, causal: bool, spatial_padding_mode: str, in_ch: int, out_ch: int,
               kernel: int, shape) -> None:
    mx.random.seed(42)
    block = Conv3dBlock(
        in_channels=in_ch, out_channels=out_ch, kernel_size=kernel,
        stride=1, padding=kernel // 2, causal=causal,
        spatial_padding_mode=spatial_padding_mode,
    )
    # Deterministic weights: replace random init with a fixed seeded normal.
    w = mx.random.normal(block.conv.weight.shape, key=mx.random.key(1))
    b = mx.random.normal(block.conv.bias.shape, key=mx.random.key(2))
    block.conv.weight = w
    block.conv.bias = b

    x = mx.random.normal(shape, key=mx.random.key(3))
    y = block(x)
    mx.eval(y)

    save_file({
        "weight": np.array(w, copy=False),
        "bias": np.array(b, copy=False),
        "input": np.array(x, copy=False),
        "output": np.array(y, copy=False),
    }, os.path.join(OUT_DIR, f"{name}.safetensors"))

    meta = {
        "causal": causal, "spatial_padding_mode": spatial_padding_mode,
        "in_channels": in_ch, "out_channels": out_ch, "kernel_size": kernel,
        "input_shape": list(shape), "output_shape": list(y.shape),
    }
    with open(os.path.join(OUT_DIR, f"{name}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"{name}: input={shape} -> output={tuple(y.shape)}")


if __name__ == "__main__":
    # Small, fast cases covering both causal modes and both padding modes.
    dump_case("causal_zeros", causal=True, spatial_padding_mode="zeros",
               in_ch=4, out_ch=8, kernel=3, shape=(1, 5, 6, 6, 4))
    dump_case("noncausal_reflect", causal=False, spatial_padding_mode="reflect",
               in_ch=4, out_ch=8, kernel=3, shape=(1, 5, 6, 6, 4))
    dump_case("causal_kernel1", causal=True, spatial_padding_mode="zeros",
               in_ch=8, out_ch=8, kernel=1, shape=(1, 3, 4, 4, 8))
    print("done ->", OUT_DIR)
