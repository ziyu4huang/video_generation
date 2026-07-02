"""Dump HannSincResampler references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.bwe.HannSincResampler class
this project's Python MLX pipeline runs -- WITH the runtime vendor patch
applied (app/vendor_patches.py's _patch_hann_sinc_resampler): the raw
vendored __call__ uses `upsampled.at[:, ::ratio].add(x_padded)`, the SAME
confirmed MLX 0.31.2 `.at[strided].add()` Metal mis-indexing bug already
found in UpSample1d (see dump_activation1d_reference.py). The REAL
pipeline never runs the raw version. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_hannsincresampler_reference.py
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

from ltx_core_mlx.model.audio_vae.bwe import HannSincResampler  # noqa: E402


def _patch_hann_sinc_resampler() -> None:
    """Replicates app/vendor_patches.py's _patch_hann_sinc_resampler
    without importing the full app package. Same fix, same reasoning as
    _patch_upsample1d: direct assignment is equivalent since the target
    starts zeroed.
    """
    def __call__(self, x):  # noqa: ANN001, ANN202
        B, T = x.shape
        ratio = self.upsample_factor

        first = mx.repeat(x[:, :1], self._pad, axis=1)
        last = mx.repeat(x[:, -1:], self._pad, axis=1)
        x_padded = mx.concatenate([first, x, last], axis=1)
        T_padded = x_padded.shape[1]

        zi_len = (T_padded - 1) * ratio + 1
        upsampled = mx.zeros((B, zi_len))
        upsampled[:, ::ratio] = x_padded

        upsampled = upsampled[:, :, None]
        K = self.kernel.shape[0]
        upsampled = mx.pad(upsampled, [(0, 0), (K - 1, K - 1), (0, 0)])
        filt = self.kernel[None, :, :]
        result = mx.conv1d(upsampled, filt, padding=0)
        result = result.squeeze(-1)

        result = result * ratio
        result = result[:, self._pad_left : -self._pad_right]
        return result[:, : T * ratio]

    HannSincResampler.__call__ = __call__


_patch_hann_sinc_resampler()

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "hannsinc")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    resampler = HannSincResampler(upsample_factor=3)
    x = mx.random.normal((1, 16), key=mx.random.key(1301))
    y = resampler(x)
    mx.eval(y)

    save_file({
        "kernel": np.array(resampler.kernel, copy=False),
        "input": np.array(x, copy=False), "output": np.array(y, copy=False),
    }, os.path.join(OUT_DIR, "hannsinc.safetensors"))
    meta = {"upsample_factor": 3, "input_shape": list(x.shape), "output_shape": list(y.shape)}
    with open(os.path.join(OUT_DIR, "hannsinc.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("input", x.shape, "-> output", y.shape)
    print("kernel shape", resampler.kernel.shape)
    print("done ->", OUT_DIR)
