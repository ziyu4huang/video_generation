"""video-asr-gate — standalone ASR audio-content gate, callable in isolation.

Wraps video-t2i2v.py's `_run_audio_asr_gate` (mlx_whisper transcription +
language/content-overlap check) as its own sub-action so callers that don't
run the full t2i2v pipeline — notably the Swift `ltx-video gate` binary via
RunPyBridge — can invoke JUST the ASR step against an arbitrary video +
expected-speech prompt and get back a JSON verdict.

mlx_whisper transcription itself stays here (Python/MLX): there is no native
Swift/MLX Whisper port yet (tracked as backlog in
swift/ltx-video-director/docs/TODO.md). Everything DOWNSTREAM of the raw
transcript — including Traditional-vs-Simplified script classification, which
Whisper's `detected_lang` cannot do (only ever reports generic "zh") — is
native Swift (see LTXVideoDirector/CJKScript.swift + ASRGate.swift); this
subcommand deliberately returns the raw transcript text rather than trying to
guess the script itself, so the Swift side is the single source of truth for
that decision.

Usage:
  run.py video asr-gate --video output/clip.mp4 --prompt "she says 「你好嗎」"
  run.py video asr-gate --video output/clip.mp4 --prompt "..." --json-out result.json
"""

import argparse
import importlib
import json
import sys

_t2i2v = importlib.import_module("app.commands.video-t2i2v")

PARSER_META = {
    "help": "Standalone ASR-based audio-content gate (language + transcript match) for an existing video",
}


def add_asr_gate_args(parser: "argparse.ArgumentParser") -> None:
    # NOT required=True: this shares one parser with every other `video`
    # sub-action (video.py's add_args calls every sub-module's add_*_args on
    # the same parser), so a required flag here would break `video generate`,
    # `video restore`, etc. Validated in run_asr_gate() instead, same pattern
    # as the other sub-actions' required-in-practice args.
    #
    # NOTE: does NOT declare --prompt — video-generate.py's add_generate_args
    # (called earlier on this same shared parser, see video.py's add_args)
    # already owns it; a second add_argument("--prompt", ...) here raises
    # argparse.ArgumentError: conflicting option string (confirmed by running
    # the real CLI). run_asr_gate() reads args.prompt, already populated by
    # the shared parser.
    parser.add_argument("--video", default=None, help="Path to the video file to check. Required for the 'asr-gate' action.")
    parser.add_argument("--json-out", default=None, help="Write the result JSON to this path (also printed to stdout).")


def run_asr_gate(args: "argparse.Namespace") -> None:
    if not args.video:
        print("error: --video is required for `video asr-gate`", file=sys.stderr)
        sys.exit(2)
    result = _t2i2v._run_audio_asr_gate(args.video, args.prompt)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            f.write(text)
    if "error" in result:
        sys.exit(1)
