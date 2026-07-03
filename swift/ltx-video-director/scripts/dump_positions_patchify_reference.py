"""Dump video/audio position + patchify reference for Swift parity testing.

Ports ltx_core_mlx.utils.positions (compute_video_positions,
compute_audio_positions, compute_audio_token_count) and
ltx_core_mlx.components.patchifiers (VideoLatentPatchifier,
AudioPatchifier, compute_video_latent_shape) — pure arithmetic, no
checkpoint weights, so this dump needs no model download. This is the
positions/patchify glue LTXModel/DenoiseLoop (already ported+verified)
need to actually run against real spatial/temporal video shapes instead
of synthetic all-zero test positions.

NOTE: this worktree has the vendor submodules untracked (see chore:
untrack build/vendor submodules, PR #189), so the vendored copy under
python/mlx-movie-director/vendor/ltx-2-mlx isn't checked out here. Falls
back to the sibling checkout at ~/proj/ltx-2-mlx (same source the
submodule points to) if the in-repo vendor path is missing.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_positions_patchify_reference.py
"""
import json
import os
import sys

import mlx.core as mx

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
VENDORED = os.path.join(REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src")
SIBLING = os.path.expanduser("~/proj/ltx-2-mlx/packages/ltx-core-mlx/src")
sys.path.insert(0, VENDORED if os.path.isdir(VENDORED) else SIBLING)

from ltx_core_mlx.utils.positions import (  # noqa: E402
    compute_audio_positions,
    compute_audio_token_count,
    compute_video_positions,
)
from ltx_core_mlx.components.patchifiers import (  # noqa: E402
    AudioPatchifier,
    VideoLatentPatchifier,
    compute_video_latent_shape,
)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "positions_patchify")
os.makedirs(OUT_DIR, exist_ok=True)

arrays = {}
scalars = {}

# compute_video_positions: a non-trivial (F, H, W) so causal-fix temporal
# midpoints and spatial midpoints both exercise real arithmetic.
video_positions = compute_video_positions(num_frames=4, height=3, width=5, frame_rate=24.0)
arrays["video_positions_f4h3w5"] = video_positions

# compute_audio_positions: enough tokens to see the causal-fix clamp at idx=0.
audio_positions = compute_audio_positions(num_tokens=6)
arrays["audio_positions_t6"] = audio_positions

scalars["audio_token_count_41frames_24fps"] = compute_audio_token_count(num_video_frames=41, frame_rate=24.0)
scalars["video_latent_shape_41x64x96"] = list(compute_video_latent_shape(num_frames=41, height=64, width=96))

# Patchify/unpatchify round trip on random data — proves the reshape/
# transpose axis order matches exactly (any axis-order bug shows up
# immediately as a shape mismatch or non-identity round trip).
mx.random.seed(0)
video_latent = mx.random.normal((1, 128, 2, 3, 2))
video_patchifier = VideoLatentPatchifier()
video_tokens, video_dims = video_patchifier.patchify(video_latent)
arrays["video_latent_in"] = video_latent
arrays["video_tokens_out"] = video_tokens
scalars["video_dims_out"] = list(video_dims)

audio_latent = mx.random.normal((1, 8, 5, 16))
audio_patchifier = AudioPatchifier()
audio_tokens, audio_t = audio_patchifier.patchify(audio_latent)
arrays["audio_latent_in"] = audio_latent
arrays["audio_tokens_out"] = audio_tokens
scalars["audio_t_out"] = audio_t

mx.eval(list(arrays.values()))
mx.save_safetensors(os.path.join(OUT_DIR, "positions_patchify.safetensors"), arrays)
with open(os.path.join(OUT_DIR, "scalars.json"), "w") as f:
    json.dump(scalars, f, indent=2)

print(f"wrote {len(arrays)} arrays + scalars.json to {OUT_DIR}")
