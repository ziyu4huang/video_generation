"""profile — multi-view character profile sheet (front / back / side).

Two pipeline modes:

  flux2-klein (default when --input-image is provided):
    Uses mflux Flux2KleinEdit with real reference-image conditioning.
    The reference image latent is concatenated into the attention sequence
    (prepare_reference_image_conditioning), giving the model genuine knowledge
    of the character appearance.  Requires Klein 4B (~15 GB, auto-downloaded
    from HuggingFace on first use).

  zimage (fallback when no --input-image, or --pipeline zimage):
    Pure text-to-image from empty latent via ZImagePipeline.  Matches the
    ComfyUI EmptyFlux2LatentImage starting point.  --base-prompt is the only
    way to describe the character.
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

# Flux2 Klein: reference image is injected as conditioning — prompts are view-only
VIEW_PROMPTS_FLUX2 = {
    "front": (
        "A-pose front view full body character design sheet, "
        "character standing upright, white background, "
        "professional anime/game character design"
    ),
    "back": (
        "A-pose back view full body character design sheet, "
        "character standing upright, white background, "
        "professional anime/game character design"
    ),
    "side": (
        "A-pose side view full body character design sheet, "
        "character standing upright, white background, "
        "professional anime/game character design"
    ),
}

# front/back share the same seed; side uses seed+1 — mirrors the ComfyUI workflow design
VIEW_SEED_OFFSETS = {"front": 0, "back": 0, "side": 1}

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Character profile sheet: front / back / side views",
    "description": (
        "Generate a multi-view character profile sheet (front, back, side).\n\n"
        "Pipeline selection (--pipeline):\n"
        "  auto        — flux2-klein when --input-image is given, zimage otherwise\n"
        "  flux2-klein — Flux2 Klein 4B with real reference conditioning (mflux).\n"
        "                Reference image latent is injected into attention; model\n"
        "                genuinely sees and follows the character appearance.\n"
        "                First run downloads ~15 GB from HuggingFace.\n"
        "  zimage      — ZImage Turbo pure text-to-image (original behaviour).\n"
        "                Use --base-prompt to describe the character.\n\n"
        "Output folder: output/profile_YYYYMMDD_HHMMSS/\n"
        "  reference.png               — input image copy (if provided)\n"
        "  front.png, back.png, side.png — generated views\n"
        "  strip.png                   — [ref | front | back | side] horizontal stitch\n"
        "  run.json, manifest.json     — audit records\n\n"
        "Examples:\n"
        "  run.py profile --input-image char.png                  # flux2-klein (auto)\n"
        "  run.py profile --input-image char.png --quantize 8     # quantize Klein to INT8\n"
        "  run.py profile --input-image char.png --pipeline zimage # force ZImage t2i\n"
        "  run.py profile --pipeline zimage --base-prompt 'blue hanfu woman'\n"
        "  run.py profile --flux2-model-path /local/klein-4b/ --steps 4"
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
    # Pipeline selection
    parser.add_argument(
        "--pipeline", choices=["auto", "flux2-klein", "zimage"], default="auto",
        help=(
            "auto: flux2-klein when --input-image present, zimage otherwise. "
            "flux2-klein: Flux2 Klein 4B with reference conditioning (mflux). "
            "zimage: ZImage Turbo text-to-image."
        ),
    )
    parser.add_argument(
        "--flux2-model-path", default=None, metavar="PATH",
        help=(
            "Local path to Klein 4B model in HuggingFace directory structure "
            "(transformer/, vae/, text_encoder/, tokenizer/). "
            "Omit to let mflux auto-download from HuggingFace."
        ),
    )
    parser.add_argument(
        "--quantize", type=int, choices=[4, 8], default=None, metavar="BITS",
        help="Quantization for Flux2 Klein (4 or 8 bits). Recommended: 8 for MPS.",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_view_prompt(view: str, base_prompt: str | None, pipeline_type: str = "zimage") -> str:
    if pipeline_type == "flux2-klein":
        template = VIEW_PROMPTS_FLUX2[view]
    else:
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
    from app.manifest import Manifest, collect_model_fingerprint

    # Validate input image path if provided
    if args.input_image and not os.path.exists(args.input_image):
        print(f"ERROR: input image not found: {args.input_image}", file=sys.stderr)
        sys.exit(1)

    # Determine pipeline type
    use_flux2 = (
        args.pipeline == "flux2-klein"
        or (args.pipeline == "auto" and args.input_image is not None)
    )
    pipeline_type = "flux2-klein" if use_flux2 else "zimage"

    # Maintain canonical view order regardless of --views input order
    views = [v for v in ALL_VIEWS if v in args.views]

    # Create output folder: output/profile_YYYYMMDD_HHMMSS/
    base_name = f"profile_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(cfg.OUTPUT_DIR, base_name)
    os.makedirs(out_dir, exist_ok=True)

    # Write run.json
    run_meta = {
        "command": "profile",
        "pipeline": pipeline_type,
        "mode": "reference-conditioning" if use_flux2 else "t2i",
        "input_image": args.input_image,
        "views": views,
        "base_prompt": args.base_prompt,
        "steps": args.steps,
        "seed": args.seed,
        "width": args.width,
        "height": args.height,
        "lora_path": getattr(args, "lora_path", None),
        "lora_scale": getattr(args, "lora_scale", 1.0),
        "strip_gap": args.strip_gap,
        "no_strip": args.no_strip,
        "flux2_model_path": getattr(args, "flux2_model_path", None),
        "quantize": getattr(args, "quantize", None),
    }
    run_file = os.path.join(out_dir, "run.json")
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Output folder: {out_dir}")
    print(f"Views: {' + '.join(views)}")
    print(f"Pipeline: {pipeline_type}")

    # Load reference image
    ref_image = None
    if args.input_image:
        ref_image = Image.open(args.input_image).convert("RGB")
        ref_image.save(os.path.join(out_dir, "reference.png"))
        ref_note = "reference conditioning" if use_flux2 else "display only"
        print(f"Reference: {args.input_image} ({ref_image.width}×{ref_image.height}) — {ref_note}")

    # Initialise the chosen pipeline (once — model stays loaded across all views)
    if use_flux2:
        from app.flux2_pipeline import Flux2KleinPipeline
        pipeline = Flux2KleinPipeline(
            model_path=getattr(args, "flux2_model_path", None),
            quantize=getattr(args, "quantize", None),
        )
    else:
        from app.pipeline import ZImagePipeline
        pipeline = ZImagePipeline()

    start_time = datetime.now(timezone.utc).isoformat()

    view_outputs = []
    view_images = []
    all_timings = {}

    try:
        for view in views:
            # NumPy/mflux seed must be in [0, 2**32-1]; fold the ComfyUI 64-bit seed
            view_seed = (args.seed + VIEW_SEED_OFFSETS[view]) % (2 ** 32)
            prompt = _build_view_prompt(view, args.base_prompt, pipeline_type)

            print(f"\n=== {view.upper()} (seed={view_seed}) ===")
            print(f"  {prompt[:120]}...")

            if use_flux2:
                result = pipeline.generate(
                    seed=view_seed,
                    prompt=prompt,
                    reference_images=[args.input_image] if args.input_image else [],
                    width=args.width,
                    height=args.height,
                    steps=args.steps,
                )
            else:
                result = pipeline.generate(
                    prompt=prompt,
                    width=args.width,
                    height=args.height,
                    steps=args.steps,
                    seed=view_seed,
                    lora_path=getattr(args, "lora_path", None),
                    lora_scale=getattr(args, "lora_scale", 1.0),
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
