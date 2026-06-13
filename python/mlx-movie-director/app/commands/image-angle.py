"""image-angle — angle-view reframe sub-action for 'run.py image angle'.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_angle_args(parser)  — register angle-specific CLI arguments
  run_angle(args)         — execute angle-view reframe
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import DEFAULT_UPSCALE_MODEL, _apply_upscale

_ANGLE_DEFAULT_STEPS = 6


def add_angle_args(parser: "argparse.ArgumentParser") -> None:
    """Register angle-specific arguments on an argparse parser."""
    parser.add_argument(
        "--input",
        metavar="IMAGE",
        default=None,
        help="Reference image path. Required for 'angle' sub-action. "
             "For T2I: provides visual anchor for image-conditioned generation — "
             "use with same seed + different prompt to generate FLF2V keyframe pairs "
             "with consistent background.",
    )
    parser.add_argument(
        "--azimuth",
        type=float,
        default=90.0,
        metavar="DEG",
        help="Horizontal camera angle: 0=front 90=right 180=back 270=left (default: 90)",
    )
    parser.add_argument(
        "--elevation",
        type=float,
        default=0.0,
        metavar="DEG",
        help="Vertical camera angle: >0=high-angle(camera above) <0=low-angle(camera below) (default: 0)",
    )


def run_angle(args: "argparse.Namespace") -> None:
    """Execute angle-view reframe. Called by image.py dispatcher."""
    if not args.input:
        print("ERROR: 'image angle' requires --input IMAGE_PATH", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.input):
        print(f"ERROR: Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    steps = args.steps if args.steps is not None else _ANGLE_DEFAULT_STEPS
    seed = args.seed % (2 ** 32)

    # Apply defaults for shared args (t2i sets these too, but angle may run alone)
    width = args.width if args.width is not None else 640
    height = args.height if args.height is not None else 960

    angle_text = _angle_to_text(args.azimuth, args.elevation)
    user_prompt = getattr(args, "prompt", None)
    if getattr(args, "prompt_file", None):
        with open(args.prompt_file, "r") as f:
            user_prompt = f.read().strip()
    prompt = _build_angle_prompt(user_prompt, angle_text)

    print(f"Input:  {args.input}")
    print(f"Angle:  azimuth={args.azimuth}°  elevation={args.elevation}°  → \"{angle_text}\"")
    print(f"Prompt: {prompt}")
    print(f"Size:   {width}×{height}  steps={steps}  seed={seed}")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = f"image_angle_{time.strftime('%Y%m%d_%H%M%S')}"
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")

    run_meta = {
        "command": "image",
        "action": "angle",
        "input": args.input,
        "azimuth": args.azimuth,
        "elevation": args.elevation,
        "angle_text": angle_text,
        "prompt": prompt,
        "width": width,
        "height": height,
        "steps": steps,
        "seed": seed,
        "variant": getattr(args, "variant", "9b"),
    }
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    start_time = datetime.now(timezone.utc).isoformat()
    last_timings = {}
    all_outputs = []

    upscale_model = None
    if args.upscale:
        upscale_model = getattr(args, "upscale_model", None) or DEFAULT_UPSCALE_MODEL
    upscale_method = getattr(args, "upscale_method", "esrgan")

    from app.flux2_pipeline import Flux2KleinPipeline
    from app.manifest import Manifest, collect_model_fingerprint

    pipeline = Flux2KleinPipeline(
        model_path=getattr(args, "flux2_model_path", None),
        quantize=getattr(args, "quantize", None),
        variant=getattr(args, "variant", "9b"),
        transformer_name=getattr(args, "transformer", "klein-9b"),
    )

    try:
        count = max(1, getattr(args, "count", 1))
        seed_start = getattr(args, "seed_start", None)

        for i in range(count):
            item_seed = ((seed_start + i) if seed_start is not None else seed) % (2 ** 32)
            if count > 1:
                print(f"\n=== Batch {i + 1}/{count} (seed={item_seed}) ===")

            result = pipeline.generate(
                seed=item_seed,
                prompt=prompt,
                reference_images=[args.input],
                width=width,
                height=height,
                steps=steps,
            )

            if args.upscale and upscale_model:
                result = _apply_upscale(
                    result, upscale_method, upscale_model,
                    upscale_resolution=getattr(args, "upscale_resolution", "2x"),
                    upscale_softness=getattr(args, "upscale_softness", 0.5),
                    seed=item_seed,
                )

            suffix = f"_s{item_seed}" if count > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}{suffix}.png")
            result.image.save(out_path)
            print(f"Saved: {out_path}")

            last_timings = result.timings
            all_outputs.append({
                "path": out_path,
                "seed": item_seed,
                "size_bytes": os.path.getsize(out_path),
                "width": result.image.width,
                "height": result.image.height,
            })

        end_time = datetime.now(timezone.utc).isoformat()
        models = collect_model_fingerprint(lora_path=None, upscale_model=upscale_model)
        manifest = Manifest.from_success(run_file, start_time, end_time,
                                         last_timings, all_outputs, models)
        manifest.to_json(manifest_file)
        print(f"Run config: {run_file}")
        print(f"Manifest:   {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, last_timings, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _angle_to_text(azimuth: float, elevation: float) -> str:
    """Convert azimuth/elevation degrees to a human-readable camera-angle phrase."""
    directions = [
        "front view",
        "front-right three-quarter view",
        "right side profile",
        "rear-right three-quarter view",
        "back view",
        "rear-left three-quarter view",
        "left side profile",
        "front-left three-quarter view",
    ]
    az_idx = int((azimuth % 360 + 22.5) / 45) % 8
    az_text = directions[az_idx]

    if elevation > 20:
        el_text = ", high angle shot (camera above, looking down)"
    elif elevation < -20:
        el_text = ", low angle shot (camera below, looking up)"
    else:
        el_text = ""

    return az_text + el_text


def _build_angle_prompt(user_prompt: str | None, angle_text: str) -> str:
    """Build the Flux2-Klein generation prompt for an angle reframe."""
    if user_prompt:
        base = f"{user_prompt}，"
    else:
        base = "保持人物外貌、服裝、髮型完全一致，"
    return (
        f"{base}{angle_text}, "
        "photorealistic, maintain character identity and appearance consistency"
    )
