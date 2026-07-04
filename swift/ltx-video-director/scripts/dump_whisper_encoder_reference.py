"""Dump a small Whisper AudioEncoder reference for Swift parity testing.

Instantiates the REAL mlx_whisper.whisper.AudioEncoder/ResidualAttentionBlock/
MultiHeadAttention classes (not a reimplementation) at a small config (few
layers/heads/state) with fixed random weights, so the fixture stays tiny
(no large-v3 checkpoint download/commit needed — see this script's sibling
dump_whisper_mel_reference.py for why: same "verify the real architecture,
not the pretrained weights" split this repo already uses for
dump_timestep_embedding_reference.py). Whichever real checkpoint is loaded
later (e.g. whisper-large-v3-mlx) just changes n_state/n_head/n_layer/n_ctx
and the weight VALUES — WhisperEncoder.swift's math is unaffected.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_encoder_reference.py
"""
import json
import os

import mlx.core as mx
import mlx.utils
import numpy as np
from safetensors.numpy import save_file

from mlx_whisper.whisper import AudioEncoder

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_encoder")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    n_mels, n_ctx, n_state, n_head, n_layer = 16, 6, 32, 4, 2

    encoder = AudioEncoder(n_mels, n_ctx, n_state, n_head, n_layer, dtype=mx.float32)

    # Randomize all weights (small, fixed seed) — real large-v3 dims are
    # (128, 1500, 1280, 20, 32); this config keeps the fixture tiny while
    # exercising the exact same module classes/math.
    key = mx.random.key(7)
    flat = mlx.utils.tree_flatten(encoder.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub).astype(mx.float32) * 0.1))
    encoder.update(mlx.utils.tree_unflatten(new_flat))

    # n_ctx audio frames after the stride-2 conv2 means conv1 sees 2*n_ctx
    # mel frames (conv2's stride halves the frame count) — matches the
    # assertion `x.shape[1:] == self._positional_embedding.shape` in
    # AudioEncoder.__call__.
    n_frames_in = n_ctx * 2
    key, sub = mx.random.split(key)
    mel_input = mx.random.normal((1, n_frames_in, n_mels), key=sub).astype(mx.float32)

    output = encoder(mel_input)
    mx.eval(output)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(encoder.parameters())}
    weights_out["mel_input"] = np.array(mel_input, copy=False)
    weights_out["encoder_output"] = np.array(output, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "whisper_encoder.safetensors"))

    meta = {
        "n_mels": n_mels, "n_ctx": n_ctx, "n_state": n_state, "n_head": n_head, "n_layer": n_layer,
        "mel_input_shape": list(mel_input.shape),
        "encoder_output_shape": list(output.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(encoder.parameters())],
    }
    with open(os.path.join(OUT_DIR, "whisper_encoder.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("mel_input", mel_input.shape, "-> encoder_output", output.shape)
    print("weight_keys:", meta["weight_keys"])
    print("done ->", OUT_DIR)
