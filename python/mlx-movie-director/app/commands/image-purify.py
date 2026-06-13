"""image-purify — SeedVR2 AI high-quality redraw + upscale.

Uses SeedVR2's single-step diffusion with controlled softness to purify,
enhance, or fully redraw an image while optionally increasing resolution.

Mode presets control how much creative freedom the model has:
  purify  — light cleanup (softness 0.3), preserves most original detail
  enhance — balanced enhancement (softness 0.5, default)
  redraw  — high creative freedom (softness 0.8), model reinterprets content

Resolution can be:
  same   — output matches input size (pure purification, no upscale)
  2x     — scale by factor
  2160   — target shortest-side pixels

Examples:
  run.py image purify --input-image output/photo.png
  run.py image purify --input-image output/photo.png --purify-mode redraw --resolution 2x
  run.py image purify --input-image output/photo.png --purify-mode purify --resolution same
  run.py image purify --input-image output/photo.png --softness-override 0.95 --resolution same
  run.py image purify --input-image output/photo.png --purify-mode enhance --resolution 2160
  run.py image purify --input-image photo.png --purify-mode enhance --resolution 2x --film-grain 0.02 --sharpening 0.1
"""

import os
import sys

from app.commands._shared import _arg_registered

# ---------------------------------------------------------------------------
# Mode presets — softness controls pre-downsampling before diffusion
# ---------------------------------------------------------------------------

MODE_PRESETS = {
    "purify": 0.3,   # light cleanup, minimal reinterpretation
    "enhance": 0.5,  # balanced enhancement (default)
    "redraw": 0.8,   # high creative freedom, model reinterprets content
}

PARSER_META = {
    "help": "SeedVR2 AI high-quality redraw + upscale (purify / enhance / redraw)",
    "description": __doc__,
}


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_purify_args(parser):
    """Register purify-specific CLI arguments.

    Uses _arg_registered guards to avoid conflicts with other image
    subcommands that share the same parser (e.g. faceswap --mode,
    workflow --film-grain, _shared --seed).

    Note: No positional IMAGE arg — the image dispatcher already has
    `action` and `sub_action` positionals, so a third positional would
    conflict. Use --input-image instead.
    """

    # Mode preset (--purify-mode to avoid conflict with faceswap --mode)
    parser.add_argument(
        "--purify-mode", dest="purify_mode", choices=list(MODE_PRESETS.keys()), default="enhance",
        help=f"Purify mode preset (default: enhance). "
             f"purify=softness {MODE_PRESETS['purify']}, "
             f"enhance=softness {MODE_PRESETS['enhance']}, "
             f"redraw=softness {MODE_PRESETS['redraw']}",
    )

    # Resolution (guard: image-expansion registers --resolution too)
    if not _arg_registered(parser, "resolution"):
        parser.add_argument(
            "--resolution", type=str, default="same",
            help='Target resolution: "same" (no resize), pixels (e.g. 2160), or scale (e.g. 2x, 3x) (default: same)',
        )

    # Softness override (unique to purify — no guard needed)
    parser.add_argument(
        "--softness-override", type=float, default=None, metavar="FLOAT",
        help="Override mode's default softness (0.0-1.0). Advanced users only.",
    )

    # Seed (guard: _shared and others register --seed)
    if not _arg_registered(parser, "seed"):
        parser.add_argument(
            "--seed", type=int, default=42,
            help="Seed for SeedVR2 noise (default: 42)",
        )

    # Optional postprocessing (guard: image-workflow registers these)
    if not _arg_registered(parser, "film_grain"):
        parser.add_argument(
            "--film-grain", type=float, default=0.0, metavar="FLOAT",
            help="Add film grain after purification (0.0-0.03 typical, default: 0)",
        )
    if not _arg_registered(parser, "sharpening"):
        parser.add_argument(
            "--sharpening", type=float, default=0.0, metavar="FLOAT",
            help="CAS sharpening after purification (0.0-0.3 typical, default: 0)",
        )

    # Output (guard: upscale and caption register --output)
    if not _arg_registered(parser, "output"):
        parser.add_argument(
            "--output", type=str, default=None, metavar="PATH",
            help="Output image path (default: <input>_purify_<mode>_<resolution>.png)",
        )


# ---------------------------------------------------------------------------
# Resolution parsing (reused pattern from upscale.py)
# ---------------------------------------------------------------------------

def _parse_resolution(res_str: str) -> tuple:
    """Parse resolution string into (value, label).

    Returns (value, label) where value is int|float and label is a display
    string for the output filename.
    """
    if res_str.lower() == "same":
        return 1.0, "same"
    if res_str.lower().endswith("x"):
        scale = float(res_str.lower().rstrip("x"))
        return scale, f"{scale}x"
    try:
        pixels = int(res_str)
        return pixels, str(pixels)
    except ValueError:
        print(
            f"ERROR: invalid resolution '{res_str}'. "
            f"Use 'same', pixels (e.g. 2160), or scale (e.g. 2x)",
            file=sys.stderr,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_purify(args) -> None:
    """Run SeedVR2 purification / redraw / upscale."""
    from PIL import Image
    from app.seedvr2.pipeline import SeedVR2Upscaler

    # Resolve input path
    input_path = getattr(args, "input_image", None)
    if not input_path:
        print("ERROR: provide --input-image PATH", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(input_path):
        print(f"ERROR: input image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Determine softness: override > mode preset
    mode = getattr(args, "purify_mode", "enhance") or "enhance"
    softness = args.softness_override if args.softness_override is not None else MODE_PRESETS[mode]

    # Parse resolution
    res_str = getattr(args, "resolution", "same") or "same"
    resolution, res_label = _parse_resolution(res_str)

    # Load image
    image = Image.open(input_path).convert("RGB")
    w0, h0 = image.size
    print(f"[purify] {input_path} ({w0}x{h0}) mode={mode} softness={softness} "
          f"resolution={resolution} seed={args.seed}")

    # Run SeedVR2
    upscaler = SeedVR2Upscaler(model_size="7b")
    try:
        result = upscaler.upscale(
            image=image,
            resolution=resolution,
            softness=softness,
            seed=args.seed,
        )
    finally:
        upscaler.unload()

    # Optional postprocessing
    film_grain = getattr(args, "film_grain", 0.0) or 0.0
    sharpening = getattr(args, "sharpening", 0.0) or 0.0
    if film_grain > 0 or sharpening > 0:
        from app.postprocess import PostProcessChain

        chain = PostProcessChain.from_config({
            "sharpening": sharpening,
            "film_grain": film_grain,
        })
        result, pp_timings = chain.apply(result, seed=args.seed)
        if chain.has_filters():
            for name, elapsed in pp_timings.items():
                print(f"  [postprocess] {name}: {elapsed:.2f}s")

    # Output path
    output_path = getattr(args, "output", None)
    if output_path is None:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_purify_{mode}_{res_label}{ext or '.png'}"

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    result.save(output_path)

    w1, h1 = result.size
    print(f"[purify] Saved: {output_path} ({w1}x{h1})")
