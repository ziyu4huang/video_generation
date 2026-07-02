"""Dump TextEmbeddingProjection reference for Swift parity testing.

Uses the SAME ltx_core_mlx.text_encoders.gemma.feature_extractor.TextEmbeddingProjection
class this project's Python MLX pipeline runs. Tiny dims so the reference file
stays small (production is 188160→4096/2048, far too big for a committed
fixture); the MATH is identical at any dim.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_textembeddingprojection_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import mlx.nn as nn
import mlx.utils

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.text_encoders.gemma.feature_extractor import TextEmbeddingProjection  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "textembeddingprojection")
os.makedirs(OUT_DIR, exist_ok=True)

# Tiny dims (math is dim-independent). embedding_dim kept realistic-ish so the
# sqrt(target/embedding) rescale is exercised meaningfully.
input_dim = 64
embedding_dim = 16
video_dim = 32
audio_dim = 24

key = mx.random.key(7)
key, sub = mx.random.split(key)
proj = TextEmbeddingProjection(
    input_dim=input_dim, video_dim=video_dim, audio_dim=audio_dim, embedding_dim=embedding_dim)

# Random fixed-seed weights + input.
flat = mlx.utils.tree_flatten(proj.parameters())
new_flat = []
for k, v in flat:
    key, sub = mx.random.split(key)
    new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.05))
proj.update(mlx.utils.tree_unflatten(new_flat))

key, sub = mx.random.split(key)
hidden = mx.random.normal((1, 5, input_dim), key=key)  # (B, seq, input_dim)

video, audio = proj(hidden)
mx.eval(video, audio)

arrays = {
    "video_aggregate_embed.weight": proj.video_aggregate_embed.weight,
    "video_aggregate_embed.bias": proj.video_aggregate_embed.bias,
    "audio_aggregate_embed.weight": proj.audio_aggregate_embed.weight,
    "audio_aggregate_embed.bias": proj.audio_aggregate_embed.bias,
    "hidden_states": hidden,
    "video_output": video,
    "audio_output": audio,
}
mx.save_safetensors(os.path.join(OUT_DIR, "ref.safetensors"), dict(arrays))

with open(os.path.join(OUT_DIR, "meta.json"), "w") as f:
    json.dump({"embedding_dim": embedding_dim}, f)

print(f"wrote {len(arrays)} tensors to {OUT_DIR}")
