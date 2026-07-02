"""Dump BasicAVTransformerBlock forward-pass reference for Swift parity testing.

Uses the SAME ltx_core_mlx.model.transformer.transformer.BasicAVTransformerBlock
class this project's Python MLX pipeline runs (real block architecture,
small dims for a fast test, no STG perturbations). Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_basicavblock_reference.py
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

from ltx_core_mlx.model.transformer.transformer import BasicAVTransformerBlock  # noqa: E402
from ltx_core_mlx.model.transformer.rope import precompute_rope_freqs  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "basic_av_block")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    video_dim, audio_dim = 32, 16
    video_num_heads, audio_num_heads, av_cross_num_heads = 4, 4, 4
    video_head_dim, audio_head_dim, av_cross_head_dim = 8, 4, 4

    block = BasicAVTransformerBlock(
        video_dim=video_dim, audio_dim=audio_dim,
        video_num_heads=video_num_heads, audio_num_heads=audio_num_heads,
        video_head_dim=video_head_dim, audio_head_dim=audio_head_dim,
        av_cross_num_heads=av_cross_num_heads, av_cross_head_dim=av_cross_head_dim,
    )
    key = mx.random.key(111)
    flat = mlx.utils.tree_flatten(block.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.05))
    block.update(mlx.utils.tree_unflatten(new_flat))

    B, Nv, Na, Nt = 2, 5, 3, 4
    key = mx.random.key(112)
    video_hidden = mx.random.normal((B, Nv, video_dim), key=mx.random.split(key)[1])
    audio_hidden = mx.random.normal((B, Na, audio_dim), key=mx.random.split(key)[1])
    video_text_embeds = mx.random.normal((B, Nt, video_dim), key=mx.random.split(key)[1])
    audio_text_embeds = mx.random.normal((B, Nt, audio_dim), key=mx.random.split(key)[1])

    video_adaln_params = mx.random.normal((B, 9 * video_dim), key=mx.random.split(key)[1]) * 0.1
    audio_adaln_params = mx.random.normal((B, 9 * audio_dim), key=mx.random.split(key)[1]) * 0.1
    video_prompt_adaln_params = mx.random.normal((B, 2 * video_dim), key=mx.random.split(key)[1]) * 0.1
    audio_prompt_adaln_params = mx.random.normal((B, 2 * audio_dim), key=mx.random.split(key)[1]) * 0.1
    av_ca_video_params = mx.random.normal((B, 4 * video_dim), key=mx.random.split(key)[1]) * 0.1
    av_ca_audio_params = mx.random.normal((B, 4 * audio_dim), key=mx.random.split(key)[1]) * 0.1
    av_ca_a2v_gate_params = mx.random.normal((B, video_dim), key=mx.random.split(key)[1]) * 0.1
    av_ca_v2a_gate_params = mx.random.normal((B, audio_dim), key=mx.random.split(key)[1]) * 0.1

    # Video RoPE: 3 position dims. Audio/cross RoPE: 1 position dim (temporal).
    max_pos_v = [20, 64, 64]
    vpos_key = mx.random.key(113)
    video_positions = mx.stack([
        mx.random.randint(0, max_pos_v[i], (B, Nv), key=mx.random.split(vpos_key)[1]) for i in range(3)
    ], axis=-1).astype(mx.int32)
    video_rope = precompute_rope_freqs(video_positions, inner_dim=video_head_dim * video_num_heads,
                                        num_heads=video_num_heads, max_pos=max_pos_v, rope_type="split")

    max_pos_a = [20]
    apos_key = mx.random.key(114)
    audio_positions = mx.random.randint(0, max_pos_a[0], (B, Na, 1), key=apos_key).astype(mx.int32)
    audio_rope = precompute_rope_freqs(audio_positions, inner_dim=audio_head_dim * audio_num_heads,
                                        num_heads=audio_num_heads, max_pos=max_pos_a, rope_type="split")

    # Cross RoPE: video cross uses av_cross_num_heads/head_dim, 1D positions per side.
    video_cross_positions = video_positions[:, :, :1]  # take temporal only, (B, Nv, 1)
    video_cross_rope = precompute_rope_freqs(video_cross_positions, inner_dim=av_cross_head_dim * av_cross_num_heads,
                                              num_heads=av_cross_num_heads, max_pos=[max_pos_v[0]], rope_type="split")
    audio_cross_rope = precompute_rope_freqs(audio_positions, inner_dim=av_cross_head_dim * av_cross_num_heads,
                                              num_heads=av_cross_num_heads, max_pos=max_pos_a, rope_type="split")

    video_out, audio_out = block(
        video_hidden, audio_hidden,
        video_adaln_params, audio_adaln_params,
        video_prompt_adaln_params, audio_prompt_adaln_params,
        av_ca_video_params, av_ca_audio_params,
        av_ca_a2v_gate_params, av_ca_v2a_gate_params,
        video_text_embeds=video_text_embeds, audio_text_embeds=audio_text_embeds,
        video_rope_freqs=video_rope, audio_rope_freqs=audio_rope,
        video_cross_rope_freqs=video_cross_rope, audio_cross_rope_freqs=audio_cross_rope,
    )
    mx.eval(video_out, audio_out)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(block.parameters())}
    inputs = {
        "video_hidden": video_hidden, "audio_hidden": audio_hidden,
        "video_text_embeds": video_text_embeds, "audio_text_embeds": audio_text_embeds,
        "video_adaln_params": video_adaln_params, "audio_adaln_params": audio_adaln_params,
        "video_prompt_adaln_params": video_prompt_adaln_params, "audio_prompt_adaln_params": audio_prompt_adaln_params,
        "av_ca_video_params": av_ca_video_params, "av_ca_audio_params": av_ca_audio_params,
        "av_ca_a2v_gate_params": av_ca_a2v_gate_params, "av_ca_v2a_gate_params": av_ca_v2a_gate_params,
        "video_rope_cos": video_rope[0], "video_rope_sin": video_rope[1],
        "audio_rope_cos": audio_rope[0], "audio_rope_sin": audio_rope[1],
        "video_cross_rope_cos": video_cross_rope[0], "video_cross_rope_sin": video_cross_rope[1],
        "audio_cross_rope_cos": audio_cross_rope[0], "audio_cross_rope_sin": audio_cross_rope[1],
    }
    for k, v in inputs.items():
        weights_out[k] = np.array(v, copy=False)
    weights_out["video_output"] = np.array(video_out, copy=False)
    weights_out["audio_output"] = np.array(audio_out, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "block.safetensors"))

    meta = {
        "video_dim": video_dim, "audio_dim": audio_dim,
        "video_num_heads": video_num_heads, "audio_num_heads": audio_num_heads,
        "video_head_dim": video_head_dim, "audio_head_dim": audio_head_dim,
        "av_cross_num_heads": av_cross_num_heads, "av_cross_head_dim": av_cross_head_dim,
        "video_output_shape": list(video_out.shape), "audio_output_shape": list(audio_out.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(block.parameters())],
    }
    with open(os.path.join(OUT_DIR, "block.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("video_out", video_out.shape, "audio_out", audio_out.shape)
    print("weight_keys", meta["weight_keys"])
    print("done ->", OUT_DIR)
