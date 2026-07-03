"""Dump AudioProcessor (mel spectrogram DSP) reference for Swift parity testing.

Uses the REAL vendor ltx_core_mlx.model.audio_vae.processor.AudioProcessor
class (STFT + Slaney mel filterbank, no learned weights) against a synthetic
multi-tone waveform, so AudioProcessor.swift's waveformToMel can be diffed
against the actual reference implementation bit-for-bit (mod float
precision), not just structurally.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_audio_processor_reference.py
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

from ltx_core_mlx.model.audio_vae.processor import AudioProcessor  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "audio_processor")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    sample_rate = 16000
    duration_s = 0.25
    t = np.arange(int(sample_rate * duration_s), dtype=np.float64) / sample_rate
    # Two-tone stereo signal (440Hz + 1200Hz on ch0, 220Hz + 900Hz on ch1) —
    # exercises multiple mel bands, not silence/DC.
    ch0 = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 1200 * t)
    ch1 = 0.4 * np.sin(2 * np.pi * 220 * t) + 0.15 * np.sin(2 * np.pi * 900 * t)
    waveform_np = np.stack([ch0, ch1], axis=0).astype(np.float32)  # (2, T)

    processor = AudioProcessor(sample_rate=sample_rate, n_fft=1024, hop_length=160, n_mels=64)
    waveform = mx.array(waveform_np)
    mel = processor.waveform_to_mel(waveform)
    mx.eval(mel)

    out = {
        "waveform": waveform_np,
        "mel": np.array(mel, copy=False),
        "mel_basis": np.array(processor.mel_basis, copy=False),
        "window": np.array(processor.window, copy=False),
    }
    save_file(out, os.path.join(OUT_DIR, "audio_processor.safetensors"))
    meta = {
        "sample_rate": sample_rate, "n_fft": 1024, "hop_length": 160, "n_mels": 64,
        "waveform_shape": list(waveform_np.shape), "mel_shape": list(mel.shape),
    }
    with open(os.path.join(OUT_DIR, "audio_processor.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"waveform {waveform_np.shape} -> mel {tuple(mel.shape)}")
    print("done ->", OUT_DIR)
