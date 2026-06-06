"""profile — multi-view character profile sheet (front / back / side).

Generation strategy: pure text-to-image from empty latent, mirroring the
ComfyUI flux2-klein9b-character-profile workflow which uses EmptyFlux2LatentImage
as the sampler starting point. The optional --input-image is shown alongside the
generated views in the strip for visual reference only (not used for generation).
"""

import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name

# ---------------------------------------------------------------------------
# View definitions
# ---------------------------------------------------------------------------

ALL_VIEWS = ["front", "back", "side"]

VIEW_PROMPTS = {
    "front": (
        "Generate an A-pose front view of the character in the image, "
        "character standing upright, white background, remove background clutter, "
        "perfect body proportions, head not too large, "
        "maintain character outfit consistency"
    ),
    "back": (
        "Generate an A-pose back view of the character in the image, "
        "character standing upright, white background, remove background clutter, "
        "perfect body proportions, head not too large, "
        "maintain character outfit consistency"
    ),
    "side": (
        "Generate an A-pose side view of the character in the image, "
        "character standing upright, white background, remove background clutter, "
        "perfect body proportions, head not too large, "
        "maintain character outfit and character consistency"
    ),
}

# front/back share the same seed; side uses seed+1 — mirrors the ComfyUI workflow design
VIEW_SEED_OFFSETS = {"front": 0, "back": 0, "side": 1}

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Character profile sheet: front / back / side views (text-to-image)",
    "description": (
        "Generate a multi-view character profile sheet (front, back, side) using\n"
        "pure text-to-image generation — mirroring the ComfyUI workflow which uses\n"
        "EmptyFlux2LatentImage as the sampler starting point.\n\n"
        "If --input-image is provided it is shown as a reference panel on the left\n"
        "of the strip but does NOT influence generation (ZImage Turbo does not\n"
        "support ReferenceLatent conditioning). Use --base-prompt to describe the\n"
        "character so the model can maintain appearance consistency across views.\n\n"
        "Output folder: output/profile_YYYYMMDD_HHMMSS/\n"
        "  reference.png               — input image copy (if provided)\n"
        "  front.png, back.png, side.png — generated views\n"
        "  strip.png                   — [ref | front | back | side] horizontal stitch\n"
        "  run.json, manifest.json     — audit records\n\n"
        "Examples:\n"
        "  run.py profile --base-prompt 'young woman, light blue hanfu'\n"
        "  run.py profile --input-image char.png --base-prompt 'blue dress, silver hair'\n"
        "  run.py profile --input-image char.png --views front side --steps 6\n"
        "  run.py profile --seed 42 --steps 9"
    ),
}


