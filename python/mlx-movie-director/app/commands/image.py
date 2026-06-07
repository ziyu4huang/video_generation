"""image — unified image command: dispatcher for t2i and angle sub-actions.

Sub-actions (loaded from sibling modules via importlib):
  t2i (default)   — text-to-image  → app/commands/image-t2i.py
  angle           — angle reframe  → app/commands/image-angle.py

'run.py generate' is an alias for this command (see run.py COMMAND_ALIASES).

Usage:
  run.py image --prompt 'Moody portrait'
  run.py image t2i --prompt 'Moody portrait' --pipeline flux2-klein
  run.py image t2i --prompt '...' --ab-test
  run.py image angle --input output/portrait.png
  run.py image angle --input photo.png --azimuth 270 --elevation -20
"""

import importlib
import os

from app.commands._shared import add_common_generation_args

# Load sub-action modules (importlib required: filenames contain hyphens)
_t2i = importlib.import_module("app.commands.image-t2i")
_angle = importlib.import_module("app.commands.image-angle")
_review = importlib.import_module("app.commands.image-review")

# ---------------------------------------------------------------------------
# Load sample prompts for --help display (absorbed from generate.py)
# ---------------------------------------------------------------------------

_PROMPTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prompts.md")
_sample_prompts = ""
if os.path.exists(_PROMPTS_FILE):
    with open(_PROMPTS_FILE, "r") as _f:
        _sample_prompts = _f.read().strip()

PARSER_META = {
    "help": "Image generation: T2I (default) or angle-view reframe",
    "description": (
        "Unified image command. 'run.py generate' is an alias.\n\n"
        "Sub-actions:\n"
        "  t2i (default) — text-to-image (zimage or flux2-klein pipeline)\n"
        "  angle         — Flux2-Klein Kontext reframe from a different camera angle\n\n"
        "Examples:\n"
        "  run.py image --prompt 'Moody portrait'\n"
        "  run.py image t2i --prompt '...' --pipeline flux2-klein\n"
        "  run.py image t2i --prompt '...' --ab-test\n"
        "  run.py image angle --input output/portrait.png\n"
        "  run.py image angle --input photo.png --azimuth 270 --elevation -20\n"
        "  run.py image angle --input x.png --azimuth 180 --prompt 'cyberpunk outfit'\n"
        "  run.py image review --input portrait.png\n"
        "  run.py image review --input portrait.png --elevations all\n"
        "\n"
        "─────────────────────────────────────────────────────────────────────\n"
        "Sample Prompts\n"
        "─────────────────────────────────────────────────────────────────────\n\n"
        + _sample_prompts
    ),
}


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_args(parser):
    # Primary action (nargs="?" fills before sub_action)
    parser.add_argument(
        "action",
        nargs="?",
        default="t2i",
        metavar="ACTION",
        help="t2i (default) | angle | review",
    )
    # Secondary positional — only meaningful when action=review
    parser.add_argument(
        "sub_action",
        nargs="?",
        default=None,
        metavar="SUB_ACTION",
        help="For 'review': angle | generation | (omit = manifest review from --inputs/--last)",
    )

    # T2I-specific args: --width, --height, --pipeline, --ab-test, --variant, etc.
    _t2i.add_t2i_args(parser)

    # Angle-specific args: --input, --azimuth, --elevation
    _angle.add_angle_args(parser)

    # Review-specific args: --elevations (plural, string levels for grid)
    _review.add_review_args(parser)

    # Common args: --prompt/--prompt-file, --steps, --seed, --upscale, --count, etc.
    add_common_generation_args(parser)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(args):
    action = getattr(args, "action", "t2i") or "t2i"
    if action == "angle":
        _angle.run_angle(args)
    elif action == "review":
        sub = getattr(args, "sub_action", None) or "manifest"
        _review.run_review(args, sub=sub)
    else:
        _t2i.run_t2i(args)
