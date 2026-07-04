"""Dump a REAL language-detection reference (mlx_whisper.decoding.detect_language)
for WhisperModelRealCheckpointTests' native detectLanguage().

Run from repo root (requires the large-v3-mlx checkpoint + a real clip):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_real_detect_language_reference.py
"""
import json
import os

import mlx.core as mx
import mlx.utils

from mlx_whisper.audio import load_audio, log_mel_spectrogram, pad_or_trim, N_SAMPLES
from mlx_whisper.whisper import Whisper, ModelDimensions
from mlx_whisper.tokenizer import get_tokenizer
from mlx_whisper.decoding import detect_language

CHECKPOINT_DIR = os.path.expanduser(
    "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/"
    "snapshots/49e6aa286ad60c14352c404340ded53710378a11"
)
VIDEO = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_072817/output_20260702_072848.mp4"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_real_detect_language")

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

    tok = get_tokenizer(True, num_languages=99, language="zh", task="transcribe")
    lang_tokens, _ = detect_language(model, mel, tok)
    detected_token = int(lang_tokens.item())
    detected_code = tok.decode([detected_token]).strip("<|>")

    meta = {"video": VIDEO, "detected_language_token": detected_token, "detected_language_code": detected_code}
    with open(os.path.join(OUT_DIR, "whisper_real_detect_language.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("detected token", detected_token, "-> code", detected_code)
    print("done ->", OUT_DIR)
