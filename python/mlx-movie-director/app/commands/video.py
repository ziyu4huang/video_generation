"""video — unified video command: dispatcher for generate and review sub-actions.

Sub-actions (loaded from sibling modules via importlib):
  generate (default)  — T2V/I2V/A2V video generation  → app/commands/video-generate.py
  review              — Review existing or auto-review  → app/commands/video-review.py

Usage:
  run.py video --test-prompt rainy-street
  run.py video generate --test-prompt rainy-street
  run.py video review generate --test-prompt rainy-street --variations 4
  run.py video review --inputs output/*.manifest.json
"""

import importlib

# Load sub-action modules (importlib required: filenames contain hyphens)
_generate = importlib.import_module("app.commands.video-generate")
_review = importlib.import_module("app.commands.video-review")

PARSER_META = {
    "help": "LTX-2.3 video generation and review",
    "description": (
        "Unified video command.\n\n"
        "Sub-actions:\n"
        "  generate (default) — T2V/I2V/A2V video generation\n"
        "  review generate    — Generate video + auto-launch A/B reviewer\n"
        "  review             — Review existing manifests\n\n"
        "Examples:\n"
        "  run.py video --test-prompt rainy-street\n"
        "  run.py video generate --test-prompt rainy-street\n"
        "  run.py video review generate --test-prompt rainy-street --variations 4\n"
        "  run.py video review --inputs output/*.manifest.json\n"
    ),
}


def add_args(parser):
    # Optional positional sub-action
    parser.add_argument(
        "action",
        nargs="?",
        default="generate",
        choices=["generate", "review"],
        help="Sub-action: 'generate' (default) or 'review'",
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


def run(args):
    action = getattr(args, "action", "generate") or "generate"
    if action == "review":
        review_action = getattr(args, "review_action", None)
        if review_action == "generate":
            _review.run_review_from_generation(args)
        else:
            _review.run_review_from_manifests(args)
    else:
        _generate.run_generate(args)
