"""video — LTX-2.3 22B video generation (T2V, I2V, A2V) on Apple Silicon."""

import os
import shutil
import subprocess
import sys
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_prompt
from app.manifest import Manifest, file_fingerprint
from app.run_config import RunConfig

PARSER_META = {
    "help": "LTX-2.3 22B video generation from text, image, or audio",
    "description": (
        "Generate videos using the LTX-2.3 22B two-stage MLX pipeline.\n\n"
        "Modes:\n"
        "  T2V  (default)    text-only\n"
        "  I2V  --input-image    animate from a reference image\n"
        "  A2V  --audio          condition on an audio track\n\n"
        "Examples:\n"
        "  run.py video --prompt 'cinematic sunset' --fps 24 --frames 49\n"
        "  run.py video --prompt '...' --input-image frame.png --fps 24 --frames 49\n"
        "  run.py video --prompt '...' --audio track.wav --fps 24 --frames 97\n"
        "  run.py video --prompt '...' --low-ram --frames 25   # ≤32 GB RAM\n"
    ),
}

_VALID_FRAMES_MSG = (
    "must satisfy 8k+1: 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121, ..."
)


def add_args(parser):
    prompt_grp = parser.add_mutually_exclusive_group()
    prompt_grp.add_argument("--prompt", type=str, help="Text prompt")
    prompt_grp.add_argument("--prompt-file", type=str,
                            help="Path to a .txt file containing the prompt")

    parser.add_argument("--width", type=int, default=704,
                        help="Video width in pixels — must be divisible by 32 (default: 704)")
    parser.add_argument("--height", type=int, default=480,
                        help="Video height in pixels — must be divisible by 32 (default: 480)")
    parser.add_argument("--frames", type=int, default=97,
                        help=f"Number of frames — {_VALID_FRAMES_MSG} (default: 97)")
    parser.add_argument("--fps", type=float, default=24.0,
                        help="Output frame rate (default: 24.0)")

    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Reference image for I2V conditioning (optional)")
    parser.add_argument("--audio", type=str, default=None, metavar="PATH",
                        help="Audio file for A2V mode (.wav/.mp3, optional)")

    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--cfg-scale", type=float, default=5.0, dest="cfg_scale",
                        help="Classifier-free guidance scale (default: 5.0)")
    parser.add_argument("--stg-scale", type=float, default=1.0, dest="stg_scale",
                        help="Spatial-temporal guidance scale (default: 1.0)")
    parser.add_argument("--stage1-steps", type=int, default=None,
                        help="Stage 1 denoising steps (default: pipeline default ~30)")
    parser.add_argument("--stage2-steps", type=int, default=None,
                        help="Stage 2 refinement steps (default: pipeline default ~3)")

    parser.add_argument("--low-ram", action="store_true", default=False,
                        help="Block-streaming mode — ~75%% lower peak Metal RAM, slower per step")
    parser.add_argument("--video-model", type=str, default=None, metavar="PATH",
                        help=(
                            "Local flat model dir or HF repo ID "
                            "(default: auto-detect from models/ or HF auto-download)"
                        ))

    parser.add_argument("--first-frame", action="store_true", default=False,
                        help="Extract first frame as <base>.png after generation (uses ffmpeg)")
    parser.add_argument("--caption", action="store_true", default=False,
                        help="Extract first frame and run 'run.py caption' on it (implies --first-frame)")


