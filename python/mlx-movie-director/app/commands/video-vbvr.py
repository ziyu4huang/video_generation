"""video-vbvr — LTX-2.3 I2V generation with VBVR reasoning LoRA.

VBVR (Video Benchmark for Video Reasoning) is a LoRA trained on ~390K reasoning videos.
It improves temporal consistency, multi-object interactions, complex motion dynamics, and
causal understanding — especially for prompts involving sequential actions or physics.

Modes:
  T2V   — text-to-video (--prompt only, VBVR LoRA applied)
  I2V   — image-to-video (--input-image + --prompt, recommended)

VBVR LoRA auto-detection: searches models/lora/ for any directory containing "vbvr"
in the name. Use --vbvr-lora to specify an explicit path.

Note: --distilled is not supported (distilled pipeline has no LoRA fusion stage).

Examples:
  run.py video vbvr --input-image base.jpg --prompt "person opens a door and walks through"
  run.py video vbvr --input-image base.jpg --prompt "ball bounces off wall" --lora-scale 0.8
  run.py video vbvr --prompt "two objects collide" --frames 49 --seed 100
  run.py video vbvr --input-image base.jpg --prompt "..." --vbvr-lora models/lora/my-vbvr.safetensors
"""

import os
import shutil
import subprocess
import sys
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_prompt, resolve_lora_path
from app.manifest import Manifest
from app.run_config import RunConfig


