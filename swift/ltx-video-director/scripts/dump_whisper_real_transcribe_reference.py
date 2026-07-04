"""Dump a REAL end-to-end (full 32-layer encoder+decoder) greedy-decode
reference for WhisperModelRealCheckpointTests' native Swift transcribe().

Runs the ACTUAL mlx_whisper.whisper.Whisper class (all 32+32 real layers,
real large-v3-mlx weights) with the SAME naive greedy decode (no beam
search, no temperature-fallback retries, no timestamp/no-speech logit
filters beyond SuppressBlank at step 0) this port's WhisperModel.transcribe
implements — this is deliberately NOT mlx_whisper's polished transcribe()
wrapper (which retries at multiple temperatures and would produce a
different, more accurate result for this short/ambiguous clip); this dumps
what naive greedy ACTUALLY produces, since that's what an apples-to-apples
parity check needs. See WhisperModel.swift's header for why this port
doesn't implement the fuller decode strategy (yet).

Run from repo root (requires the large-v3-mlx checkpoint + ffmpeg):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_real_transcribe_reference.py
"""
import json
import os

import mlx.core as mx
import mlx.utils
import numpy as np

from mlx_whisper.audio import load_audio, log_mel_spectrogram, pad_or_trim, N_SAMPLES
from mlx_whisper.whisper import Whisper, ModelDimensions
from mlx_whisper.tokenizer import get_tokenizer

CHECKPOINT_DIR = os.path.expanduser(
    "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/"
    "snapshots/49e6aa286ad60c14352c404340ded53710378a11"
)
VIDEO = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_072817/output_20260702_072848.mp4"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_real_transcribe")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    audio = load_audio(VIDEO)
    audio = pad_or_trim(audio, N_SAMPLES)
    mel = log_mel_spectrogram(audio, n_mels=128)[None]

    with open(os.path.join(CHECKPOINT_DIR, "config.json")) as f:
        cfg = json.load(f)
    cfg.pop("model_type", None)
    dims = ModelDimensions(**cfg)
    model = Whisper(dims, dtype=mx.float32)
    weights = {k: v.astype(mx.float32) for k, v in mx.load(os.path.join(CHECKPOINT_DIR, "weights.npz")).items()}
    model.update(mlx.utils.tree_unflatten(list(weights.items())))
    mx.eval(model.parameters())

    # num_languages=model.num_languages (100 for this checkpoint), not the
    # tokenizer module's bare default of 99 — see
    # WhisperTokenizer.languageCodesInOrder's header for why that matters.
    tok = get_tokenizer(multilingual=True, num_languages=model.num_languages, language="zh", task="transcribe")
    ids = list(tok.sot_sequence_including_notimestamps)
    prompt_len = len(ids)

    audio_features = model.encoder(mel)
    for step in range(32):
        tokens = mx.array(ids)[None]
        logits, _, _ = model.decoder(tokens, audio_features)
        last = logits[0, -1]
        if step == 0:
            mask = np.zeros(last.shape[-1], dtype=np.float32)
            mask[tok.eot] = -np.inf
            mask[220] = -np.inf
            last = last + mx.array(mask)
        nxt = int(mx.argmax(last).item())
        if nxt == tok.eot:
            break
        ids.append(nxt)

    generated = ids[prompt_len:]
    text = tok.decode(generated)
    print("generated ids", generated)
    print("decoded:", repr(text))

    meta = {
        "video": VIDEO, "language": "zh", "sot_sequence": ids[:prompt_len],
        "generated_ids": generated, "text": text,
    }
    with open(os.path.join(OUT_DIR, "whisper_real_transcribe.json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print("done ->", OUT_DIR)
