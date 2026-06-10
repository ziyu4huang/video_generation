"""video — unified video command: dispatcher for generate, review, compare, quality, and restore sub-actions.

Sub-actions (loaded from sibling modules via importlib):
  generate (default)  — T2V/I2V/A2V video generation  → app/commands/video-generate.py
  review              — Review existing or auto-review  → app/commands/video-review.py
  compare             — Pipeline A/B compare flow       → app/commands/video-compare.py
  quality             — No-ref quality analysis         → app/commands/video-quality.py
  restore             — IC-LoRA restoration (remove watermarks/subtitles, deblur, upscale)
                        → app/commands/video-restore.py

Usage:
  run.py video --test-prompt rainy-street
  run.py video generate --test-prompt rainy-street
  run.py video review generate --test-prompt rainy-street --variations 4
  run.py video review --inputs output/*.manifest.json
  run.py video compare --source-image ref.png --prompt "person walking"
  run.py video compare --pipelines i2v,distilled-i2v --source-image ref.png --prompt "..."
  run.py video quality --quality-inputs output/video.mp4
  run.py video quality --quality-inputs A.mp4 B.mp4 --quality-labels "Baseline,LoRA"
  run.py video quality --self-test --test-prompt forest-hiker
  run.py video restore --restore-input degraded.mp4 --low-ram
  run.py video restore --restore-input degraded.mp4 --output restored.mp4 --frames 49
"""

import importlib

# Load sub-action modules (importlib required: filenames contain hyphens)
_generate = importlib.import_module("app.commands.video-generate")
_review = importlib.import_module("app.commands.video-review")
_compare = importlib.import_module("app.commands.video-compare")
_quality = importlib.import_module("app.commands.video-quality")
_restore = importlib.import_module("app.commands.video-restore")

PARSER_META = {
    "help": "LTX-2.3 video generation, review, comparison, quality analysis, and restoration",
    "description": (
        "Unified video command.\n\n"
        "Sub-actions:\n"
        "  generate (default) — T2V/I2V/A2V video generation\n"
        "  review generate    — Generate video + auto-launch A/B reviewer\n"
        "  review             — Review existing manifests\n"
        "  compare            — Pipeline A/B: Z-Image → caption → multi-pipeline → review\n"
        "  quality            — No-reference quality analysis (noise, sharpness, artifacts)\n"
        "  restore            — IC-LoRA restoration (remove watermarks/subtitles, deblur, upscale)\n\n"
        "Examples:\n"
        "  run.py video --test-prompt rainy-street\n"
        "  run.py video generate --test-prompt rainy-street\n"
        "  run.py video review generate --test-prompt rainy-street --variations 4\n"
        "  run.py video review --inputs output/*.manifest.json\n"
        "  run.py video compare --source-image ref.png --prompt 'person walking'\n"
        "  run.py video compare --pipelines i2v,distilled-i2v --list-pipelines\n"
        "  run.py video quality --quality-inputs output/video.mp4\n"
        "  run.py video quality --self-test --test-prompt forest-hiker\n"
        "  run.py video restore --restore-input degraded.mp4 --low-ram\n"
        "  run.py video restore --restore-input degraded.mp4 --output restored.mp4 --frames 49\n"
    ),
}


def add_args(parser):
    # Optional positional sub-action
    parser.add_argument(
        "action",
        nargs="?",
        default="generate",
        choices=["generate", "review", "compare", "quality", "restore"],
        help="Sub-action: 'generate' (default), 'review', 'compare', 'quality', or 'restore'",
    )

    # Nested review sub-action (only consumed when action='review')
    parser.add_argument(
        "review_action",
        nargs="?",
        default=None,
        choices=["generate"],
        help="Review sub-action: 'generate' (generates then reviews)",
    )

    # Generation args: --prompt, --test-prompt, --frames, --seed, etc.
    _generate.add_generate_args(parser)

    # Review args: --inputs, --labels, --output, --no-open
    _review.add_review_args(parser)

    # Compare args: --source-image, --pipelines, --list-pipelines, etc.
    _compare.add_compare_args(parser)

    # Quality args: --self-test, --sample-every, --json, --labels, --no-html
    _quality.add_quality_args(parser)

    # Restore args: --input, --output, --seed, --frames, --restoration-lora, etc.
    _restore.add_restore_args(parser)


def run(args):
    action = getattr(args, "action", "generate") or "generate"
    if action == "restore":
        _restore.run_restore(args)
    elif action == "review":
        review_action = getattr(args, "review_action", None)
        if review_action == "generate":
            _review.run_review_from_generation(args)
        else:
            _review.run_review_from_manifests(args)
    elif action == "compare":
        _compare.run_compare(args)
    elif action == "quality":
        _quality.run_quality(args)
    else:
        _generate.run_generate(args)
