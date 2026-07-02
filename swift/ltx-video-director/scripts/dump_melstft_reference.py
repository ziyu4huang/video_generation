"""Dump MelSTFT references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.audio_vae.bwe.MelSTFT class this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_melstft_reference.py
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

from ltx_core_mlx.model.audio_vae.bwe import MelSTFT  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "melstft")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    n_fft, hop_length, n_mels = 512, 80, 64
    stft = MelSTFT(n_fft=n_fft, hop_length=hop_length, n_mels=n_mels)

    key = mx.random.key(1401)
    # mel_basis: realistic-scale small values (a real mel filterbank is
    # sparse and normalized, not large-magnitude noise).
    key, sub = mx.random.split(key)
    stft.mel_basis = mx.abs(mx.random.normal(stft.mel_basis.shape, key=sub)) * 0.05
    key, sub = mx.random.split(key)
    stft.stft_fn.forward_basis = mx.random.normal(stft.stft_fn.forward_basis.shape, key=sub) * 0.1

    waveform = mx.random.normal((1, 2000), key=mx.random.key(1402)) * 0.3
    mel = stft(waveform)
    mx.eval(mel)

    save_file({
        "mel_basis": np.array(stft.mel_basis, copy=False),
        "forward_basis": np.array(stft.stft_fn.forward_basis, copy=False),
        "waveform": np.array(waveform, copy=False),
        "output": np.array(mel, copy=False),
    }, os.path.join(OUT_DIR, "melstft.safetensors"))
    meta = {
        "n_fft": n_fft, "hop_length": hop_length, "n_mels": n_mels,
        "waveform_shape": list(waveform.shape), "output_shape": list(mel.shape),
    }
    with open(os.path.join(OUT_DIR, "melstft.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("waveform", waveform.shape, "-> mel", mel.shape)
    print("done ->", OUT_DIR)
