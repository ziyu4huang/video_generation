"""upscale — standalone image upscale: ESRGAN (pixel) or SeedVR2 (AI diffusion)."""

from app.commands._shared import DEFAULT_UPSCALE_MODEL, execute_upscale
from app.io_utils import require_file

PARSER_META = {
    "help": "Image upscale: ESRGAN (fast pixel) or SeedVR2 (AI diffusion)",
    "description": (
        "Upscale an image using ESRGAN or SeedVR2.\n\n"
        "Methods:\n"
        "  esrgan  — Fast 4× pixel upscale, ~1-2s. Good for clean results.\n"
        "  seedvr2 — AI diffusion upscale, adds realistic detail. Often 1-step.\n\n"
        "Examples:\n"
        "  run.py upscale output/base.png                          # ESRGAN (default)\n"
        "  run.py upscale output/base.png --method seedvr2         # SeedVR2 AI upscale\n"
        "  run.py upscale output/base.png --method seedvr2 --resolution 2160\n"
        "  run.py upscale output/base.png --method seedvr2 --resolution 3x\n"
        "  run.py upscale base.png --model /path/to/other.pth      # Custom ESRGAN model\n"
    ),
}


def add_args(parser: "argparse.ArgumentParser") -> None:
    # Accept image as positional arg OR --input-image flag
    parser.add_argument("image", nargs="?", default=None, metavar="IMAGE",
                        help="Input image path (positional shorthand for --input-image)")
    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Input image path (flag form)")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output image path (default: <input>_4x.png or <input>_seedvr2.png)")
    parser.add_argument("--model", type=str, default=None, metavar="PATH",
                        help=f"Path to ESRGAN .pth model (default: {DEFAULT_UPSCALE_MODEL})")

    # Method selection
    parser.add_argument("--method", choices=["esrgan", "seedvr2"], default="esrgan",
                        help="Upscale method (default: esrgan)")

    # SeedVR2-specific args
    parser.add_argument("--resolution", type=str, default="2x",
                        help="SeedVR2 target: pixels (e.g. 2160) or scale (e.g. 2x, 3x) (default: 2x)")
    parser.add_argument("--softness", type=float, default=0.5,
                        help="SeedVR2 input softness 0.0-1.0 (default: 0.5)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Seed for SeedVR2 noise (default: 42)")


def run(args: "argparse.Namespace") -> None:
    input_path = require_file(
        args.image or args.input_image,
        "input image (positional arg or --input-image)",
    )
    method = args.method

    if method == "esrgan":
        model_path = args.model or DEFAULT_UPSCALE_MODEL
        execute_upscale(input_path, model_path, args.output)
    elif method == "seedvr2":
        _run_seedvr2(input_path, args)


def _run_seedvr2(input_path: str, args) -> None:
    """Run SeedVR2 AI upscale."""
    import os
    from app.io_utils import load_image_rgb
    from app.seedvr2.pipeline import SeedVR2Upscaler

    # Parse resolution: "2160" → int, "2x" → float
    res_str = args.resolution
    if res_str.lower().endswith("x"):
        resolution = float(res_str.lower().rstrip("x"))
    else:
        try:
            resolution = int(res_str)
        except ValueError:
            print(f"ERROR: invalid resolution '{res_str}'. Use pixels (e.g. 2160) or scale (e.g. 2x)", file=sys.stderr)
            sys.exit(1)

    image = load_image_rgb(input_path)
    w0, h0 = image.size
    print(f"SeedVR2 upscale: {input_path} ({w0}×{h0}) → resolution={resolution}, softness={args.softness}, seed={args.seed}")

    upscaler = SeedVR2Upscaler(model_size="7b")
    try:
        result = upscaler.upscale(
            image=image,
            resolution=resolution,
            softness=args.softness,
            seed=args.seed,
        )
    finally:
        upscaler.unload()

    # Output path
    output_path = args.output
    if output_path is None:
        base, ext = os.path.splitext(input_path)
        scale_str = f"{resolution}x" if isinstance(resolution, float) else str(resolution)
        output_path = f"{base}_seedvr2_{scale_str}{ext or '.png'}"

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    result.save(output_path)
    print(f"Saved: {output_path}")
