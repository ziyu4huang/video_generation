"""Dump Whisper log-mel-spectrogram references for Swift parity testing.

First real, independently-verifiable step of the native Swift/MLX Whisper
port (swift/ltx-video-director/docs/TODO.md, PLAN.md Phase 3 — ASR gate
transcription currently bridges to mlx_whisper via `run.py video asr-gate`;
this begins closing that gap the same block-by-block, parity-verified way
every other component in this package was ported).

Uses the ACTUAL mlx_whisper.audio.log_mel_spectrogram (same function
python/mlx-movie-director's `_run_audio_asr_gate` transcription path runs
through internally) against a deterministic synthetic signal (sum of fixed
sinusoids, no RNG) so the fixture is reproducible without depending on any
external audio file. Dumps both n_mels=80 (whisper tiny/base/small/medium)
and n_mels=128 (whisper-large-v3 — the model this repo's Python bridge
actually uses) plus the mel filterbank matrices themselves, since the Swift
port embeds the SAME precomputed librosa filterbank mlx_whisper ships
(mel_filters.npz) rather than reimplementing librosa's mel-filter design.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_mel_reference.py
"""
import json
import os

import numpy as np
from safetensors.numpy import save_file

import mlx.core as mx
from mlx_whisper.audio import N_FFT, HOP_LENGTH, SAMPLE_RATE, log_mel_spectrogram, mel_filters

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_mel")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    duration_s = 0.5
    n_samples = int(SAMPLE_RATE * duration_s)
    t = np.arange(n_samples, dtype=np.float64) / SAMPLE_RATE
    # Deterministic multi-tone signal (no RNG) — representative of real
    # speech-band content (fundamental ~150Hz voice pitch + a few harmonics)
    # without needing a real audio file as input.
    signal = (
        0.5 * np.sin(2 * np.pi * 150.0 * t)
        + 0.3 * np.sin(2 * np.pi * 440.0 * t)
        + 0.15 * np.sin(2 * np.pi * 2000.0 * t)
        + 0.05 * np.sin(2 * np.pi * 5000.0 * t)
    ).astype(np.float32)

    audio = mx.array(signal)

    outputs = {"audio_input": signal}
    meta = {
        "sample_rate": SAMPLE_RATE, "n_fft": N_FFT, "hop_length": HOP_LENGTH,
        "duration_s": duration_s, "n_samples": n_samples,
    }

    for n_mels in (80, 128):
        mel_spec = log_mel_spectrogram(audio, n_mels=n_mels)
        mx.eval(mel_spec)
        outputs[f"log_mel_{n_mels}"] = np.array(mel_spec, copy=False)
        outputs[f"mel_filters_{n_mels}"] = np.array(mel_filters(n_mels), copy=False)
        meta[f"log_mel_{n_mels}_shape"] = list(mel_spec.shape)
        print(f"n_mels={n_mels} -> log_mel shape {mel_spec.shape}, filters shape {mel_filters(n_mels).shape}")

    save_file(outputs, os.path.join(OUT_DIR, "whisper_mel.safetensors"))
    with open(os.path.join(OUT_DIR, "whisper_mel.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("done ->", OUT_DIR)
