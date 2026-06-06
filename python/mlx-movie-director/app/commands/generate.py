"""generate — text-to-image (default command)."""

import os

from app.commands._shared import add_common_generation_args, execute_generation
from app.run_config import RunConfig

# ---------------------------------------------------------------------------
# Load sample prompts for --help display
# ---------------------------------------------------------------------------

_PROMPTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prompts.md")
_sample_prompts = ""
if os.path.exists(_PROMPTS_FILE):
    with open(_PROMPTS_FILE, "r") as _f:
        _sample_prompts = _f.read().strip()

PARSER_META = {
    "help": "Text-to-image generation (default command)",
    "description": (
        "Generate images from a text prompt using the Z-Image MLX pipeline.\n\n"
        "Examples:\n"
        "  run.py generate --prompt 'Moody portrait' --width 640 --height 960\n"
        "  run.py generate --prompt '...' --lora-path loras/zit_sda_v1.safetensors --lora-scale 0.49\n"
        "  run.py generate --prompt '...' --count 4 --seed-start 100 --upscale\n"
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


def run(args):
    run_config = RunConfig.from_args(args, command="generate")
    execute_generation(run_config)
