"""Dump a REAL `mlx_whisper.decoding.DecodingTask` reference (temperature
fallback, SuppressBlank+SuppressTokens+ApplyTimestampRules, real
avg_logprob/no_speech_prob/compression_ratio) for
WhisperModelRealCheckpointTests' `transcribeWithFallback` parity check.

Unlike dump_whisper_real_transcribe_reference.py (which dumps the NAIVE
notimestamps-forced greedy decode this port's plain `WhisperModel.transcribe`
implements), this dumps the REAL `mlx_whisper.transcribe()` decode path:
timestamps-allowed SOT sequence + the full logit-filter stack + the
temperature-fallback retry loop `decode_with_fallback` implements. This is
what `WhisperModel.transcribeWithFallback` ports and must match.

Run from repo root (requires the large-v3-mlx checkpoint + ffmpeg):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_decode_with_fallback_reference.py
"""
import json
import os
import subprocess

import mlx.core as mx
from mlx_whisper.decoding import DecodingOptions, DecodingTask
from mlx_whisper.audio import load_audio, log_mel_spectrogram, pad_or_trim, N_SAMPLES
from mlx_whisper.whisper import Whisper, ModelDimensions
import mlx.utils

CHECKPOINT_DIR = os.path.expanduser(
    "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/"
    "snapshots/49e6aa286ad60c14352c404340ded53710378a11"
)
VIDEO = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_072817/output_20260702_072848.mp4"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_decode_with_fallback")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    wav_path = "/tmp/whisper_decode_with_fallback_ref.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", VIDEO, "-vn", "-ar", "16000", "-ac", "1", wav_path],
        capture_output=True, check=True,
    )

    audio = load_audio(wav_path)
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

    temperatures = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
    decode_result = None
    landed_temperature = None
    for t in temperatures:
        options = DecodingOptions(language="zh", temperature=t, fp16=False)
        decode_result = DecodingTask(model, options).run(mel)[0]
        needs_fallback = False
        if decode_result.compression_ratio > 2.4:
            needs_fallback = True
        if decode_result.avg_logprob < -1.0:
            needs_fallback = True
        if decode_result.no_speech_prob > 0.6:
            needs_fallback = False
        landed_temperature = t
        if not needs_fallback:
            break

    print("landed temperature:", landed_temperature)
    print("text:", repr(decode_result.text))
    print("tokens:", decode_result.tokens)
    print("avg_logprob:", decode_result.avg_logprob)
    print("no_speech_prob:", decode_result.no_speech_prob)
    print("compression_ratio:", decode_result.compression_ratio)

    meta = {
        "video": VIDEO,
        "language": "zh",
        "landed_temperature": landed_temperature,
        "text": decode_result.text,
        "tokens": decode_result.tokens,
        "avg_logprob": decode_result.avg_logprob,
        "no_speech_prob": decode_result.no_speech_prob,
        "compression_ratio": decode_result.compression_ratio,
    }
    out_path = os.path.join(OUT_DIR, "whisper_decode_with_fallback.json")
    with open(out_path, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print("done ->", out_path)
