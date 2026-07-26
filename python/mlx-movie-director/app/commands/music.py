"""music — local text-to-music synthesis via MLX MusicGen (mlx-audiocraft).

Meta's MusicGen running on Apple Silicon via the mlx-audiocraft port (the first
full AudioCraft port for M-series Macs — no CUDA, no server, no Docker). This is
movie-director's local music SOURCE: it produces the royalty-free audio file that
``edit.audio.music.src`` points at, which compose-motion's amix pass then mixes
under the narration (src/compose_motion.ts:mixAudioOnto).

Fully local-silicon + open-source + free: the model downloads ONCE from
HuggingFace, then generation is on-device (no network egress at synth time, no
API key, no cloud). MusicGen weights are CC-BY-4.0 — attribution to Meta/
MusicGen belongs in publish_log; the license itself imposes no fee.

This inverts the earlier royalty-free-STOCK-via-network decision (Pixabay) toward
local GENERATIVE music, matching the repo's native-MLX/offline posture. See
ticket 01 (revision) + ticket 04.

Setup (one-time, into the existing MLX venv):
  uv pip install mlx-audiocraft soundfile --python python/venv/bin/python

Examples:
  run.py music --prompt "gentle solo piano, melancholic, slow" --output score.wav
  run.py music --prompt "upbeat acoustic guitar, warm, 90bpm" --duration 20
  MD_MUSICGEN_MODEL=facebook/musicgen-medium run.py music --prompt "..." --out.mp3
"""

import argparse
import os
import sys
import time

from app.commands._shared import make_output_paths, run_session

PARSER_META = {
    "help": "Text-to-music via local MLX MusicGen (mlx-audiocraft, CC-BY-4.0)",
    "description": (
        "Generate music from a text prompt using Meta's MusicGen on Apple Silicon\n"
        "(mlx-audiocraft). Fully local after a one-time model download — no network\n"
        "egress at synth time, no API key. Weights are CC-BY-4.0 (record attribution\n"
        "in publish_log).\n\n"
        "Setup: uv pip install mlx-audiocraft soundfile --python python/venv/bin/python\n\n"
        "Examples:\n"
        "  run.py music --prompt \"gentle solo piano, melancholic\" --output score.wav\n"
        "  run.py music --prompt \"warm acoustic guitar, 90bpm\" --duration 20\n"
    ),
}


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--prompt", type=str, required=True, metavar="TEXT",
                        help="Music description (mood/genre/instruments)")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output audio path (default: <gen-output-dir>/output_<ts>.wav). "
                             ".wav is written directly; .mp3 is produced via ffmpeg if available.")
    parser.add_argument("--duration", type=float, default=30.0, metavar="SEC",
                        help="Target duration in seconds (default: 30)")
    parser.add_argument("--model", type=str,
                        default=os.environ.get("MD_MUSICGEN_MODEL", "facebook/musicgen-small"),
                        metavar="NAME",
                        help="MusicGen model id (default: facebook/musicgen-small, or "
                             "MD_MUSICGEN_MODEL). Larger (medium/large/melody) raise quality + VRAM.")


def _save_wav(audio, sample_rate: int, out_path: str) -> None:
    """Write a mono/stereo float ndarray (range ~[-1,1]) to a wav file."""
    import numpy as np

    arr = audio
    # Accept torch tensors, mlx arrays, or numpy.
    if hasattr(arr, "cpu"):
        arr = arr.cpu().numpy()
    elif hasattr(arr, "__array__") and not isinstance(arr, np.ndarray):
        arr = np.asarray(arr)
    arr = np.asarray(arr, dtype=np.float32)
    # Squeeze a leading batch dim if present (generate([prompt]) → [1, T] / [1, C, T]).
    if arr.ndim == 3:
        arr = arr[0]
    if arr.ndim == 2:
        # (C, T) → transpose to (T, C); (T, C) stays.
        if arr.shape[0] <= arr.shape[1] and arr.shape[0] <= 2:
            arr = arr.T
    # Clamp + convert to int16.
    ints = np.clip(arr, -1.0, 1.0)
    try:
        import soundfile as sf
        sf.write(out_path, ints, sample_rate, subtype="PCM_16")
        return
    except ImportError:
        pass
    from scipy.io import wavfile
    wavfile.write(out_path, sample_rate, (ints * 32767).astype(np.int16))


def run(args: argparse.Namespace) -> None:
    prompt: str = args.prompt
    duration: float = float(args.duration)
    model: str = args.model

    want_mp3 = args.output and args.output.lower().endswith(".mp3")
    if args.output:
        out_path = args.output
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        paths = None
    else:
        paths = make_output_paths(ext=".wav")
        out_path = paths.output_file

    try:
        from mlx_audiocraft import MusicGen
    except ImportError:
        print("ERROR: mlx-audiocraft not installed. Run: uv pip install mlx-audiocraft "
              "soundfile --python python/venv/bin/python", file=sys.stderr)
        sys.exit(1)

    print(f"[music] MusicGen loading ({model}, duration={duration}s)...", flush=True)
    t0 = time.perf_counter()
    try:
        mg = MusicGen.get_pretrained(model)
        mg.set_generation_params(duration=duration)
        wav = mg.generate([prompt])
        sample_rate = getattr(mg, "sample_rate", 32000)
    except Exception as e:
        print(f"ERROR: MusicGen generation failed: {e}", file=sys.stderr)
        # Hint the most common cause: a model id mlx-audiocraft can't resolve, or
        # insufficient memory for medium/large on this machine.
        print("Hint: try --model facebook/musicgen-small, or a smaller duration.", file=sys.stderr)
        sys.exit(1)
    elapsed = time.perf_counter() - t0

    # Write WAV first (always), then transcode to mp3 if requested + ffmpeg present.
    wav_path = out_path if out_path.lower().endswith(".wav") else (
        os.path.splitext(out_path)[0] + ".wav")
    try:
        _save_wav(wav, sample_rate, wav_path)
    except Exception as e:
        print(f"ERROR: failed to write audio ({e})", file=sys.stderr)
        sys.exit(1)

    if want_mp3 and wav_path != out_path:
        import shutil
        import subprocess
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", wav_path,
                            "-codec:a", "libmp3lame", "-qscale:a", "2", out_path], check=True)
            try:
                os.remove(wav_path)
            except OSError:
                pass
        else:
            print("WARNING: ffmpeg not found — keeping .wav (compose-motion accepts wav).",
                  file=sys.stderr)
            out_path = wav_path

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        print(f"ERROR: produced no audio at {out_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[music] ✓ saved: {out_path} ({elapsed:.2f}s, {duration}s of music)")

    if paths is not None:
        import json
        with open(paths.run_file, "w") as f:
            json.dump({"command": "music", "model": model, "duration": duration,
                       "prompt_length": len(prompt)}, f, indent=2)
        with run_session(paths, run_config=None) as ctx:
            ctx["outputs"] = [{
                "path": out_path,
                "size_bytes": os.path.getsize(out_path),
                "model": model,
                "duration": duration,
            }]
            ctx["timings"] = {"total": round(elapsed, 2)}
            ctx["models"] = {"musicgen_model": model}
