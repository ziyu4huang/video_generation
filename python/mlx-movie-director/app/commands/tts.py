"""tts — standalone narration/dialogue synthesis via edge-tts or local MLX Kokoro.

Isolates the edge-tts call already used inside `video relay` (--relay-tts-engine
edge-tts, see video-relay.py) into its own top-level command so movie-director
(bun-apps/s2-agent-ext-movie-director) can invoke natural-sounding narration
without going through the full relay pipeline. macOS `say` remains the
zero-network fallback (see app.commands._shared / video-relay.py's `--relay-tts-
engine say` path) — this command is the natural-voice alternative when network
egress is acceptable.

`--engine mlx` runs Kokoro-82M fully locally via the `mlx-audio` package — no
per-call network egress (only a one-time model/voice download on first use,
same as any other MLX model in this repo). Needs `mlx-audio`, `misaki`,
`num2words`, `spacy` (+ its `en_core_web_sm` model, auto-downloaded once) and
`phonemizer` + the system `espeak-ng` binary — see requirements.txt.
"""

import argparse
import asyncio
import os
import sys

from app.commands._shared import make_output_paths, run_session
from app.io_utils import require_file

PARSER_META = {
    "help": "Narration/dialogue synthesis via edge-tts (cloud) or local MLX Kokoro",
    "description": (
        "Synthesize speech from text using edge-tts (Microsoft neural TTS, cloud) "
        "or mlx-audio's Kokoro model (local, Apple Silicon, --engine mlx).\n\n"
        "edge-tts needs network egress per call — unlike macOS `say` or --engine mlx, "
        "it is NOT available under --offline. --engine mlx needs network only once "
        "to download the model/voice, then runs fully local.\n\n"
        "Examples:\n"
        "  run.py tts --text \"Hello world\" --output narration.mp3\n"
        "  run.py tts --text-file script.txt --voice en-US-GuyNeural\n"
        "  run.py tts --text \"...\" --voice zh-TW-HsiaoChenNeural --rate -10%\n"
        "  run.py tts --text \"You're late.\" --engine mlx --voice am_michael --output line1.wav\n"
    ),
}

# A few common voices, not exhaustive — edge-tts supports many more
# (see `edge-tts --list-voices`). Kept as documentation, not an enum: an
# unlisted voice id still works, argparse does not restrict --voice.
_EXAMPLE_VOICES = [
    "en-US-AriaNeural", "en-US-GuyNeural",
    "zh-TW-HsiaoChenNeural", "zh-TW-YunJheNeural", "zh-TW-HsiaoYuNeural",
]

# mlx-audio/Kokoro voice ids are "<lang><gender>_<name>" (af_heart, am_adam,
# bf_emma, ...) — used to catch an edge-tts voice id being passed to --engine
# mlx by mistake, with a clear error instead of a confusing mlx-audio failure.
_MLX_VOICE_PREFIXES = (
    "af_", "am_", "bf_", "bm_", "ef_", "em_", "ff_", "hf_", "hm_",
    "if_", "im_", "jf_", "jm_", "pf_", "pm_", "zf_", "zm_",
)
_DEFAULT_MLX_MODEL = "mlx-community/Kokoro-82M-bf16"
_DEFAULT_MLX_VOICE = "af_heart"
_DEFAULT_EDGE_VOICE = "en-US-AriaNeural"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("text", nargs="?", default=None, metavar="TEXT",
                        help="Narration text (positional shorthand for --text)")
    parser.add_argument("--text", dest="text_flag", type=str, default=None, metavar="TEXT",
                        help="Narration text (flag form)")
    parser.add_argument("--text-file", type=str, default=None, metavar="PATH",
                        help="Read narration text from a file instead of --text")
    parser.add_argument("--engine", type=str, default="edge-tts",
                        choices=["edge-tts", "mlx"],
                        help="TTS engine: edge-tts (cloud, default) or mlx "
                        "(local Kokoro via mlx-audio, no per-call network egress)")
    parser.add_argument("--voice", type=str, default=None, metavar="VOICE",
                        help="Voice id. For --engine edge-tts: an edge-tts voice "
                        f"(default {_DEFAULT_EDGE_VOICE}; examples {', '.join(_EXAMPLE_VOICES)}). "
                        f"For --engine mlx: an mlx-audio/Kokoro voice (default "
                        f"{_DEFAULT_MLX_VOICE}; examples am_michael, am_adam, af_sarah).")
    parser.add_argument("--mlx-model", type=str, default=_DEFAULT_MLX_MODEL,
                        help=f"mlx-audio TTS model repo id, --engine mlx only "
                        f"(default: {_DEFAULT_MLX_MODEL})")
    parser.add_argument("--rate", type=str, default="+0%", metavar="RATE",
                        help="Speech rate as a signed percentage, e.g. -10%%, +15%% (default: +0%%). "
                        "For --engine mlx this is converted to a Kokoro speed multiplier.")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output audio path (default: <gen-output-dir>/output_<ts>.wav for --engine mlx, "
                        ".mp3 for --engine edge-tts)")


