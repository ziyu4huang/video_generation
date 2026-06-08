"""image — unified image command: dispatcher for t2i, angle, review, profile, controlnet, faceswap, sda-test, workflow sub-actions.

Sub-actions (loaded from sibling modules via importlib):
  t2i (default)   — text-to-image    → app/commands/image-t2i.py
  angle           — angle reframe    → app/commands/image-angle.py
  review          — image review     → app/commands/image-review.py
  profile         — character sheet  → app/commands/image-profile.py
  controlnet      — Z-Image ControlNet (native MLX) → app/commands/image-controlnet.py
  faceswap        — BFS face/head swap via Flux2 Klein + BFS LoRA → app/commands/image-faceswap.py
  sda-test        — SDA LoKr A/B diversity test → app/commands/image-sda-test.py
  quality         — No-reference image quality analysis + VAE A/B self-test → app/commands/image-quality.py
  workflow        — Multi-stage: generate → face detail → post-process → upscale → app/commands/image-workflow.py

'run.py generate' is an alias for this command (see run.py COMMAND_ALIASES).

Usage:
  run.py image --prompt 'Moody portrait'
  run.py image t2i --prompt 'Moody portrait' --pipeline flux2-klein
  run.py image t2i --prompt '...' --ab-test
  run.py image angle --input output/portrait.png
  run.py image angle --input photo.png --azimuth 270 --elevation -20
  run.py image profile --input char.png
  run.py image controlnet
  run.py image controlnet --input-image photo.png --prompt '背面拍摄...'
  run.py image controlnet --controlnet-type pose --controlnet-strength 0.8
  run.py image faceswap --input body.png --face source.png
  run.py image faceswap --self-test
"""

import importlib
import os

from app.commands._shared import add_common_generation_args

# Load sub-action modules (importlib required: filenames contain hyphens)
_t2i = importlib.import_module("app.commands.image-t2i")
_angle = importlib.import_module("app.commands.image-angle")
_review = importlib.import_module("app.commands.image-review")
_profile = importlib.import_module("app.commands.image-profile")
_controlnet = importlib.import_module("app.commands.image-controlnet")
_faceswap = importlib.import_module("app.commands.image-faceswap")
_sda_test = importlib.import_module("app.commands.image-sda-test")
_quality = importlib.import_module("app.commands.image-quality")
_workflow = importlib.import_module("app.commands.image-workflow")

# ---------------------------------------------------------------------------
# Load sample prompts for --help display (absorbed from generate.py)
# ---------------------------------------------------------------------------

_PROMPTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prompts.md")
_sample_prompts = ""
if os.path.exists(_PROMPTS_FILE):
    with open(_PROMPTS_FILE, "r") as _f:
        _sample_prompts = _f.read().strip()

PARSER_META = {
    "help": "Image generation: T2I (default), angle, review, profile, controlnet, quality, or sda-test",
    "description": (
        "Unified image command. 'run.py generate' is an alias.\n\n"
        "Sub-actions:\n"
        "  t2i (default) — text-to-image (zimage or flux2-klein pipeline)\n"
        "  angle         — Flux2-Klein Kontext reframe from a different camera angle\n"
        "  review        — Image review (angle grid, generation, or manifest)\n"
        "  profile       — Multi-view character profile sheet (front / back / side)\n"
        "  controlnet    — ControlNet: Z-Image native or Flux2 Klein reference conditioning\n"
        "  faceswap      — BFS face/head swap via Flux2 Klein + BFS LoRA\n"
        "  quality       — No-reference image quality analysis + VAE A/B self-test\n"
        "  sda-test      — SDA LoKr A/B test: baseline vs diversity adapter\n\n"
        "Examples:\n"
        "  run.py image --prompt 'Moody portrait'\n"
        "  run.py image t2i --prompt '...' --pipeline flux2-klein\n"
        "  run.py image t2i --prompt '...' --ab-test\n"
        "  run.py image angle --input output/portrait.png\n"
        "  run.py image angle --input photo.png --azimuth 270 --elevation -20\n"
        "  run.py image angle --input x.png --azimuth 180 --prompt 'cyberpunk outfit'\n"
        "  run.py image review --input portrait.png\n"
        "  run.py image review --input portrait.png --elevations all\n"
        "  run.py image profile --input char.png\n"
        "  run.py image profile --input char.png --views front back\n"
        "  run.py image profile --input char.png --ratio standing\n"
        "  run.py image controlnet\n"
        "  run.py image controlnet --input-image photo.png --prompt '背面拍摄...'\n"
        "  run.py image controlnet --controlnet-type pose --controlnet-strength 0.8\n"
        "  run.py image controlnet --self-test\n"
        "  run.py image controlnet --input-image photo.png --prompt '...' --pipeline flux2-klein\n"
        "  run.py image faceswap --input body.png --face source.png\n"
        "  run.py image faceswap --input body.png --face source.png --mode head\n"
        "  run.py image faceswap --self-test\n"
        "  run.py image sda-test --prompt 'cinematic portrait' --seeds 42,123,777,999\n"
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
        help="t2i (default) | angle | review | profile | controlnet | faceswap | quality | sda-test | workflow",
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

    # Profile-specific args: --views, --base-prompt, --ratio, etc.
    _profile.add_profile_args(parser)

    # ControlNet-specific args: --input-image, --controlnet-type, --controlnet-strength, --scale, --server
    _controlnet.add_controlnet_args(parser)

    # FaceSwap-specific args: --face, --mode, --lora
    _faceswap.add_faceswap_args(parser)

    # SDA-test-specific args: --seeds, --lora-scale
    _sda_test.add_sda_test_args(parser)

    # Quality-specific args: --quality-inputs, --self-test, --test-prompt, etc.
    _quality.add_quality_args(parser)

    # Workflow-specific args: --face-detail, --film-grain, --sharpening, --lut, etc.
    _workflow.add_workflow_args(parser)

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
    elif action == "profile":
        _profile.run_profile(args)
    elif action == "controlnet":
        _controlnet.run_controlnet(args)
    elif action == "faceswap":
        _faceswap.run_faceswap(args)
    elif action == "sda-test":
        _sda_test.run_sda_test(args)
    elif action == "quality":
        _quality.run_quality(args)
    elif action == "workflow":
        _workflow.run_workflow(args)
    else:
        _t2i.run_t2i(args)
