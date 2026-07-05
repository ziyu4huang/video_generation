#!/usr/bin/env python3
"""whisper_transcribe.py — native transcription entry for the movie-director ext.

Spawned by the Bun `whisperAdapter` (providers.ts). Runs mlx_whisper on a real
audio file with word-level timestamps and emits a normalized JSON result the
adapter parses into a ToolResult. This is the Item I native transcriber backend
(MLX on Apple Silicon) — on-thesis with the rest of the repo's MLX stack.

Contract (JSON, written to --output or stdout):
  {
    "ok": true,
    "audio": "<path>",
    "model": "<hf-repo>",
    "language": "en",
    "duration_s": 7.44,            # wall time of the transcribe() call
    "text": "<full transcript>",
    "segments": [
      { "start": 0.0, "end": 2.5, "text": "...",
        "words": [ { "word": "...", "start": 0.0, "end": 0.4, "prob": 0.95 }, ... ] }
    ]
  }

On failure: { "ok": false, "error": "<message>" } with a non-zero exit code.

The default model is whisper-small-mlx (fast, accurate on short clips). Override
via --model with any mlx-community/whisper-*-mlx repo. The model auto-downloads
from HuggingFace on first use.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser(description="mlx-whisper transcription entry")
    ap.add_argument("--audio", required=True, help="path to the audio file")
    ap.add_argument(
        "--model",
        default=os.environ.get("MD_WHISPER_MODEL", "mlx-community/whisper-small-mlx"),
        help="HuggingFace repo (mlx-community/whisper-*-mlx). Default: whisper-small-mlx.",
    )
    ap.add_argument("--language", default=None, help="language hint (e.g. 'en'). Default: auto-detect.")
    ap.add_argument("--output", default=None, help="write JSON here; stdout if omitted.")
    ap.add_argument("--no-words", action="store_true", help="skip word-level timestamps.")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        return _emit(args.output, {"ok": False, "error": f"audio not found: {args.audio}"}, exit_code=2)

    try:
        import mlx_whisper as mw
    except Exception as exc:  # pragma: no cover - env-dependent
        return _emit(args.output, {"ok": False, "error": f"mlx_whisper import failed: {exc}"}, exit_code=3)

    t0 = time.time()
    try:
        res = mw.transcribe(
            args.audio,
            path_or_hf_repo=args.model,
            word_timestamps=not args.no_words,
            language=args.language,
        )
    except Exception as exc:
        return _emit(args.output, {"ok": False, "error": f"transcribe failed: {exc}"}, exit_code=4)

    segments = []
    for seg in res.get("segments", []):
        words = []
        for w in seg.get("words") or []:
            words.append({
                "word": w.get("word", "").strip(),
                "start": w.get("start"),
                "end": w.get("end"),
                "prob": w.get("probability"),
            })
        segments.append({
            "start": seg.get("start"),
            "end": seg.get("end"),
            "text": (seg.get("text") or "").strip(),
            "words": words,
        })

    out = {
        "ok": True,
        "audio": os.path.abspath(args.audio),
        "model": args.model,
        "language": res.get("language"),
        "duration_s": round(time.time() - t0, 3),
        "text": (res.get("text") or "").strip(),
        "segments": segments,
    }
    return _emit(args.output, out, exit_code=0)


def _emit(output: str | None, payload: dict, exit_code: int) -> int:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if output:
        with open(output, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
