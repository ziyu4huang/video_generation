"""video-generate — LTX-2.3 22B video generation (T2V, I2V, A2V) on Apple Silicon.

Extracted from video.py as the "generate" sub-action module.
Exports: add_generate_args(), run_generate().
"""

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
from app.test_prompts_video import get_test_prompt, list_test_prompt_names

_VALID_FRAMES_MSG = (
    "must satisfy 8k+1: 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121, ..."
)


def add_generate_args(parser):
    """Register video generation arguments."""
    prompt_grp = parser.add_mutually_exclusive_group()
    prompt_grp.add_argument("--prompt", type=str, help="Text prompt")
    prompt_grp.add_argument("--prompt-file", type=str,
                            help="Path to a .txt file containing the prompt")
    prompt_grp.add_argument("--test-prompt", type=str, dest="test_prompt",
                            choices=list_test_prompt_names(), metavar="NAME",
                            help="Built-in test prompt (choices: %(choices)s)")

    parser.add_argument("--width", type=int, default=704,
                        help="Video width — must be divisible by 32 (default: 704)")
    parser.add_argument("--height", type=int, default=480,
                        help="Video height — must be divisible by 32 (default: 480)")
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

    parser.add_argument("--variations", type=int, default=1,
                        help="Number of variations for A/B testing (default: 1)")
    parser.add_argument("--ab-params", type=str, default=None, metavar="JSON",
                        help=(
                            "Per-variation parameter overrides as JSON dict of arrays. "
                            "Keys: cfg_scale, stg_scale, seed, stage1_steps, stage2_steps. "
                            "Example: '{\"cfg_scale\":[3,5],\"stg_scale\":[1,0.5]}'"
                        ))

    parser.add_argument("--allow-noise", action="store_true", default=False,
                        help="Suppress audio noise detection error (allow noisy audio)")

    parser.add_argument("--audio-stage1-only", action="store_true", default=False,
                        help="Use stage 1 audio latent only (skip stage 2 audio refinement). "
                             "May improve audio quality — see upstream LTX-2 issue #126.")

    parser.add_argument("--audio-volume", type=float, default=None, metavar="GAIN",
                        help="Post-process audio volume multiplier (e.g. 50 for 50x boost). "
                             "LTX-2.3 MLX audio is ~50x too quiet; use 50 to normalize.")


def run_generate(args):
    """Entry point for video generation."""
    # If --test-prompt selected, inject its prompt text and apply recommended defaults
    test_prompt_name = getattr(args, "test_prompt", None)
    if test_prompt_name:
        tp = get_test_prompt(test_prompt_name)
        args.prompt = tp["prompt"]
        _apply_prompt_defaults(args, tp.get("defaults") or {})

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

    # Parse --ab-params JSON
    ab_params = None
    if args.ab_params:
        import json as _json
        try:
            ab_params = _json.loads(args.ab_params)
        except _json.JSONDecodeError as e:
            print(f"ERROR: --ab-params is not valid JSON: {e}", file=sys.stderr)
            sys.exit(1)

    variations = max(1, getattr(args, "variations", 1))

    # Validate ab-params array lengths
    if ab_params:
        for key, values in ab_params.items():
            if not isinstance(values, list):
                print(f"ERROR: --ab-params key '{key}' must be an array, "
                      f"got {type(values).__name__}", file=sys.stderr)
                sys.exit(1)
            if len(values) != variations:
                print(f"ERROR: --ab-params key '{key}' has {len(values)} values "
                      f"but --variations is {variations}", file=sys.stderr)
                sys.exit(1)

    if variations > 1:
        # Auto-enable caption for A/B variations
        args.first_frame = True
        args.caption = True
        _run_variations(args, prompt, variations, ab_params)
    else:
        _run_single(args, prompt)


