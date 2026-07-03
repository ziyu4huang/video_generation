"""Dump AudioVAEEncoder reference (REAL checkpoint) for Swift parity testing.

Loads the actual production mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors
weights into the REAL vendor
ltx_core_mlx.model.audio_vae.encoder.AudioVAEEncoder, runs a synthetic mel
spectrogram through `.encode()`, and dumps input/output so
AudioVAEEncoderLoader.loadReal + AudioVAEEncoder.swift can be diffed against
it directly (not just checked for finite output) — same bar as the LoRA
fusion and FFLF real-checkpoint work this session already did.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_audio_vae_encoder_reference.py
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

from ltx_core_mlx.model.audio_vae.encoder import AudioVAEEncoder  # noqa: E402

CHECKPOINT = os.path.join(REPO_ROOT, "mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "audio_vae_encoder")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    if not os.path.exists(CHECKPOINT):
        print(f"checkpoint not found at {CHECKPOINT} — skipping dump")
        sys.exit(0)

    raw = mx.load(CHECKPOINT)
    encoder = AudioVAEEncoder()

    import mlx.utils

    flat_params = mlx.utils.tree_flatten(encoder.parameters())
    new_flat = []
    missing = []
    for k, _ in flat_params:
        if k.startswith("per_channel_statistics."):
            continue  # handled separately below (checkpoint keys are underscore-prefixed)
        src_key = f"audio_vae.encoder.{k}"
        if src_key in raw:
            new_flat.append((k, raw[src_key].astype(mx.float32)))
        else:
            missing.append(src_key)
    if missing:
        raise RuntimeError(f"missing keys in checkpoint: {missing[:5]} (of {len(missing)})")
    encoder.update(mlx.utils.tree_unflatten(new_flat))

    mean_of_means = raw["audio_vae.per_channel_statistics._mean_of_means"].astype(mx.float32)
    std_of_means = raw["audio_vae.per_channel_statistics._std_of_means"].astype(mx.float32)
    encoder.per_channel_statistics.mean_of_means = mean_of_means
    encoder.per_channel_statistics.std_of_means = std_of_means

    # Synthetic mel input: (1, 2, T', 64) — small T' for a fast, deterministic
    # forward pass. Values in a mel-log-magnitude-ish range (not silence).
    mx.random.seed(123)
    mel = mx.random.normal((1, 2, 32, 64), key=mx.random.key(123)) * 2.0 - 4.0
    latent = encoder.encode(mel)
    mx.eval(latent)

    out = {
        "mel_input": np.array(mel, copy=False),
        "latent_output": np.array(latent, copy=False),
    }
    save_file(out, os.path.join(OUT_DIR, "audio_vae_encoder.safetensors"))
    meta = {
        "mel_shape": list(mel.shape), "latent_shape": list(latent.shape),
        "checkpoint": os.path.relpath(CHECKPOINT, REPO_ROOT),
    }
    with open(os.path.join(OUT_DIR, "audio_vae_encoder.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"mel {mel.shape} -> latent {tuple(latent.shape)}")
    print("done ->", OUT_DIR)