PARSER_META = {
    "help": "LTX-2.3 I2V generation with VBVR reasoning LoRA",
    "description": (
        "Generate video with the VBVR (Video Benchmark for Video Reasoning) LoRA applied.\n\n"
        "VBVR improves: temporal consistency, multi-object interactions, complex sequential\n"
        "actions, and causal/physics reasoning. Best with an input image (I2V mode).\n\n"
        "The VBVR LoRA is auto-detected from models/lora/ (any dir with 'vbvr' in the name).\n\n"
        "Examples:\n"
        "  run.py video vbvr --input-image base.jpg --prompt 'person opens a door and walks through'\n"
        "  run.py video vbvr --input-image base.jpg --prompt '...' --lora-scale 0.8\n"
        "  run.py video vbvr --prompt 'ball bounces off wall' --frames 49\n"
        "  run.py video vbvr --input-image base.jpg --prompt '...' --low-ram\n"
    ),
}


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _run_vbvr_self_test(args):
    """VBVR self-test: verify VBVR LoRA detection + I2V generation."""
    from app.test_prompts_video import get_test_prompt

    print("[vbvr-self-test] ═══ VBVR Self-Test ═══")

    # Resolve test prompt
    tp_name = getattr(args, "self_test", None)
    if isinstance(tp_name, str) and tp_name != "True":
        prompt_name = tp_name
    else:
        prompt_name = "beach-walk"

    try:
        tp = get_test_prompt(prompt_name)
        prompt = tp["prompt"]
    except KeyError:
        print(f"[vbvr-self-test] ERROR: unknown test prompt: {prompt_name}", file=sys.stderr)
        sys.exit(1)

    print(f"[vbvr-self-test] Test prompt: {prompt_name}")

    # Auto-detect VBVR LoRA
    vbvr_lora = _find_vbvr_lora()
    if not vbvr_lora:
        print(f"[vbvr-self-test] WARNING: VBVR LoRA not found (auto-detect)", file=sys.stderr)
        print(f"[vbvr-self-test] Attempting to use default path from --vbvr-lora...")
        vbvr_lora = getattr(args, "vbvr_lora", None)
        if not vbvr_lora:
            print(f"[vbvr-self-test] ✓ Dependency check: no VBVR LoRA available (skipping generation)")
            return

    print(f"[vbvr-self-test] LoRA: {vbvr_lora}")

    # Override args for self-test
    args.prompt = prompt
    args.input_image = None  # T2V mode (no image needed)
    args.frames = 25
    args.seed = 42
    args.low_ram = getattr(args, "low_ram", True)
    args.vbvr_lora = vbvr_lora  # Ensure explicit path
    args.stage1_steps = 8
    args.stage2_steps = 3
    args.cfg_scale = 5.0
    args.stg_scale = 1.0
    args.width = 448
    args.height = 256
    args.lora_scale = 1.0
    args.hq = False
    args.teacache = False
    args.first_frame = False
    args.caption = False

    # Run generation
    print(f"[vbvr-self-test] Running VBVR T2V generation (25 frames, 448×256)...")

    # Track output before/after
    import glob as _glob
    before = set(_glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.mp4")))

    _run_vbvr_inner(args)

    after = set(_glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.mp4")))
    new_files = sorted(after - before, key=os.path.getmtime)

    if new_files:
        print(f"[vbvr-self-test] ✓ Output: {os.path.basename(new_files[-1])}")
        print(f"[vbvr-self-test] ✓ ALL PASSED")
    else:
        print(f"[vbvr-self-test] ✗ No output files generated", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# LoRA auto-detection
# ---------------------------------------------------------------------------

def _find_vbvr_lora() -> str | None:
    """Auto-detect VBVR LoRA from models/lora/ by scanning for 'vbvr' in dir names."""
    lora_base = os.path.join(cfg.MODELS_DIR, "lora")
    if not os.path.isdir(lora_base):
        return None

    matches = []
    for entry in os.listdir(lora_base):
        if "vbvr" in entry.lower() and os.path.isdir(os.path.join(lora_base, entry)):
            matches.append(entry)

    if not matches:
        return None

    if len(matches) > 1:
        print(f"[vbvr] Multiple VBVR LoRA dirs found: {', '.join(matches)}", file=sys.stderr)
        print(f"[vbvr] Using first: {matches[0]}. Use --vbvr-lora to be explicit.", file=sys.stderr)

    chosen = os.path.join(lora_base, matches[0])
    # Find the .safetensors file inside
    files = [f for f in os.listdir(chosen) if f.endswith(".safetensors")]
    if len(files) == 1:
        return os.path.abspath(os.path.join(chosen, files[0]))
    elif len(files) > 1:
        print(f"[vbvr] Multiple .safetensors in {chosen}: {', '.join(files)}", file=sys.stderr)
        print(f"[vbvr] Use --vbvr-lora <path> to specify which one.", file=sys.stderr)
        return None
    return None


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_vbvr_args(parser):
    """Register video-vbvr arguments.

    VBVR reuses the shared video flags registered by add_generate_args() on the
    same parser (--prompt, --input-image, --seed, --width, --height, --frames,
    --fps, --cfg-scale, --stg-scale, --stage1-steps, --stage2-steps, --low-ram,
    --hq, --teacache, --video-model, --first-frame, --lora-scale, etc.). Those
    shared dests are always registered before this function runs, so no
    --vbvr-* aliases for them are provided — they were previously guarded by
    _arg_registered() and silently skipped, which made flags like --vbvr-prompt
    crash with a confusing 'invalid choice' error. Only the VBVR-specific LoRA
    override is registered here.
    """
    # VBVR-specific LoRA override (auto-detected from models/lora/vbvr* if not set)
    parser.add_argument("--vbvr-lora", type=str, default=None, metavar="PATH", dest="vbvr_lora",
                        help="Explicit path to VBVR .safetensors LoRA "
                             "(auto-detected from models/lora/vbvr* if not set)")


# ---------------------------------------------------------------------------
# Resolution and frame helpers (local copies from video-generate pattern)
# ---------------------------------------------------------------------------

def _adjust_resolution(width: int, height: int) -> tuple[int, int]:
    aligned_w = max(64, round(width / 64) * 64)
    aligned_h = max(64, round(height / 64) * 64)
    if aligned_w != width or aligned_h != height:
        print(f"[vbvr] Resolution adjusted: {width}×{height} → {aligned_w}×{aligned_h} "
              f"(must be divisible by 64)")
    return aligned_w, aligned_h


def _adjust_frames(frames: int) -> int:
    if (frames - 1) % 8 == 0:
        return frames
    k = round((frames - 1) / 8)
    adjusted = max(9, 8 * k + 1)
    print(f"[vbvr] Frames adjusted: {frames} → {adjusted} (must satisfy 8k+1)")
    return adjusted


def _extract_first_frame(video_path: str, png_path: str) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    result = subprocess.run(
        [ffmpeg, "-y", "-i", video_path, "-vframes", "1", png_path],
        capture_output=True, timeout=30,
    )
    return result.returncode == 0 and os.path.exists(png_path)


def _fit_to_image(image_path: str, width: int, height: int,
                  default_w: int = 704, default_h: int = 448) -> tuple[int, int]:
    """Adjust video dims to match input image aspect ratio when using defaults."""
    import math
    try:
        from PIL import Image
        with Image.open(image_path) as im:
            img_w, img_h = im.size
    except Exception:
        return width, height

    img_ratio = img_w / img_h
    video_ratio = width / height
    ratio_diff = abs(img_ratio - video_ratio) / max(img_ratio, video_ratio)

    # Only auto-fit when user left dims at defaults
    if ratio_diff < 0.03 or (width != default_w or height != default_h):
        if ratio_diff >= 0.03 and (width != default_w or height != default_h):
            print(f"[vbvr] WARNING: image aspect {img_w}:{img_h} "
                  f"differs from video {width}×{height} (ratio diff {ratio_diff:.0%})")
        return width, height

    if width >= height:
        new_w = max(64, round(height * img_ratio / 64) * 64)
        if new_w != width:
            print(f"[vbvr] Auto-fit to image: {width}×{height} → {new_w}×{height} "
                  f"(aspect {img_ratio:.2f}:1)")
        return new_w, height
    else:
        new_h = max(64, round(width / img_ratio / 64) * 64)
        if new_h != height:
            print(f"[vbvr] Auto-fit to image: {width}×{height} → {width}×{new_h} "
                  f"(aspect {img_ratio:.2f}:1)")
        return width, new_h


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_vbvr(args):
    """Entry point for video vbvr sub-action."""
    from app.commands._shared import normalize_self_test
    normalize_self_test(args)
    if getattr(args, "self_test", None) is not None:
        _run_vbvr_self_test(args)
        return
    _run_vbvr_inner(args)


def _run_vbvr_inner(args):
    # Resolve prompt
    try:
        prompt = resolve_prompt(args)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # Resolve VBVR LoRA path
    vbvr_lora_raw = getattr(args, "vbvr_lora", None)
    if vbvr_lora_raw:
        lora_path = resolve_lora_path(vbvr_lora_raw)
    else:
        lora_path = _find_vbvr_lora()
        if lora_path is None:
            print("ERROR: VBVR LoRA not found.", file=sys.stderr)
            print("  Download it and place in models/lora/vbvr-ltx2.3/", file=sys.stderr)
            print("  Or specify with --vbvr-lora <path>", file=sys.stderr)
            print("", file=sys.stderr)
            print("  Download (siraxe, 428 MB):", file=sys.stderr)
            print("    huggingface-cli download siraxe/VBVR-LTX2.3-diffsynth_comfyui \\", file=sys.stderr)
            print("      --local-dir models/lora/vbvr-ltx2.3", file=sys.stderr)
            sys.exit(1)

    print(f"[vbvr] LoRA: {lora_path}")
    print(f"[vbvr] Scale: {args.lora_scale}")

    # Validate input image
    image_path = getattr(args, "input_image", None)
    if image_path and not os.path.exists(image_path):
        print(f"ERROR: input image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    # Auto-fit + snap resolution and frames
    if image_path and os.path.exists(image_path):
        args.width, args.height = _fit_to_image(image_path, args.width, args.height)
    args.width, args.height = _adjust_resolution(args.width, args.height)
    args.frames = _adjust_frames(args.frames)

    # HQ defaults
    if getattr(args, "hq", False) and args.stage1_steps is None:
        args.stage1_steps = 15
        print("[vbvr] HQ mode: stage1_steps auto-set to 15")

    # Base defaults
    if args.stage1_steps is None:
        args.stage1_steps = 8
    if args.stage2_steps is None:
        args.stage2_steps = 3

    mode = "VBVR-I2V" if image_path else "VBVR-T2V"
    duration_s = args.frames / args.fps
    print(f"[vbvr] Mode: {mode}  Resolution: {args.width}×{args.height}  "
          f"Duration: {args.frames} frames @ {args.fps:.0f}fps = {duration_s:.1f}s")
    print(f"[vbvr] seed={args.seed}  cfg={args.cfg_scale}  stg={args.stg_scale}  "
          f"s1_steps={args.stage1_steps}  s2_steps={args.stage2_steps}  "
          f"low-ram={args.low_ram}")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    base_path = os.path.join(cfg.OUTPUT_DIR, base_name)
    output_mp4 = base_path + ".mp4"
    run_file = base_path + ".run.json"
    manifest_file = base_path + ".manifest.json"

    # Inject lora_path into args so RunConfig.from_args picks it up
    args.lora_path = lora_path
    args.pipeline = "ltx-vbvr-i2v" if image_path else "ltx-vbvr-t2v"
    # Set fields expected by RunConfig.from_args that vbvr args don't set
    for _attr, _val in [("audio", None), ("begin_image", None), ("end_image", None),
                        ("distilled", False), ("temporal_upscale", False),
                        ("teacache_thresh", None), ("audio_stage1_only", False),
                        ("audio_cfg_scale", None), ("audio_volume", None),
                        ("allow_noise", False), ("enhance_prompt", False),
                        ("variations", 1), ("ab_params", None), ("yes", False),
                        ("first_frame", getattr(args, "first_frame", False)),
                        ("caption", False), ("skip_gpu_lock", False)]:
        if not hasattr(args, _attr):
            setattr(args, _attr, _val)

    run_config = RunConfig.from_args(args, command="video vbvr")
    run_config.to_json(run_file)

    start_time = datetime.now(timezone.utc).isoformat()

    try:
        from app.ltx_pipeline import LTXVideoPipeline

        pipeline = LTXVideoPipeline(
            model_dir=getattr(args, "video_model", None),
            low_ram=args.low_ram,
            hq=getattr(args, "hq", False),
            distilled=False,
            temporal_upscale=False,
            lora_path=lora_path,
            lora_scale=args.lora_scale,
        )

        timings = pipeline.generate(
            prompt=prompt,
            output_path=output_mp4,
            height=args.height,
            width=args.width,
            num_frames=args.frames,
            frame_rate=args.fps,
            seed=args.seed,
            stage1_steps=args.stage1_steps,
            stage2_steps=args.stage2_steps,
            cfg_scale=args.cfg_scale,
            stg_scale=args.stg_scale,
            image=image_path,
            enable_teacache=getattr(args, "teacache", False),
            teacache_thresh=None,
        )

        end_time = datetime.now(timezone.utc).isoformat()

        output_files = [{
            "path": output_mp4,
            "mode": mode,
            "seed": args.seed,
            "size_bytes": os.path.getsize(output_mp4),
            "width": args.width,
            "height": args.height,
            "frames": args.frames,
            "fps": args.fps,
            "lora": os.path.basename(lora_path),
            "lora_scale": args.lora_scale,
        }]

        # Fingerprint the key model files
        models = _collect_vbvr_fingerprints(pipeline._model_dir, lora_path)
        manifest = Manifest.from_success(run_file, start_time, end_time, timings,
                                         output_files, models)
        manifest.to_json(manifest_file)

        peak_gb = manifest.memory_peak_mb / 1024
        print(f"[vbvr] Saved:    {output_mp4}")
        print(f"[vbvr] Run:      {run_file}")
        print(f"[vbvr] Manifest: {manifest_file}")
        print(f"[vbvr] Peak RAM: {peak_gb:.1f} GB")

        if getattr(args, "first_frame", False):
            png_path = base_path + ".png"
            if _extract_first_frame(output_mp4, png_path):
                print(f"[vbvr] Frame:    {png_path}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, {}, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


def _collect_vbvr_fingerprints(model_dir: str, lora_path: str) -> dict:
    """Fingerprint key model files for the VBVR run (dev pipeline)."""
    from app.manifest import file_fingerprint

    key_files = [
        "transformer-dev.safetensors",
        "ltx-2.3-22b-distilled-lora-384.int8.safetensors",
        "connector.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
    ]
    models = {}
    if model_dir and os.path.isdir(model_dir):
        for fname in key_files:
            fpath = os.path.join(model_dir, fname)
            if os.path.exists(fpath):
                models[fname] = file_fingerprint(fpath)
    if lora_path and os.path.exists(lora_path):
        models["vbvr_lora"] = file_fingerprint(lora_path)
    return models