def _run_single(args, prompt: str) -> None:
    """Generate a single video."""
    frames = args.frames
    audio_path = args.audio
    image_path = args.input_image

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
            audio_stage1_only=getattr(args, "audio_stage1_only", False),
        )

        end_time = datetime.now(timezone.utc).isoformat()

        # --- Audio volume boost (LTX-2.3 MLX audio is ~50x too quiet) ---
        audio_volume = getattr(args, "audio_volume", None)
        if audio_volume is not None:
            _boost_audio_volume(output_mp4, audio_volume)

        # --- Audio noise detection ---
        allow_noise = getattr(args, "allow_noise", False)
        _check_audio_noise(output_mp4, allow_noise=allow_noise)

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


def _run_variations(args, prompt: str, variations: int, ab_params: dict | None) -> None:
    """Run N video variations for A/B testing. Each gets its own manifest."""
    import json as _json

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()

    mode = "A2V" if args.audio else ("I2V" if args.input_image else "T2V")
    print(f"[video] A/B Test: {variations} variations  Mode: {mode}  "
          f"Resolution: {args.width}×{args.height}  Frames: {args.frames}  FPS: {args.fps}")

    from app.ltx_pipeline import LTXVideoPipeline

    # Pipeline loaded once, reused across variations
    pipeline = LTXVideoPipeline(
        model_dir=args.video_model,
        low_ram=args.low_ram,
    )

    allow_noise = getattr(args, "allow_noise", False)

    for vi in range(variations):
        suffix = f"_v{vi + 1}"
        var_base = base_name + suffix
        var_base_path = os.path.join(cfg.OUTPUT_DIR, var_base)
        output_mp4 = var_base_path + ".mp4"
        run_file = var_base_path + ".run.json"
        manifest_file = var_base_path + ".manifest.json"

        # Merge ab-params overrides for this variation
        var_args = _override_args(args, vi, ab_params)
        # Track variation metadata in run.json
        var_args.variation_index = vi + 1
        var_args.ab_params_json = ab_params

        run_config = RunConfig.from_args(var_args, command="video")
        run_config.to_json(run_file)

        start_time = datetime.now(timezone.utc).isoformat()

        print(f"\n{'=' * 60}")
        print(f"[video] Variation {vi + 1}/{variations} "
              f"(cfg_scale={var_args.cfg_scale}, stg_scale={var_args.stg_scale}, "
              f"seed={var_args.seed})")
        print(f"{'=' * 60}")

        try:
            timings = pipeline.generate(
                prompt=prompt,
                output_path=output_mp4,
                height=args.height,
                width=args.width,
                num_frames=args.frames,
                frame_rate=args.fps,
                seed=var_args.seed,
                stage1_steps=var_args.stage1_steps,
                stage2_steps=var_args.stage2_steps,
                cfg_scale=var_args.cfg_scale,
                stg_scale=var_args.stg_scale,
                image=args.input_image,
                audio_path=args.audio,
                audio_stage1_only=getattr(args, "audio_stage1_only", False),
            )

            end_time = datetime.now(timezone.utc).isoformat()

            # --- Audio volume boost ---
            audio_volume = getattr(args, "audio_volume", None)
            if audio_volume is not None:
                _boost_audio_volume(output_mp4, audio_volume)

            # --- Audio noise detection ---
            _check_audio_noise(output_mp4, allow_noise=allow_noise)

            output_files = [{
                "path": output_mp4,
                "mode": mode,
                "variation": vi + 1,
                "seed": var_args.seed,
                "cfg_scale": var_args.cfg_scale,
                "stg_scale": var_args.stg_scale,
                "size_bytes": os.path.getsize(output_mp4),
                "width": args.width,
                "height": args.height,
                "frames": args.frames,
                "fps": args.fps,
            }]

            models = _collect_model_fingerprints(pipeline._model_dir)
            manifest = Manifest.from_success(
                run_file, start_time, end_time, timings, output_files, models)
            manifest.to_json(manifest_file)

            print(f"[video] Saved:    {output_mp4}")
            print(f"[video] Run:      {run_file}")
            print(f"[video] Manifest: {manifest_file}")
            print(f"[video] Elapsed:  {manifest.elapsed_seconds:.1f}s  "
                  f"Peak RAM: {manifest.memory_peak_mb / 1024:.1f} GB")

            # Auto-caption (forced on for variations)
            png_path = var_base_path + ".png"
            if _extract_first_frame(output_mp4, png_path):
                print(f"[video] Frame:    {png_path}")
                _run_caption(png_path)
            else:
                print("[video] WARNING: first-frame extraction failed",
                      file=sys.stderr)

        except Exception as exc:
            end_time = datetime.now(timezone.utc).isoformat()
            manifest = Manifest.from_error(
                run_file, start_time, end_time, {}, exc, {})
            manifest.to_json(manifest_file)
            print(f"ERROR: variation {vi + 1} failed: "
                  f"{type(exc).__name__}: {exc}", file=sys.stderr)
            traceback.print_exc()
            # Continue with remaining variations instead of aborting all
            continue

    print(f"\n{'=' * 60}")
    print(f"[video] A/B Test complete: {variations} variations")
    print(f"[video] Review: run.py video review --inputs "
          f"{os.path.join(cfg.OUTPUT_DIR, base_name)}_v*.manifest.json")
    print(f"{'=' * 60}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_audio_noise(mp4_path: str, *, allow_noise: bool = False) -> None:
    """Check generated video audio for noise. Exits on detection unless suppressed."""
    from app.audio_noise_detect import check_audio_noise_or_exit
    check_audio_noise_or_exit(mp4_path, allow_noise=allow_noise)


def _boost_audio_volume(mp4_path: str, gain: float) -> None:
    """Post-process audio volume in-place using ffmpeg.

    LTX-2.3 MLX audio is ~50x too quiet (RMS ~0.002, peak ~0.014).
    This applies a volume gain then re-encodes the MP4 with corrected audio.

    Args:
        mp4_path: Path to the MP4 file to modify in-place.
        gain: Volume multiplier (e.g. 50 for 50x boost).
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("[video] WARNING: ffmpeg not found, skipping audio volume boost",
              file=sys.stderr)
        return

    tmp_path = mp4_path + ".tmp.mp4"
    result = subprocess.run(
        [ffmpeg, "-y", "-i", mp4_path,
         "-af", f"volume={gain}",
         "-c:v", "copy",
         tmp_path],
        capture_output=True, timeout=60,
    )
    if result.returncode == 0 and os.path.exists(tmp_path):
        os.replace(tmp_path, mp4_path)
        print(f"[video] Audio volume boosted: {gain}x")
    else:
        print(f"[video] WARNING: audio volume boost failed",
              file=sys.stderr)
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _override_args(args, variation_index: int, ab_params: dict | None):
    """Create a copy of args with per-variation parameter overrides applied."""
    import copy
    var_args = copy.copy(args)

    if ab_params is None:
        var_args.seed = args.seed + variation_index
        return var_args

    for key, values in ab_params.items():
        val = values[variation_index]
        dest_map = {
            "cfg_scale": "cfg_scale",
            "stg_scale": "stg_scale",
            "stage1_steps": "stage1_steps",
            "stage2_steps": "stage2_steps",
            "seed": "seed",
        }
        dest = dest_map.get(key, key)
        setattr(var_args, dest, val)

    if "seed" not in ab_params:
        var_args.seed = args.seed + variation_index

    return var_args


def _apply_prompt_defaults(args, defaults: dict) -> None:
    """Apply test-prompt recommended defaults for params not explicitly set by the user."""
    _ARGPARSE_DEFAULTS = {
        "frames": 97, "width": 704, "height": 480,
        "fps": 24.0, "cfg_scale": 5.0, "stg_scale": 1.0,
    }
    for prompt_key, value in defaults.items():
        if prompt_key in _ARGPARSE_DEFAULTS:
            current = getattr(args, prompt_key)
            if current == _ARGPARSE_DEFAULTS[prompt_key]:
                setattr(args, prompt_key, value)


def _extract_first_frame(video_path: str, png_path: str) -> bool:
    """Extract first frame of video to png_path using ffmpeg."""
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