def run(args):
    try:
        prompt = resolve_prompt(args)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    frames = args.frames
    if (frames - 1) % 8 != 0:
        print(
            f"ERROR: --frames {frames} does not satisfy 8k+1 pattern.\n"
            f"Valid values: {_VALID_FRAMES_MSG}",
            file=sys.stderr,
        )
        sys.exit(1)

    audio_path = args.audio
    image_path = args.input_image

    if audio_path and not os.path.exists(audio_path):
        print(f"ERROR: audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)
    if image_path and not os.path.exists(image_path):
        print(f"ERROR: input image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    base_name_path = os.path.join(cfg.OUTPUT_DIR, base_name)
    output_mp4 = base_name_path + ".mp4"
    run_file = base_name_path + ".run.json"
    manifest_file = base_name_path + ".manifest.json"

    run_config = RunConfig.from_args(args, command="video")
    run_config.to_json(run_file)

    mode = "A2V" if audio_path else ("I2V" if image_path else "T2V")
    start_time = datetime.now(timezone.utc).isoformat()

    print(f"[video] Mode: {mode}  Resolution: {args.width}×{args.height}  "
          f"Frames: {frames}  FPS: {args.fps}")
    print(f"[video] low-ram: {args.low_ram}  seed: {args.seed}")

    try:
        from app.ltx_pipeline import LTXVideoPipeline

        pipeline = LTXVideoPipeline(
            model_dir=args.video_model,
            low_ram=args.low_ram,
        )

        timings = pipeline.generate(
            prompt=prompt,
            output_path=output_mp4,
            height=args.height,
            width=args.width,
            num_frames=frames,
            frame_rate=args.fps,
            seed=args.seed,
            stage1_steps=args.stage1_steps,
            stage2_steps=args.stage2_steps,
            cfg_scale=args.cfg_scale,
            stg_scale=args.stg_scale,
            image=image_path,
            audio_path=audio_path,
        )

        end_time = datetime.now(timezone.utc).isoformat()

        output_files = [{
            "path": output_mp4,
            "mode": mode,
            "seed": args.seed,
            "size_bytes": os.path.getsize(output_mp4),
            "width": args.width,
            "height": args.height,
            "frames": frames,
            "fps": args.fps,
        }]

        models = _collect_model_fingerprints(pipeline._model_dir)
        manifest = Manifest.from_success(run_file, start_time, end_time, timings,
                                         output_files, models)
        manifest.to_json(manifest_file)

        print(f"[video] Saved:    {output_mp4}")
        print(f"[video] Run:      {run_file}")
        print(f"[video] Manifest: {manifest_file}")

        # Optional first-frame extraction + caption
        if args.first_frame or args.caption:
            png_path = base_name_path + ".png"
            if _extract_first_frame(output_mp4, png_path):
                print(f"[video] Frame:    {png_path}")
                if args.caption:
                    _run_caption(png_path)
            else:
                print("[video] WARNING: first-frame extraction failed (ffmpeg not found?)",
                      file=sys.stderr)

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, {}, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


def _extract_first_frame(video_path: str, png_path: str) -> bool:
    """Extract first frame of video to png_path using ffmpeg. Returns True on success."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    result = subprocess.run(
        [ffmpeg, "-y", "-i", video_path, "-vframes", "1", png_path],
        capture_output=True, timeout=30,
    )
    return result.returncode == 0 and os.path.exists(png_path)


def _run_caption(png_path: str) -> None:
    """Call run.py caption on the given PNG (fire-and-wait, non-fatal on failure)."""
    run_py = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "run.py")
    python = sys.executable
    try:
        print(f"[video] Captioning {os.path.basename(png_path)}…")
        subprocess.run([python, run_py, "caption", png_path], timeout=180)
    except Exception as exc:
        print(f"[video] Caption skipped: {exc}", file=sys.stderr)


def _collect_model_fingerprints(model_dir: str) -> dict:
    """Fingerprint key weight files in the resolved model directory."""
    key_files = [
        "transformer-dev.safetensors",
        "ltx-2.3-22b-distilled-lora-384.safetensors",
        "connector.safetensors",
    ]
    models = {}
    for fname in key_files:
        fpath = os.path.join(model_dir, fname)
        key = fname.replace(".safetensors", "").replace("-", "_").replace(".", "_")
        if os.path.exists(fpath):
            models[key] = file_fingerprint(fpath)
    return models
