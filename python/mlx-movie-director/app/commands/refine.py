"""refine — img2img: VAE encode → latent upscale → partial re-denoise."""

from app.commands._shared import add_common_generation_args, execute_generation
from app.run_config import RunConfig

PARSER_META = {
    "help": "Image-to-image refinement (latent upscale + re-denoise)",
    "description": (
        "Encode an existing image into latent space, optionally upscale it, "
        "then re-denoise with a new prompt.\n\n"
        "Matches the moody-zimage ComfyUI workflow stage 2:\n"
        "  LatentUpscaleBy 1.7× (bislerp) + KSampler denoise ~0.5\n\n"
        "Examples:\n"
        "  # Latent refine: keep structure, add detail\n"
        "  run.py refine --prompt '...' --input-image out/base.png --denoise-strength 0.4\n\n"
        "  # Moody flow stage 2: latent upscale + ESRGAN\n"
        "  run.py refine --prompt '...' --input-image out/base.png \\\n"
        "      --latent-upscale 1.7 --denoise-strength 0.5 --upscale"
    ),
}


def add_args(parser):
    # Required input
    parser.add_argument("--input-image", required=True, metavar="PATH",
                        help="Input image to refine (required)")

    # Latent-space controls
    parser.add_argument("--latent-upscale", type=float, default=1.0, metavar="FACTOR",
                        help="Upscale input latent by this factor (e.g. 1.7 → 1088×1632 from 640×960; default: 1.0)")
    parser.add_argument("--denoise-strength", type=float, default=0.5, metavar="STRENGTH",
                        help="Denoising strength: fraction of steps to run (0.0=no change, 1.0=full re-gen; default: 0.5)")

    # Common generation args (prompt, seed, lora, upscale, batch)
    add_common_generation_args(parser)

    # width/height are derived from input image (+ latent upscale), not user-specified
    # But keep them for consistency with generate; ignored when input_image is set
    parser.add_argument("--width", type=int, default=640,
                        help="Ignored when --input-image is set (size comes from input image)")
    parser.add_argument("--height", type=int, default=960,
                        help="Ignored when --input-image is set (size comes from input image)")


def run(args):
    run_config = RunConfig.from_args(args, command="refine")
    execute_generation(run_config)