def add_args(parser):
    parser.add_argument(
        "--input-image", default=None, metavar="PATH",
        help="Reference character image (optional; shown in strip but not used for generation)",
    )
    parser.add_argument(
        "--views", nargs="+", default=["front", "back", "side"],
        choices=["front", "back", "side"], metavar="VIEW",
        help="Views to generate: front back side (default: all three)",
    )
    parser.add_argument(
        "--base-prompt", type=str, default=None, metavar="TEXT",
        help=(
            "Character description appended to each view prompt — important for\n"
            "appearance consistency (e.g. 'blue dress, silver hair, young woman')"
        ),
    )
    parser.add_argument(
        "--steps", type=int, default=4,
        help="Denoising steps per view (default: 4, matches ComfyUI workflow)",
    )
    parser.add_argument(
        "--seed", type=int, default=63515082432616,
        help=(
            "Base seed (default: 63515082432616, matches ComfyUI workflow). "
            "front/back use this seed; side uses seed+1."
        ),
    )
    parser.add_argument(
        "--width", type=int, default=864,
        help="Output width per view in pixels (default: 864)",
    )
    parser.add_argument(
        "--height", type=int, default=2016,
        help="Output height per view in pixels (default: 2016)",
    )
    parser.add_argument(
        "--lora-path", type=str, default=None,
        help="Path to LoRA .safetensors file",
    )
    parser.add_argument(
        "--lora-scale", type=float, default=1.0,
        help="LoRA scale factor (default: 1.0)",
    )
    parser.add_argument(
        "--no-strip", action="store_true", default=False,
        help="Skip creating the horizontal strip image",
    )
    parser.add_argument(
        "--strip-gap", type=int, default=0, metavar="PX",
        help="Gap in pixels between panels in the strip (default: 0)",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_view_prompt(view: str, base_prompt: str | None) -> str:
    template = VIEW_PROMPTS[view]
    if base_prompt and base_prompt.strip():
        return f"{template}, {base_prompt.strip()}"
    return template


def _stitch_horizontal(images, gap: int = 0, bg_color=(255, 255, 255)):
    from PIL import Image as PILImage
    max_h = max(img.height for img in images)
    total_w = sum(img.width for img in images) + gap * (len(images) - 1)
    strip = PILImage.new("RGB", (total_w, max_h), color=bg_color)
    x = 0
    for img in images:
        strip.paste(img, (x, 0))
        x += img.width + gap
    return strip


# ---------------------------------------------------------------------------
# Command entry point
# ---------------------------------------------------------------------------

def run(args):
    from PIL import Image
    from app.pipeline import ZImagePipeline
    from app.manifest import Manifest, collect_model_fingerprint

    # Validate input image path if provided
    if args.input_image and not os.path.exists(args.input_image):
        print(f"ERROR: input image not found: {args.input_image}", file=sys.stderr)
        sys.exit(1)

    # Maintain canonical view order regardless of --views input order
    views = [v for v in ALL_VIEWS if v in args.views]

    # Create output folder: output/profile_YYYYMMDD_HHMMSS/
    base_name = f"profile_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(cfg.OUTPUT_DIR, base_name)
    os.makedirs(out_dir, exist_ok=True)

    # Write run.json
    run_meta = {
        "command": "profile",
        "mode": "t2i",
        "input_image": args.input_image,
        "views": views,
        "base_prompt": args.base_prompt,
        "steps": args.steps,
        "seed": args.seed,
        "width": args.width,
        "height": args.height,
        "lora_path": args.lora_path,
        "lora_scale": args.lora_scale,
        "strip_gap": args.strip_gap,
        "no_strip": args.no_strip,
    }
    run_file = os.path.join(out_dir, "run.json")
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Output folder: {out_dir}")
    print(f"Views: {' + '.join(views)}")
    print(f"Mode: text-to-image (empty latent start)")

    # Load reference image for display (not used in generation)
    ref_image = None
    if args.input_image:
        ref_image = Image.open(args.input_image).convert("RGB")
        ref_image.save(os.path.join(out_dir, "reference.png"))
        print(f"Reference: {args.input_image} ({ref_image.width}×{ref_image.height}) — display only")

    pipeline = ZImagePipeline()
    start_time = datetime.now(timezone.utc).isoformat()

    view_outputs = []
    view_images = []
    all_timings = {}

    try:
        for view in views:
            # NumPy seed must be in [0, 2**32-1]; fold the ComfyUI 64-bit seed
            view_seed = (args.seed + VIEW_SEED_OFFSETS[view]) % (2 ** 32)
            prompt = _build_view_prompt(view, args.base_prompt)

            print(f"\n=== {view.upper()} (seed={view_seed}) ===")
            print(f"  {prompt[:100]}...")

            # Pure text-to-image — no input_image → starts from empty noise latent,
            # matching ComfyUI's EmptyFlux2LatentImage → SamplerCustomAdvanced flow
            result = pipeline.generate(
                prompt=prompt,
                width=args.width,
                height=args.height,
                steps=args.steps,
                seed=view_seed,
                lora_path=args.lora_path,
                lora_scale=args.lora_scale,
                upscale=False,
                upscale_model=None,
            )

            view_path = os.path.join(out_dir, f"{view}.png")
            result.image.save(view_path)
            print(f"  Saved: {view_path}")

            view_images.append(result.image)
            all_timings[view] = result.timings
            view_outputs.append({
                "view": view,
                "prompt": prompt,
                "seed": view_seed,
                "path": view_path,
                "size_bytes": os.path.getsize(view_path),
                "width": result.image.width,
                "height": result.image.height,
            })

        # Build stitch list: prepend reference image (resized to view height) if provided
        stitch_images = view_images
        if ref_image and view_images:
            ref_h = view_images[0].height
            ref_w = int(ref_image.width * ref_h / ref_image.height)
            stitch_images = [ref_image.resize((ref_w, ref_h), Image.LANCZOS)] + view_images

        # Create horizontal strip
        strip_path = None
        if not args.no_strip and len(stitch_images) > 1:
            strip = _stitch_horizontal(stitch_images, gap=args.strip_gap)
            strip_path = os.path.join(out_dir, "strip.png")
            strip.save(strip_path)
            print(f"\nStrip: {strip_path}  ({strip.width}×{strip.height})")
            view_outputs.append({
                "view": "strip",
                "path": strip_path,
                "size_bytes": os.path.getsize(strip_path),
                "width": strip.width,
                "height": strip.height,
            })

        end_time = datetime.now(timezone.utc).isoformat()
        models = collect_model_fingerprint(lora_path=args.lora_path)
        manifest = Manifest.from_success(
            run_file, start_time, end_time, all_timings, view_outputs, models
        )
        manifest.to_json(os.path.join(out_dir, "manifest.json"))
        print(f"\nDone → {out_dir}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, all_timings, exc, {})
        manifest.to_json(os.path.join(out_dir, "manifest.json"))
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
