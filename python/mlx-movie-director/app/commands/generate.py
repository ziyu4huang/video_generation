"""generate — text-to-image (default command).

Supports two pipelines:
  zimage (default)    — Z-Image Turbo Moody V12.6, 4-bit MLX, 9 steps
  flux2-klein         — Flux2 Klein 9B, INT8, 4 steps (distilled)
"""

import os

from app.commands._shared import add_common_generation_args, execute_generation, execute_ab_test
from app.run_config import RunConfig

# ---------------------------------------------------------------------------
# Load sample prompts for --help display
# ---------------------------------------------------------------------------

_PROMPTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prompts.md")
_sample_prompts = ""
if os.path.exists(_PROMPTS_FILE):
    with open(_PROMPTS_FILE, "r") as _f:
        _sample_prompts = _f.read().strip()

# Default denoising steps per pipeline
PIPELINE_DEFAULT_STEPS = {"zimage": 9, "flux2-klein": 4}

PARSER_META = {
    "help": "Text-to-image generation (default command)",
    "description": (
        "Generate images from a text prompt.\n\n"
        "Pipelines:\n"
        "  zimage (default)  — Z-Image Turbo Moody V12.6, 4-bit, fast & moody\n"
        "  flux2-klein       — Flux2 Klein 9B, INT8, photorealistic detail\n\n"
        "Examples:\n"
        "  run.py generate --prompt 'Moody portrait' --width 640 --height 960\n"
        "  run.py generate --prompt '...' --pipeline flux2-klein\n"
        "  run.py generate --prompt '...' --lora-path loras/zit_sda_v1.safetensors\n"
        "  run.py generate --prompt '...' --count 4 --seed-start 100 --upscale\n"
        "  run.py generate --prompt '...' --ab-test   ← compare both pipelines\n"
        "  run.py --prompt '...'   ← same as above (generate is the default command)\n"
        "\n"
        "─────────────────────────────────────────────────────────────────────\n"
        "Sample Prompts (copy a prompt and pass via --prompt or --prompt-file)\n"
        "─────────────────────────────────────────────────────────────────────\n\n"
        + _sample_prompts
    ),
}


def add_args(parser):
    add_common_generation_args(parser)
    parser.add_argument("--width", type=int, default=640,
                        help="Image width in pixels (default: 640)")
    parser.add_argument("--height", type=int, default=960,
                        help="Image height in pixels (default: 960)")
    parser.add_argument("--pipeline", choices=["zimage", "flux2-klein"], default="zimage",
                        help="Generation pipeline (default: zimage)")
    parser.add_argument("--ab-test", action="store_true", default=False,
                        help="Run both pipelines sequentially for A/B comparison")


def run(args):
    pipeline_type = getattr(args, "pipeline", "zimage")

    # Resolve steps default based on pipeline type
    if args.steps is None:
        args.steps = PIPELINE_DEFAULT_STEPS.get(pipeline_type, 9)

    run_config = RunConfig.from_args(args, command="generate")

    if getattr(args, "ab_test", False):
        execute_ab_test(run_config)
    else:
        execute_generation(run_config, pipeline_type=pipeline_type)
