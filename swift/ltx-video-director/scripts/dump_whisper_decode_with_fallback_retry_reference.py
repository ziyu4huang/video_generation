"""Dump a REAL `mlx_whisper.decoding.DecodingTask` T=0 reference on a clip
where T=0's decode ACTUALLY fails `decode_with_fallback`'s retry gate
(avg_logprob < -1.0), unlike dump_whisper_decode_with_fallback_reference.py's
reference clip (whose T=0 decode already succeeds, so the retry-TRIGGER
condition itself has never had a real-checkpoint regression test).

Deliberately dumps ONLY the T=0 attempt, not the temperature this clip lands
on: T>0 decoding uses `mx.random.categorical` (stochastic sampling from the
global PRNG state), which is NOT reproducible run-to-run without seed
alignment this repo has no precedent for wiring cross-language (re-running
this exact script produces a different landed temperature/text each time —
confirmed empirically). T=0's argmax decode has no such randomness, so it's
the only part of the retry loop that can be asserted bit-exact. This
reference proves the trigger *condition* (avg_logprob < -1.0 -> needs
fallback) is computed identically in the Swift port, on a real checkpoint,
for a clip that actually exercises it — the retry LOOP's mechanics (that it
does not stop at T=0 when told to try more temperatures) is then checked
structurally in the Swift test, not bit-exact.

Of the 31 generated clips checked under `video_generation__output/` for this
iteration's goal note, only this one clip's audio fails T=0's gate.

Run from repo root (requires the large-v3-mlx checkpoint + ffmpeg):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_decode_with_fallback_retry_reference.py
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
VIDEO = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_064046/output_20260702_064158.mp4"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_decode_with_fallback_retry")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    wav_path = "/tmp/whisper_decode_with_fallback_retry_ref.wav"
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

    options = DecodingOptions(language="zh", temperature=0.0, fp16=False)
    decode_result = DecodingTask(model, options).run(mel)[0]

    needs_fallback = False
    if decode_result.compression_ratio > 2.4:
        needs_fallback = True
    if decode_result.avg_logprob < -1.0:
        needs_fallback = True
    if decode_result.no_speech_prob > 0.6:
        needs_fallback = False

    print("T=0 text:", repr(decode_result.text))
    print("T=0 tokens:", decode_result.tokens)
    print("T=0 avg_logprob:", decode_result.avg_logprob)
    print("T=0 no_speech_prob:", decode_result.no_speech_prob)
    print("T=0 compression_ratio:", decode_result.compression_ratio)
    print("needs_fallback:", needs_fallback)
    assert needs_fallback, "reference clip no longer triggers the retry gate at T=0 — pick a different clip"

    meta = {
        "video": VIDEO,
        "language": "zh",
        "text": decode_result.text,
        "tokens": decode_result.tokens,
        "avg_logprob": decode_result.avg_logprob,
        "no_speech_prob": decode_result.no_speech_prob,
        "compression_ratio": decode_result.compression_ratio,
        "needs_fallback": needs_fallback,
    }
    out_path = os.path.join(OUT_DIR, "whisper_decode_with_fallback_retry.json")
    with open(out_path, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print("done ->", out_path)
