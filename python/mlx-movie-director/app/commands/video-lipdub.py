"""video-lipdub — LTX-2.3 reference-video lip-dubbing via the LipDub IC-LoRA.

LipDub re-synthesizes a talking-head video with the mouth re-synced to the
reference video's OWN audio track. The reference video supplies both the
visual structure (via IC-LoRA conditioning) and the target speech (its audio
is VAE-encoded and appended as a reference-audio conditioning). This is the
precision upgrade over the coarse IA2V (`video generate --input-image X
--audio Y`) talking-portrait path — see docs/lipsync-precision-measurement.

The pipeline is two-stage IC-LoRA (both stages distilled for efficiency), so
it uses the distilled model dir. Frame count / fps come from the reference
video itself (snapped to the 8k+1 grid by the vendor).

The LipDub IC-LoRA is auto-detected from mlx-models/lora/ (any dir with
"lipdub" in the name). Use --lipdub-lora to specify an explicit path.
The checkpoint is HF-gated (Lightricks/LTX-2.3-22b-IC-LoRA-LipDub) — accept
the license at the model page before downloading.

Examples:
  run.py video lipdub --lipdub-reference-video talking_head.mp4 \\
    --prompt 'a person speaking to the camera, natural lip motion'
  run.py video lipdub --lipdub-reference-video head.mp4 --prompt '...' \\
    --width 512 --height 512 --reference-strength 1.0 --low-ram
"""

import os
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_prompt, resolve_lora_path
from app.manifest import Manifest
from app.run_config import RunConfig


PARSER_META = {
    "help": "LTX-2.3 reference-video lip-dubbing via the LipDub IC-LoRA",
    "description": (
        "Re-sync a talking-head video's mouth to its own audio track with the "
        "LipDub IC-LoRA (two-stage, distilled).\n\n"
        "The reference video supplies both visual structure (IC-LoRA) and the "
        "target speech (VAE-encoded reference audio). This is the precision "
        "upgrade over the coarse IA2V talking-portrait path.\n\n"
        "The LipDub IC-LoRA auto-detects from mlx-models/lora/*lipdub*; use "
        "--lipdub-lora for an explicit path. Frame count/fps come from the "
        "reference video.\n\n"
        "Examples:\n"
        "  run.py video lipdub --lipdub-reference-video head.mp4 --prompt "
        "'person speaking, natural lip motion'\n"
        "  run.py video lipdub --lipdub-reference-video head.mp4 --prompt '...' "
        "--width 512 --height 512 --low-ram\n"
    ),
}


# ---------------------------------------------------------------------------
# LoRA auto-detection
# ---------------------------------------------------------------------------

def _find_lipdub_lora() -> str | None:
    """Auto-detect the LipDub IC-LoRA from mlx-models/lora/*lipdub*."""
    lora_base = os.path.join(cfg.MODELS_DIR, "lora")
    if not os.path.isdir(lora_base):
        return None
    matches = [
        e for e in os.listdir(lora_base)
        if "lipdub" in e.lower() and os.path.isdir(os.path.join(lora_base, e))
    ]
    if not matches:
        return None
    if len(matches) > 1:
        print(f"[lipdub] Multiple LipDub LoRA dirs found: {', '.join(matches)}", file=sys.stderr)
        print(f"[lipdub] Using first: {matches[0]}. Use --lipdub-lora to be explicit.", file=sys.stderr)
    chosen = os.path.join(lora_base, matches[0])
    files = [f for f in os.listdir(chosen) if f.endswith(".safetensors")]
    if len(files) == 1:
        return os.path.abspath(os.path.join(chosen, files[0]))
    if len(files) > 1:
        print(f"[lipdub] Multiple .safetensors in {chosen}: {', '.join(files)}", file=sys.stderr)
        print("[lipdub] Use --lipdub-lora <path> to specify which one.", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_lipdub_args(parser):
    """Register video-lipdub arguments.

    LipDub reuses the shared video flags registered by add_generate_args() on
    the same parser (--prompt, --width, --height, --seed, --stage1-steps,
    --stage2-steps, --low-ram, --lora-scale, --video-model, --first-frame,
    --output). Only the LipDub-specific flags are registered here.
    """
    parser.add_argument("--lipdub-reference-video", type=str, default=None, metavar="PATH",
                        dest="lipdub_reference_video",
                        help="Reference talking-head video (supplies visual structure + "
                             "target speech audio). Must contain an audio stream.")
    parser.add_argument("--lipdub-lora", type=str, default=None, metavar="PATH",
                        dest="lipdub_lora",
                        help="Explicit path to the LipDub IC-LoRA .safetensors "
                             "(auto-detected from mlx-models/lora/*lipdub* if not set)")
    parser.add_argument("--reference-strength", type=float, default=1.0,
                        dest="reference_strength",
                        help="IC-LoRA reference conditioning strength (default 1.0)")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _has_audio_stream(video_path: str) -> bool:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return True  # can't check — assume present, let the pipeline validate
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "csv=p=0", video_path],
        capture_output=True, text=True, timeout=30,
    )
    return bool(result.stdout.strip())


