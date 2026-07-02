"""Dump a full denoise_loop forward-pass reference for Swift parity testing.

Uses the REAL ltx_pipelines_mlx.utils.samplers.denoise_loop function with a
REAL X0Model wrapping a small LTXModel (2 layers, small dims — same config
as dump_ltxmodel_reference.py), a uniform (all-ones) denoise mask (full
generation, no partial conditioning — matches DenoiseLoop.swift's scope),
and a short 3-step sigma schedule. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_denoiseloop_reference.py
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
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-pipelines-mlx/src"))

from ltx_core_mlx.conditioning.types.latent_cond import LatentState  # noqa: E402
from ltx_core_mlx.model.transformer.model import LTXModel, LTXModelConfig, X0Model  # noqa: E402
from ltx_pipelines_mlx.utils.samplers import denoise_loop  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "denoise_loop")
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
    key = mx.random.key(301)
    flat = mlx.utils.tree_flatten(model.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, (mx.random.normal(v.shape, key=sub) * 0.05).astype(v.dtype)))
    model.update(mlx.utils.tree_unflatten(new_flat))
    x0_model = X0Model(model)

    B, Nv, Na, Nt = 1, 4, 3, 4
    key = mx.random.key(302)
    video_noise = mx.random.normal((B, Nv, config.video_patch_channels), key=mx.random.split(key)[1])
    audio_noise = mx.random.normal((B, Na, config.audio_patch_channels), key=mx.random.split(key)[1])
    video_text_embeds = mx.random.normal((B, Nt, config.video_dim), key=mx.random.split(key)[1])
    audio_text_embeds = mx.random.normal((B, Nt, config.audio_dim), key=mx.random.split(key)[1])

    max_pos_v = list(config.positional_embedding_max_pos)
    vpos_key = mx.random.key(303)
    video_positions = mx.stack([
        mx.random.randint(0, max_pos_v[i], (B, Nv), key=mx.random.split(vpos_key)[1]) for i in range(3)
    ], axis=-1).astype(mx.int32)
    max_pos_a = list(config.audio_positional_embedding_max_pos)
    apos_key = mx.random.key(304)
    audio_positions = mx.random.randint(0, max_pos_a[0], (B, Na, 1), key=apos_key).astype(mx.int32)

    video_state = LatentState(
        latent=video_noise, clean_latent=video_noise,
        denoise_mask=mx.ones((B, Nv, 1)), positions=video_positions)
    audio_state = LatentState(
        latent=audio_noise, clean_latent=audio_noise,
        denoise_mask=mx.ones((B, Na, 1)), positions=audio_positions)

    sigmas = [1.0, 0.6, 0.25, 0.0]

    result = denoise_loop(
        x0_model, video_state, audio_state,
        video_text_embeds, audio_text_embeds,
        sigmas=sigmas, show_progress=False,
    )
    mx.eval(result.video_latent, result.audio_latent)

    weights_out = {k: np.array(v.astype(mx.float32), copy=False) for k, v in mlx.utils.tree_flatten(model.parameters())}
    inputs = {
        "video_noise": video_noise, "audio_noise": audio_noise,
        "video_text_embeds": video_text_embeds, "audio_text_embeds": audio_text_embeds,
        "video_positions": video_positions, "audio_positions": audio_positions,
    }
    for k, v in inputs.items():
        weights_out[k] = np.array(v, copy=False)
    weights_out["video_output"] = np.array(result.video_latent.astype(mx.float32), copy=False)
    weights_out["audio_output"] = np.array(result.audio_latent.astype(mx.float32), copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "loop.safetensors"))

    meta = {
        "sigmas": sigmas,
        "config": {
            "num_layers": config.num_layers, "video_dim": config.video_dim, "audio_dim": config.audio_dim,
            "video_num_heads": config.video_num_heads, "audio_num_heads": config.audio_num_heads,
            "video_head_dim": config.video_head_dim, "audio_head_dim": config.audio_head_dim,
            "av_cross_num_heads": config.av_cross_num_heads, "av_cross_head_dim": config.av_cross_head_dim,
            "video_patch_channels": config.video_patch_channels, "audio_patch_channels": config.audio_patch_channels,
            "timestep_embedding_dim": config.timestep_embedding_dim,
        },
        "video_output_shape": list(result.video_latent.shape), "audio_output_shape": list(result.audio_latent.shape),
    }
    with open(os.path.join(OUT_DIR, "loop.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("video_out", result.video_latent.shape, "audio_out", result.audio_latent.shape)
    print("done ->", OUT_DIR)
