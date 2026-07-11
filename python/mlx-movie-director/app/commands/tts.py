"""tts — standalone narration synthesis via edge-tts (Microsoft neural TTS).

Isolates the edge-tts call already used inside `video relay` (--relay-tts-engine
edge-tts, see video-relay.py) into its own top-level command so movie-director
(bun-apps/pi-agent-ext-movie-director) can invoke natural-sounding narration
without going through the full relay pipeline. macOS `say` remains the
zero-network fallback (see app.commands._shared / video-relay.py's `--relay-tts-
engine say` path) — this command is the natural-voice alternative when network
egress is acceptable.
"""

import argparse
import asyncio
import os
import sys

from app.commands._shared import make_output_paths, run_session
from app.io_utils import require_file

PARSER_META = {
    "help": "Narration synthesis via edge-tts (Microsoft neural TTS, natural voice)",
    "description": (
        "Synthesize speech from text using edge-tts (Microsoft neural TTS).\n\n"
        "Needs network egress (Microsoft's edge-tts service) — unlike macOS `say`,\n"
        "this is NOT available under --offline. Use `say` (via video relay's\n"
        "--relay-tts-engine say, or macOS `say` directly) for a fully local fallback.\n\n"
        "Examples:\n"
        "  run.py tts --text \"Hello world\" --output narration.mp3\n"
        "  run.py tts --text-file script.txt --voice en-US-GuyNeural\n"
        "  run.py tts --text \"...\" --voice zh-TW-HsiaoChenNeural --rate -10%\n"
    ),
}

# A few common voices, not exhaustive — edge-tts supports many more
# (see `edge-tts --list-voices`). Kept as documentation, not an enum: an
# unlisted voice id still works, argparse does not restrict --voice.
_EXAMPLE_VOICES = [
    "en-US-AriaNeural", "en-US-GuyNeural",
    "zh-TW-HsiaoChenNeural", "zh-TW-YunJheNeural", "zh-TW-HsiaoYuNeural",
]


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("text", nargs="?", default=None, metavar="TEXT",
                        help="Narration text (positional shorthand for --text)")
    parser.add_argument("--text", dest="text_flag", type=str, default=None, metavar="TEXT",
                        help="Narration text (flag form)")
    parser.add_argument("--text-file", type=str, default=None, metavar="PATH",
                        help="Read narration text from a file instead of --text")
    parser.add_argument("--voice", type=str, default="en-US-AriaNeural", metavar="VOICE",
                        help="edge-tts voice id (default: en-US-AriaNeural). "
                        f"Examples: {', '.join(_EXAMPLE_VOICES)}")
    parser.add_argument("--rate", type=str, default="+0%", metavar="RATE",
                        help="Speech rate as a signed percentage, e.g. -10%%, +15%% (default: +0%%)")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output audio path (default: <gen-output-dir>/output_<ts>.mp3)")


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

    try:
        import edge_tts
    except ImportError:
        print("ERROR: edge-tts not installed. Run: uv pip install edge-tts "
              "--python python/venv/bin/python", file=sys.stderr)
        sys.exit(1)

    voice = args.voice
    rate = args.rate

    if args.output:
        out_path = args.output
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        paths = None
    else:
        paths = make_output_paths(ext=".mp3")
        out_path = paths.output_file

    print(f"[tts] edge-tts synthesizing ({len(text)} chars, voice={voice}, rate={rate})...",
          flush=True)

    async def _synthesize() -> None:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        await communicate.save(out_path)

    import time
    t0 = time.perf_counter()
    try:
        asyncio.run(_synthesize())
    except Exception as e:
        print(f"ERROR: edge-tts synthesis failed: {e}", file=sys.stderr)
        sys.exit(1)
    elapsed = time.perf_counter() - t0

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        print(f"ERROR: edge-tts produced no audio at {out_path}", file=sys.stderr)
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
            json.dump({"command": "tts", "voice": voice, "rate": rate,
                       "text_length": len(text)}, f, indent=2)
        with run_session(paths, run_config=None) as ctx:
            ctx["outputs"] = [{
                "path": out_path,
                "size_bytes": os.path.getsize(out_path),
                "voice": voice,
            }]
            ctx["timings"] = {"total": round(elapsed, 2)}
            ctx["models"] = {"tts_engine": "edge-tts", "voice": voice}
