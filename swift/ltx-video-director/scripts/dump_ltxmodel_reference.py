"""Dump a full LTXModel forward-pass reference for Swift parity testing.

Uses the REAL ltx_core_mlx.model.transformer.model.LTXModel class (real
architecture wiring: patchify -> 8 top-level AdaLN modules -> N transformer
blocks -> output block), with a small config (2 layers, small dims) so the
reference file stays fast/small, fixed-seed random weights, tiny inputs.
Scope matches LTXModel.swift: scalar timestep only (no per-token timesteps,
no STG perturbations, no block streaming/TeaCache/tap).

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_ltxmodel_reference.py
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

from ltx_core_mlx.model.transformer.model import LTXModel, LTXModelConfig  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "ltx_model")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    config = LTXModelConfig(
        num_layers=2,
        video_dim=32, audio_dim=16,
        video_num_heads=4, audio_num_heads=4,
        video_head_dim=8, audio_head_dim=4,
        av_cross_num_heads=4, av_cross_head_dim=4,
        video_patch_channels=6, audio_patch_channels=5,
        ff_mult=4.0,
        timestep_embedding_dim=32,
        timestep_scale_multiplier=1000.0,
        av_ca_timestep_scale_multiplier=1.0,
        rope_theta=10000.0,
        positional_embedding_max_pos=(20, 64, 64),
        audio_positional_embedding_max_pos=(20,),
        norm_eps=1e-6,
    )
    model = LTXModel(config)

    # IMPORTANT: cast weights to float32 (not the default bf16 init dtype
    # variance) is not needed here -- MLX defaults to float32 params unless
    # explicitly cast. We keep everything float32 for a clean numeric
    # comparison (the real pipeline casts activations to bf16 internally
    # for memory; that's a precision/perf concern, not a correctness one,
    # and would just add noise to this parity check).
    key = mx.random.key(121)
    flat = mlx.utils.tree_flatten(model.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, (mx.random.normal(v.shape, key=sub) * 0.05).astype(v.dtype)))
    model.update(mlx.utils.tree_unflatten(new_flat))

    B, Nv, Na, Nt = 2, 5, 3, 4
    key = mx.random.key(122)
    video_latent = mx.random.normal((B, Nv, config.video_patch_channels), key=mx.random.split(key)[1])
    audio_latent = mx.random.normal((B, Na, config.audio_patch_channels), key=mx.random.split(key)[1])
    video_text_embeds = mx.random.normal((B, Nt, config.video_dim), key=mx.random.split(key)[1])
    audio_text_embeds = mx.random.normal((B, Nt, config.audio_dim), key=mx.random.split(key)[1])
    timestep = mx.array([0.3, 0.7])

    max_pos_v = list(config.positional_embedding_max_pos)
    vpos_key = mx.random.key(123)
    video_positions = mx.stack([
        mx.random.randint(0, max_pos_v[i], (B, Nv), key=mx.random.split(vpos_key)[1]) for i in range(3)
    ], axis=-1).astype(mx.int32)

    max_pos_a = list(config.audio_positional_embedding_max_pos)
    apos_key = mx.random.key(124)
    audio_positions = mx.random.randint(0, max_pos_a[0], (B, Na, 1), key=apos_key).astype(mx.int32)

    video_out, audio_out = model(
        video_latent, audio_latent, timestep,
        video_text_embeds=video_text_embeds, audio_text_embeds=audio_text_embeds,
        video_positions=video_positions, audio_positions=audio_positions,
    )
    mx.eval(video_out, audio_out)

    weights_out = {k: np.array(v.astype(mx.float32), copy=False) for k, v in mlx.utils.tree_flatten(model.parameters())}
    inputs = {
        "video_latent": video_latent, "audio_latent": audio_latent, "timestep": timestep,
        "video_text_embeds": video_text_embeds, "audio_text_embeds": audio_text_embeds,
        "video_positions": video_positions, "audio_positions": audio_positions,
    }
    for k, v in inputs.items():
        weights_out[k] = np.array(v, copy=False)
    weights_out["video_output"] = np.array(video_out.astype(mx.float32), copy=False)
    weights_out["audio_output"] = np.array(audio_out.astype(mx.float32), copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "model.safetensors"))

    meta = {
        "config": {
            "num_layers": config.num_layers, "video_dim": config.video_dim, "audio_dim": config.audio_dim,
            "video_num_heads": config.video_num_heads, "audio_num_heads": config.audio_num_heads,
            "video_head_dim": config.video_head_dim, "audio_head_dim": config.audio_head_dim,
            "av_cross_num_heads": config.av_cross_num_heads, "av_cross_head_dim": config.av_cross_head_dim,
            "video_patch_channels": config.video_patch_channels, "audio_patch_channels": config.audio_patch_channels,
            "timestep_embedding_dim": config.timestep_embedding_dim,
        },
        "video_output_shape": list(video_out.shape), "audio_output_shape": list(audio_out.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(model.parameters())],
    }
    with open(os.path.join(OUT_DIR, "model.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("video_out", video_out.shape, "audio_out", audio_out.shape)
    print("done ->", OUT_DIR)
