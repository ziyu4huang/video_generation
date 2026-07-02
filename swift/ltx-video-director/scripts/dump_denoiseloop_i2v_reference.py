"""Dump a REAL I2V-conditioned denoise_loop reference (non-uniform mask,
per-token timesteps) for Swift parity testing — closes the gap the
uniform-mask-only dump_denoiseloop_reference.py left open.

Uses the REAL denoise_loop + X0Model + LTXModel + VideoConditionByLatentIndex,
same small config as dump_denoiseloop_reference.py, but conditions frame 0
(making the mask non-uniform, forcing the reference's per-token-timestep
branch). Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_denoiseloop_i2v_reference.py
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

from ltx_core_mlx.conditioning.types.latent_cond import LatentState, VideoConditionByLatentIndex  # noqa: E402
from ltx_core_mlx.model.transformer.model import LTXModel, LTXModelConfig, X0Model  # noqa: E402
from ltx_pipelines_mlx.utils.samplers import denoise_loop  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "denoise_loop_i2v")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    config = LTXModelConfig(
        num_layers=1,
        video_dim=16, audio_dim=8,
        video_num_heads=2, audio_num_heads=2,
        video_head_dim=8, audio_head_dim=4,
        av_cross_num_heads=2, av_cross_head_dim=4,
        video_patch_channels=6, audio_patch_channels=5,
        ff_mult=4.0,
        timestep_embedding_dim=16,
        timestep_scale_multiplier=1000.0,
        av_ca_timestep_scale_multiplier=1.0,
        rope_theta=10000.0,
        positional_embedding_max_pos=(20, 64, 64),
        audio_positional_embedding_max_pos=(20,),
        norm_eps=1e-6,
    )
    model = LTXModel(config)
    key = mx.random.key(501)
    flat = mlx.utils.tree_flatten(model.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, (mx.random.normal(v.shape, key=sub) * 0.05).astype(v.dtype)))
    model.update(mlx.utils.tree_unflatten(new_flat))
    x0_model = X0Model(model)

    # I2V: F=3, H=W=2 (tokens_per_frame=4), condition frame 0.
    B, F, H, W, Na, Nt = 1, 3, 2, 2, 3, 2
    Nv = F * H * W
    tokens_per_frame = H * W

    key = mx.random.key(502)
    video_noise = mx.random.normal((B, Nv, config.video_patch_channels), key=mx.random.split(key)[1])
    audio_noise = mx.random.normal((B, Na, config.audio_patch_channels), key=mx.random.split(key)[1])
    clean_image = mx.random.normal((B, tokens_per_frame, config.video_patch_channels), key=mx.random.split(key)[1])
    video_text_embeds = mx.random.normal((B, Nt, config.video_dim), key=mx.random.split(key)[1])
    audio_text_embeds = mx.random.normal((B, Nt, config.audio_dim), key=mx.random.split(key)[1])
    video_positions = mx.zeros((B, Nv, 3), dtype=mx.int32)
    audio_positions = mx.zeros((B, Na, 1), dtype=mx.int32)

    video_state0 = LatentState(
        latent=video_noise, clean_latent=video_noise,
        denoise_mask=mx.ones((B, Nv, 1)), positions=video_positions)
    conditioner = VideoConditionByLatentIndex(frame_indices=[0], clean_latent=clean_image, strength=1.0)
    video_state = conditioner.apply(video_state0, (F, H, W))
    audio_state = LatentState(
        latent=audio_noise, clean_latent=audio_noise,
        denoise_mask=mx.ones((B, Na, 1)), positions=audio_positions)

    sigmas = [1.0, 0.5, 0.0]

    result = denoise_loop(
        x0_model, video_state, audio_state,
        video_text_embeds, audio_text_embeds,
        sigmas=sigmas, show_progress=False,
    )
    mx.eval(result.video_latent, result.audio_latent)

    weights_out = {k: np.array(v.astype(mx.float32), copy=False) for k, v in mlx.utils.tree_flatten(model.parameters())}
    inputs = {
        "video_noise": video_noise, "audio_noise": audio_noise, "clean_image": clean_image,
        "video_text_embeds": video_text_embeds, "audio_text_embeds": audio_text_embeds,
        "video_positions": video_positions, "audio_positions": audio_positions,
    }
    for k, v in inputs.items():
        weights_out[k] = np.array(v, copy=False)
    weights_out["video_output"] = np.array(result.video_latent.astype(mx.float32), copy=False)
    weights_out["audio_output"] = np.array(result.audio_latent.astype(mx.float32), copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "loop_i2v.safetensors"))

    meta = {
        "sigmas": sigmas, "B": B, "F": F, "H": H, "W": W, "tokens_per_frame": tokens_per_frame,
        "video_output_shape": list(result.video_latent.shape), "audio_output_shape": list(result.audio_latent.shape),
    }
    with open(os.path.join(OUT_DIR, "loop_i2v.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("video_out", result.video_latent.shape, "audio_out", result.audio_latent.shape)
    print("frame0 preserved:", bool(mx.allclose(result.video_latent[:, :tokens_per_frame, :], clean_image).item()))
    print("done ->", OUT_DIR)