def _adjust_resolution(width: int, height: int) -> tuple[int, int]:
    aligned_w = max(64, round(width / 64) * 64)
    aligned_h = max(64, round(height / 64) * 64)
    if aligned_w != width or aligned_h != height:
        print(f"[lipdub] Resolution adjusted: {width}×{height} → {aligned_w}×{aligned_h} "
              f"(must be divisible by 64)")
    return aligned_w, aligned_h


def _extract_first_frame(video_path: str, png_path: str) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    result = subprocess.run(
        [ffmpeg, "-y", "-i", video_path, "-vframes", "1", png_path],
        capture_output=True, timeout=30,
    )
    return result.returncode == 0 and os.path.exists(png_path)


def _collect_lipdub_fingerprints(model_dir: str, lora_path: str) -> dict:
    """Fingerprint key model files for the LipDub run (distilled IC-LoRA path)."""
    from app.manifest import file_fingerprint

    key_files = [
        "transformer-distilled.safetensors",
        "connector.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
        "audio_vae.safetensors",
    ]
    models = {}
    if model_dir and os.path.isdir(model_dir):
        for fname in key_files:
            fpath = os.path.join(model_dir, fname)
            if os.path.exists(fpath):
                models[fname] = file_fingerprint(fpath)
    if lora_path and os.path.exists(lora_path):
        models["lipdub_lora"] = file_fingerprint(lora_path)
    return models


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_lipdub(args):
    """Entry point for the `video lipdub` sub-action."""
    # Resolve prompt
    try:
        prompt = resolve_prompt(args)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # Reference video
    ref_video = getattr(args, "lipdub_reference_video", None)
    if not ref_video:
        print("ERROR: --lipdub-reference-video is required for lip-dubbing", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(ref_video):
        print(f"ERROR: reference video not found: {ref_video}", file=sys.stderr)
        sys.exit(1)
    if not _has_audio_stream(ref_video):
        print(f"ERROR: reference video has no audio stream (LipDub needs the target "
              f"speech from the reference): {ref_video}", file=sys.stderr)
        sys.exit(1)

    # Resolve LipDub LoRA
    lipdub_lora_raw = getattr(args, "lipdub_lora", None)
    if lipdub_lora_raw:
        lora_path = resolve_lora_path(lipdub_lora_raw)
    else:
        lora_path = _find_lipdub_lora()
        if lora_path is None:
            print("ERROR: LipDub IC-LoRA not found.", file=sys.stderr)
            print("  Accept the license + download (HF-gated), then place in "
                  "mlx-models/lora/ltx-2-3-lipdub/", file=sys.stderr)
            print("    https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-LipDub", file=sys.stderr)
            print("  Or specify with --lipdub-lora <path>", file=sys.stderr)
            sys.exit(1)

    # Resolution snap
    args.width, args.height = _adjust_resolution(args.width, args.height)

    # LoRA scale: --lora-scale is action="append" on the shared parser → list.
    lora_scale = getattr(args, "lora_scale", None)
    if isinstance(lora_scale, list):
        lora_scale = lora_scale[0] if lora_scale else 1.0
    elif lora_scale is None:
        lora_scale = 1.0

    reference_strength = getattr(args, "reference_strength", 1.0)

    print(f"[lipdub] LoRA: {lora_path}  scale={lora_scale}")
    print(f"[lipdub] Reference video: {ref_video}")
    print(f"[lipdub] Resolution: {args.width}×{args.height}  "
          f"reference_strength={reference_strength}  seed={args.seed}  "
          f"low-ram={args.low_ram}")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    base_path = os.path.join(cfg.OUTPUT_DIR, base_name)
    output_mp4 = base_path + ".mp4"
    run_file = base_path + ".run.json"
    manifest_file = base_path + ".manifest.json"

    # Inject fields expected by RunConfig.from_args. lora_path/lora_scale must be
    # LISTS here: RunConfig.from_args resolves them via resolve_lora_paths()
    # (multi-LoRA, action="append" contract) — a bare string would be iterated
    # character-by-character. Set both as single-element lists.
    args.lora_path = [lora_path]
    args.lora_scale = [lora_scale]
    args.pipeline = "ltx-lipdub"
    for _attr, _val in [("audio", None), ("input_image", None), ("begin_image", None),
                        ("end_image", None), ("distilled", True), ("temporal_upscale", False),
                        ("teacache", False), ("teacache_thresh", None),
                        ("audio_stage1_only", False), ("audio_cfg_scale", None),
                        ("audio_volume", None), ("allow_noise", False),
                        ("enhance_prompt", False), ("variations", 1), ("ab_params", None),
                        ("yes", False), ("hq", False), ("images", None),
                        ("first_frame", getattr(args, "first_frame", False)),
                        ("caption", False), ("skip_gpu_lock", False)]:
        if not hasattr(args, _attr):
            setattr(args, _attr, _val)

    run_config = RunConfig.from_args(args, command="video lipdub")
    run_config.to_json(run_file)

    start_time = datetime.now(timezone.utc).isoformat()
    try:
        from app.ltx_pipeline import LTXVideoPipeline

        # LipDub's ICLoraPipeline base resolves its transformer via
        # `transformer-distilled*.safetensors`, which only the DISTILLED flat
        # assembly dir carries (transformer-distilled-1.1.safetensors). Passing
        # `distilled=True` alone yields the DEV assembly dir (transformer-dev +
        # runtime LoRA fusion) and the IC-LoRA loader can't find its weights —
        # so request the distilled variant explicitly.
        pipeline = LTXVideoPipeline(
            model_dir=getattr(args, "video_model", None),
            low_ram=args.low_ram,
            transformer="distilled",
        )

        print("[lipdub] Running LipDub lip-dubbing…")
        t0 = time.time()
        timings = pipeline.generate_lipdub(
            prompt=prompt,
            output_path=output_mp4,
            reference_video_path=ref_video,
            lipdub_lora_path=lora_path,
            lora_scale=lora_scale,
            height=args.height,
            width=args.width,
            reference_strength=reference_strength,
            seed=args.seed,
            stage1_steps=getattr(args, "stage1_steps", None),
            stage2_steps=getattr(args, "stage2_steps", None),
        )
        elapsed = timings.get("generate_seconds", time.time() - t0)
        print(f"[lipdub] Generation done in {elapsed:.1f}s")

        end_time = datetime.now(timezone.utc).isoformat()

        output_files = [{
            "path": output_mp4,
            "mode": "LipDub",
            "seed": args.seed,
            "size_bytes": os.path.getsize(output_mp4) if os.path.exists(output_mp4) else 0,
            "width": args.width,
            "height": args.height,
            "reference_video": os.path.basename(ref_video),
            "lora": os.path.basename(lora_path),
            "lora_scale": lora_scale,
        }]
        models = _collect_lipdub_fingerprints(pipeline._model_dir, lora_path)
        # Events (model_loaded / lora_applied / denoise_config) ride inside the
        # timings dict into the manifest, same as the vbvr sub-action.
        manifest = Manifest.from_success(run_file, start_time, end_time, timings,
                                         output_files, models)
        manifest.to_json(manifest_file)

        print(f"[lipdub] Saved:    {output_mp4}")
        print(f"[lipdub] Manifest: {manifest_file}")

        if getattr(args, "first_frame", False):
            png_path = base_path + ".png"
            if _extract_first_frame(output_mp4, png_path):
                print(f"[lipdub] Frame:    {png_path}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, {}, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
