"""Dump DownSample1d/UpSample1d/Activation1d references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.vocoder classes this project's
Python MLX pipeline runs -- WITH the runtime vendor patch applied
(app/vendor_patches.py's _patch_upsample1d): the raw vendored UpSample1d
uses `x_up.at[:, ::2, :].add(x)`, which has a confirmed MLX 0.31.2
`.at[strided].add()` Metal mis-indexing bug (see this repo's own memory:
"MLX 0.31.2 音頻靜音修復"). The REAL pipeline never runs the raw version --
it always goes through app.vendor_patches.apply_all_patches() first, which
replaces it with plain `x_up[:, ::2, :] = x`. Dumping without the patch
would produce a reference that doesn't match what run.py actually executes.
Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_activation1d_reference.py
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

from ltx_core_mlx.model.audio_vae.vocoder import Activation1d, DownSample1d, UpSample1d  # noqa: E402


def _patch_upsample1d() -> None:
    """Replicates app/vendor_patches.py's _patch_upsample1d WITHOUT importing
    the full app package (which needs ltx_pipelines_mlx on the path) — same
    fix, same reasoning: MLX 0.31.2's `.at[strided].add()` mis-indexes on
    Metal; direct assignment is equivalent here since x_up starts zeroed.
    """
    def __call__(self, x):  # noqa: ANN001, ANN202
        B, T, C = x.shape
        x_up = mx.zeros((B, T * 2, C))
        x_up[:, ::2, :] = x

        x_up = x_up.transpose(0, 2, 1).reshape(B * C, T * 2, 1)

        K = self.filter.shape[1]
        pad = K // 2
        left_edge = mx.repeat(x_up[:, :1, :], pad, axis=1)
        right_edge = mx.repeat(x_up[:, -1:, :], pad - 1, axis=1)
        x_up = mx.concatenate([left_edge, x_up, right_edge], axis=1)

        x_up = mx.conv1d(x_up, self.filter)

        T_out = x_up.shape[1]
        return x_up.reshape(B, C, T_out).transpose(0, 2, 1) * 2.0

    UpSample1d.__call__ = __call__


_patch_upsample1d()  # replace the buggy .at[strided].add() with direct assignment

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "activation1d")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    channels = 4
    B, T = 1, 6

    # DownSample1d
    down = DownSample1d(kernel_size=12)
    down.lowpass.filter = mx.random.normal(down.lowpass.filter.shape, key=mx.random.key(1101)) * 0.2 + 1.0
    x_down = mx.random.normal((B, T, channels), key=mx.random.key(1102))
    y_down = down(x_down)
    mx.eval(y_down)
    save_file({
        "filter": np.array(down.lowpass.filter, copy=False),
        "input": np.array(x_down, copy=False), "output": np.array(y_down, copy=False),
    }, os.path.join(OUT_DIR, "downsample.safetensors"))

    # UpSample1d
    up = UpSample1d(kernel_size=12)
    up.filter = mx.random.normal(up.filter.shape, key=mx.random.key(1103)) * 0.2 + 1.0
    x_up = mx.random.normal((B, T, channels), key=mx.random.key(1104))
    y_up = up(x_up)
    mx.eval(y_up)
    save_file({
        "filter": np.array(up.filter, copy=False),
        "input": np.array(x_up, copy=False), "output": np.array(y_up, copy=False),
    }, os.path.join(OUT_DIR, "upsample.safetensors"))

    # Full Activation1d (upsample -> SnakeBeta -> downsample)
    act1d = Activation1d(channels, up_ratio=2, kernel_size=12)
    key = mx.random.key(1105)
    flat = mlx.utils.tree_flatten(act1d.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.2 + (1.0 if "filter" in k else 0.0)))
    act1d.update(mlx.utils.tree_unflatten(new_flat))
    x_full = mx.random.normal((B, T, channels), key=mx.random.key(1106))
    y_full = act1d(x_full)
    mx.eval(y_full)
    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(act1d.parameters())}
    weights_out["input"] = np.array(x_full, copy=False)
    weights_out["output"] = np.array(y_full, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "activation1d.safetensors"))

    meta = {
        "channels": channels, "downsample_out_shape": list(y_down.shape),
        "upsample_out_shape": list(y_up.shape), "activation1d_out_shape": list(y_full.shape),
        "activation1d_weight_keys": [k for k, _ in mlx.utils.tree_flatten(act1d.parameters())],
    }
    with open(os.path.join(OUT_DIR, "activation1d.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("downsample:", x_down.shape, "->", y_down.shape)
    print("upsample:", x_up.shape, "->", y_up.shape)
    print("activation1d:", x_full.shape, "->", y_full.shape)
    print("weight_keys", meta["activation1d_weight_keys"])
    print("done ->", OUT_DIR)
