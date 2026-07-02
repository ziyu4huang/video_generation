"""Dump LatentConditioning references (VideoConditionByLatentIndex.apply,
apply_denoise_mask) for Swift parity testing.

Uses the SAME ltx_core_mlx.conditioning.types.latent_cond components this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_latentcond_reference.py
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

from ltx_core_mlx.conditioning.types.latent_cond import (  # noqa: E402
    LatentState,
    VideoConditionByLatentIndex,
    apply_denoise_mask,
)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "latent_cond")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    # I2V shape: F=3 frames, H=2, W=2 (tokens_per_frame=4), C=6, B=1.
    B, F, H, W, C = 1, 3, 2, 2, 6
    N = F * H * W
    tokens_per_frame = H * W

    key = mx.random.key(401)
    latent = mx.random.normal((B, N, C), key=mx.random.split(key)[1])
    clean_full = mx.random.normal((B, N, C), key=mx.random.split(key)[1])
    denoise_mask = mx.ones((B, N, 1))

    state = LatentState(latent=latent, clean_latent=latent, denoise_mask=denoise_mask)

    # Condition frame 0 only (typical I2V: first frame preserved).
    frame0_clean = clean_full[:, 0:tokens_per_frame, :]
    conditioner = VideoConditionByLatentIndex(frame_indices=[0], clean_latent=frame0_clean, strength=1.0)
    new_state = conditioner.apply(state, (F, H, W))
    mx.eval(new_state.latent, new_state.clean_latent, new_state.denoise_mask)

    # apply_denoise_mask: blend a fake x0 prediction with the new state's clean_latent/mask.
    x0 = mx.random.normal((B, N, C), key=mx.random.key(402))
    blended = apply_denoise_mask(x0, new_state.clean_latent, new_state.denoise_mask)
    mx.eval(blended)

    save_file({
        "latent": np.array(latent, copy=False),
        "clean_full": np.array(clean_full, copy=False),
        "x0": np.array(x0, copy=False),
        "new_latent": np.array(new_state.latent, copy=False),
        "new_clean_latent": np.array(new_state.clean_latent, copy=False),
        "new_denoise_mask": np.array(new_state.denoise_mask, copy=False),
        "blended": np.array(blended, copy=False),
    }, os.path.join(OUT_DIR, "i2v_condition.safetensors"))

    meta = {"B": B, "F": F, "H": H, "W": W, "C": C, "frame_indices": [0], "strength": 1.0}
    with open(os.path.join(OUT_DIR, "i2v_condition.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("new_latent", new_state.latent.shape, "mask sum (should be N - tokens_per_frame):",
          float(mx.sum(new_state.denoise_mask).item()), "expected", N - tokens_per_frame)
    print("done ->", OUT_DIR)
