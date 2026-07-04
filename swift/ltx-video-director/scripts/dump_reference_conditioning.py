"""Dump VideoConditionByReferenceLatent references for Swift parity testing
(IC-LoRA reference/append conditioning — see NativeUpscaleStage.generateHD's
header for why this port exists).

Uses the SAME ltx_core_mlx.conditioning.types.reference_video_cond component
this project's Python MLX pipeline would use. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_reference_conditioning.py

Falls back to the sibling ltx-2-mlx checkout (~/proj/ltx-2-mlx) when the
vendored submodule under python/mlx-movie-director/vendor/ isn't checked out
in this worktree (see swift/ltx-video-director/PLAN.md's "IC-LoRA reference
conditioning" milestone) — same source either way.
"""
import json
import os
import sys

import mlx.core as mx
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
VENDORED = os.path.join(REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src")
SIBLING = os.path.expanduser("~/proj/ltx-2-mlx/packages/ltx-core-mlx/src")
sys.path.insert(0, VENDORED if os.path.isdir(VENDORED) else SIBLING)

from ltx_core_mlx.conditioning.types.latent_cond import LatentState  # noqa: E402
from ltx_core_mlx.conditioning.types.reference_video_cond import VideoConditionByReferenceLatent  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "reference_conditioning")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    # Small synthetic case: 2 generation frames (F=2,H=2,W=2 -> N=8 tokens) +
    # a 1-frame reference clip (Fr=1,H=2,W=2 -> Nr=4 tokens), C=6, B=1,
    # downscale_factor=2 (reference conditions at half the target spatial
    # resolution — the IC-LoRA-Pixel-Spatial-Upscaler's actual use case).
    B, F, H, W, C = 1, 2, 2, 2, 6
    N = F * H * W
    Fr, Hr, Wr = 1, 2, 2
    Nr = Fr * Hr * Wr
    downscale_factor = 2

    k = mx.random.key(501)
    k1, k2, k3, k4 = mx.random.split(k, num=4)
    latent = mx.random.normal((B, N, C), key=k1)
    denoise_mask = mx.ones((B, N, 1))
    positions = mx.random.uniform(shape=(B, N, 3), key=k2)  # stand-in for real RoPE positions

    reference_latent = mx.random.normal((B, Nr, C), key=k3)
    reference_positions = mx.random.uniform(shape=(B, Nr, 3), key=k4)

    state = LatentState(latent=latent, clean_latent=latent, denoise_mask=denoise_mask, positions=positions)
    conditioner = VideoConditionByReferenceLatent(
        reference_latent=reference_latent, reference_positions=reference_positions,
        downscale_factor=downscale_factor, strength=1.0)
    new_state = conditioner.apply(state, (F, H, W))
    mx.eval(new_state.latent, new_state.clean_latent, new_state.denoise_mask, new_state.positions)

    save_file({
        "latent": np.array(latent, copy=False),
        "positions": np.array(positions, copy=False),
        "reference_latent": np.array(reference_latent, copy=False),
        "reference_positions": np.array(reference_positions, copy=False),
        "new_latent": np.array(new_state.latent, copy=False),
        "new_clean_latent": np.array(new_state.clean_latent, copy=False),
        "new_denoise_mask": np.array(new_state.denoise_mask, copy=False),
        "new_positions": np.array(new_state.positions, copy=False),
    }, os.path.join(OUT_DIR, "reference_condition.safetensors"))

    meta = {"B": B, "F": F, "H": H, "W": W, "C": C, "Fr": Fr, "Hr": Hr, "Wr": Wr,
            "downscale_factor": downscale_factor, "strength": 1.0}
    with open(os.path.join(OUT_DIR, "reference_condition.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("new_latent", new_state.latent.shape)
    print("done ->", OUT_DIR)
