#!/usr/bin/env python3
"""Generate EnCodec 32kHz decode reference for Swift port verification
(Task 5 of docs/superpowers/plans/2026-07-28-musicgen-swift-native-port.md).

Decodes a fixed set of known codebook indices through the real HF EnCodec
model and saves the resulting waveform. The Swift port
(MusicGenEncodecAdapter, loaded from the flat `audio_encoder.safetensors`
produced by `run.py import-musicgen`, see Task 2) decodes the SAME indices
and compares (cosine on the waveform).

Unlike the plan draft, this does NOT download a separate `facebook/
encodec_32khz` snapshot. `facebook/musicgen-small`'s HF wrapper
(`MusicgenForConditionalGeneration`) already bundles its own `.audio_encoder`
submodule -- a real `EncodecModel` instance built from the exact same nested
`audio_encoder` sub-config that `run.py import-musicgen` split out into
`audio_encoder_config.json`/`audio_encoder.safetensors` in Task 2. Using it
directly guarantees the reference is decoded with the EXACT SAME weights the
Swift side loads (not just "should be the same" weights from a separately
resolved repo), and needs zero extra network egress since musicgen-small is
already cached locally (confirmed: `gen_musicgen_t5_ref.py`, Task 3, already
loads the same full model for its own text-encoder reference).

Confirmed directly against the real model: `ae.config.upsampling_ratios ==
[8, 5, 4, 4]`, `ae.config.sampling_rate == 32000`, `ae.config.codebook_size
== 2048`, `ae.config.target_bandwidths == [2.2]` -- matching
audio_encoder_config.json exactly. `ae.decode(codes, [None])` returns an
`EncodecDecoderOutput` whose `.audio_values` has shape (batch=1, channels=1,
samples) -- PyTorch channels-first convention. The Swift
`MusicGenEncodecAdapter.decode` returns MLX's native channels-last (batch,
samples, channels) instead (confirmed from mlx-audio-swift's own conv
layers, which operate NLC) -- both are flattened to a plain 1-D waveform
before comparison, so the axis-order difference is a non-issue.

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py
"""
from pathlib import Path

import numpy as np
import torch
from transformers import MusicgenForConditionalGeneration

REPO = Path(__file__).resolve().parents[4]
OUT_DIR = REPO / "swift" / "musicgen-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "facebook/musicgen-small"

full_model = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
audio_encoder = full_model.audio_encoder
audio_encoder.eval()

print(f"audio_encoder config: upsampling_ratios={audio_encoder.config.upsampling_ratios} "
      f"sampling_rate={audio_encoder.config.sampling_rate} "
      f"codebook_size={audio_encoder.config.codebook_size} "
      f"target_bandwidths={audio_encoder.config.target_bandwidths}")

# Fixed, deterministic codebook indices -- 4 codebooks (musicgen-small's real
# bandwidth 2.2 -> 4 quantizers, confirmed above), 100 frames (2s @ 50Hz),
# derived from a simple seeded PRNG so the Swift side can reproduce them
# exactly without needing numpy (see VerifyEncodecCommand.swift).
rng = np.random.default_rng(1234)
codes_np = rng.integers(0, 2048, size=(1, 1, 4, 100)).astype(np.int64)
codes = torch.from_numpy(codes_np)

with torch.no_grad():
    decoded = audio_encoder.decode(codes, [None])
    audio = decoded.audio_values   # (1, 1, samples) -- PyTorch channels-first

print(f"decoded waveform: {tuple(audio.shape)}")

import mlx.core as mx
ref = {
    "codes": mx.array(codes_np.squeeze(0).squeeze(0)).astype(mx.int32),   # (4, 100)
    "waveform": mx.array(audio.numpy().reshape(-1)).astype(mx.float32),   # (samples,)
}
out_path = OUT_DIR / "musicgen_encodec_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"Saved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
