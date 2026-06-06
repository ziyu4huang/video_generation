"""upscale — standalone ESRGAN pixel upscale (no diffusion)."""

from app.commands._shared import DEFAULT_UPSCALE_MODEL, execute_upscale

PARSER_META = {
    "help": "Standalone ESRGAN 4× pixel upscale (no diffusion model)",
    "description": (
        "Upscale an image using the 4xNomosWebPhoto_RealPLKSR ESRGAN model.\n"
        "Does NOT run the diffusion pipeline — fast, ~1-2s per image.\n\n"
        "Examples:\n"
        "  run.py upscale output/base.png                       # → output/base_4x.png\n"
        "  run.py upscale --input-image base.png --output out.png\n"
        "  run.py upscale base.png --model /path/to/other.pth"
    ),
}


def add_args(parser):
    # Accept image as a positional arg OR --input-image flag
    parser.add_argument("image", nargs="?", default=None, metavar="IMAGE",
                        help="Input image path (positional shorthand for --input-image)")
    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Input image path (flag form)")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output image path (default: <input>_4x.png next to input)")
    parser.add_argument("--model", type=str, default=None, metavar="PATH",
                        help=f"Path to ESRGAN .pth model (default: {DEFAULT_UPSCALE_MODEL})")


def run(args):
    # Resolve input: positional arg takes priority over --input-image flag
    input_path = args.image or args.input_image
    if not input_path:
        import sys
        print("ERROR: provide an image path (positional) or --input-image PATH", file=sys.stderr)
        sys.exit(1)

    model_path = args.model or DEFAULT_UPSCALE_MODEL
    execute_upscale(input_path, model_path, args.output)