def _parse_rate_to_speed(rate: str) -> float:
    """Convert edge-tts's signed-percentage rate (e.g. '+15%', '-10%') to a
    Kokoro speed multiplier (e.g. 1.15, 0.90)."""
    rate = rate.strip()
    if not rate.endswith("%"):
        raise ValueError(f"--rate must be a signed percentage like '+10%' or '-5%', got: {rate!r}")
    pct = float(rate[:-1])
    return 1.0 + pct / 100.0


def _validate_mlx_voice(voice: str) -> None:
    if not voice.startswith(_MLX_VOICE_PREFIXES):
        print(f"ERROR: '{voice}' doesn't look like an mlx-audio/Kokoro voice id "
              f"(expected a prefix like {_MLX_VOICE_PREFIXES[0]!r} or {_MLX_VOICE_PREFIXES[1]!r}). "
              "Examples: am_michael, am_adam, af_heart, af_sarah.", file=sys.stderr)
        sys.exit(1)


def _synthesize_mlx(text: str, voice: str, model: str, speed: float, out_path: str) -> None:
    """Generate speech locally via mlx-audio's Kokoro pipeline. Imported lazily
    so the default --engine edge-tts path never requires mlx-audio / misaki /
    spacy / phonemizer to be installed.
    """
    from mlx_audio.tts.generate import generate_audio

    out_dir = os.path.dirname(out_path) or "."
    os.makedirs(out_dir, exist_ok=True)
    base, ext = os.path.splitext(os.path.basename(out_path))
    audio_format = ext.lstrip(".") or "wav"

    generate_audio(
        text=text,
        model=model,
        voice=voice,
        speed=speed,
        output_path=out_dir,
        file_prefix=base,
        audio_format=audio_format,
        join_audio=True,
        verbose=False,
    )


def run(args: argparse.Namespace) -> None:
    text = args.text or getattr(args, "text_flag", None)
    if args.text_file:
        if text:
            print("WARNING: both TEXT and --text-file given — using --text-file", file=sys.stderr)
        text_file = require_file(args.text_file, "--text-file")
        with open(text_file, encoding="utf-8") as f:
            text = f.read().strip()
    if not text:
        print("ERROR: narration text is required (positional TEXT, --text, or --text-file)",
              file=sys.stderr)
        sys.exit(1)

    engine = args.engine
    rate = args.rate

    if args.output:
        out_path = args.output
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        paths = None
    else:
        default_ext = ".wav" if engine == "mlx" else ".mp3"
        paths = make_output_paths(ext=default_ext)
        out_path = paths.output_file

    import time
    t0 = time.perf_counter()

    if engine == "mlx":
        voice = args.voice or _DEFAULT_MLX_VOICE
        _validate_mlx_voice(voice)
        try:
            speed = _parse_rate_to_speed(rate)
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"[tts] mlx (Kokoro) synthesizing ({len(text)} chars, voice={voice}, "
              f"model={args.mlx_model}, speed={speed})...", flush=True)
        try:
            _synthesize_mlx(text, voice, args.mlx_model, speed, out_path)
        except Exception as e:
            print(f"ERROR: mlx TTS synthesis failed: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        voice = args.voice or _DEFAULT_EDGE_VOICE
        try:
            import edge_tts
        except ImportError:
            print("ERROR: edge-tts not installed. Run: uv pip install edge-tts "
                  "--python python/venv/bin/python", file=sys.stderr)
            sys.exit(1)

        print(f"[tts] edge-tts synthesizing ({len(text)} chars, voice={voice}, rate={rate})...",
              flush=True)

        async def _synthesize() -> None:
            communicate = edge_tts.Communicate(text, voice, rate=rate)
            await communicate.save(out_path)

        try:
            asyncio.run(_synthesize())
        except Exception as e:
            print(f"ERROR: edge-tts synthesis failed: {e}", file=sys.stderr)
            sys.exit(1)

    elapsed = time.perf_counter() - t0

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        print(f"ERROR: {engine} TTS produced no audio at {out_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[tts] ✓ saved: {out_path} ({elapsed:.2f}s)")

    if paths is not None:
        # Mirror run_session's manifest shape (status/output_files/models) so the
        # bun bridge (runpy_tts.ts) parses this the same way it parses image/video
        # manifests — no run_config (this command has no seed/model-fingerprint
        # concept worth replaying), so run_session's own run.json write is skipped
        # and a minimal one is written here instead.
        import json
        with open(paths.run_file, "w") as f:
            json.dump({"command": "tts", "engine": engine, "voice": voice, "rate": rate,
                       "text_length": len(text)}, f, indent=2)
        with run_session(paths, run_config=None) as ctx:
            ctx["outputs"] = [{
                "path": out_path,
                "size_bytes": os.path.getsize(out_path),
                "voice": voice,
            }]
            ctx["timings"] = {"total": round(elapsed, 2)}
            ctx["models"] = {"tts_engine": engine, "voice": voice}
