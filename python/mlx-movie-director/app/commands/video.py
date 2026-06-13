"""video — unified video command: dispatcher for generate, review, compare, quality, restore, and vbvr sub-actions.

Sub-actions (loaded from sibling modules via importlib):
  generate (default)  — T2V/I2V/A2V video generation  → app/commands/video-generate.py
  review              — Review existing or auto-review  → app/commands/video-review.py
  compare             — Pipeline A/B compare flow       → app/commands/video-compare.py
  quality             — No-ref quality analysis         → app/commands/video-quality.py
  restore             — IC-LoRA restoration (remove watermarks/subtitles, deblur, upscale)
                        → app/commands/video-restore.py
  vbvr                — I2V generation with VBVR reasoning LoRA
                        → app/commands/video-vbvr.py

Usage:
  run.py video --test-prompt rainy-street
  run.py video generate --test-prompt rainy-street
  run.py video review generate --test-prompt rainy-street --variations 4
  run.py video review --inputs output/*.manifest.json
  run.py video compare --source-image ref.png --prompt "person walking"
  run.py video compare --pipelines i2v,distilled-i2v --source-image ref.png --prompt "..."
  run.py video quality --quality-inputs output/video.mp4
  run.py video quality --quality-inputs A.mp4 B.mp4 --quality-labels "Baseline,LoRA"
  run.py video quality --self-test --test-prompt video:t2v-forest
  run.py video restore --restore-input degraded.mp4 --low-ram
  run.py video restore --restore-input degraded.mp4 --output restored.mp4 --frames 49
  run.py video vbvr --input-image base.jpg --prompt "person opens a door and walks through"
  run.py video vbvr --prompt "ball bounces off wall" --frames 49
"""

import argparse
import importlib

# Load sub-action modules (importlib required: filenames contain hyphens)
_generate = importlib.import_module("app.commands.video-generate")
_review = importlib.import_module("app.commands.video-review")
_compare = importlib.import_module("app.commands.video-compare")
_quality = importlib.import_module("app.commands.video-quality")
_restore = importlib.import_module("app.commands.video-restore")
_vbvr = importlib.import_module("app.commands.video-vbvr")
_relay = importlib.import_module("app.commands.video-relay")

PARSER_META = {
    "help": "LTX-2.3 video generation, review, comparison, quality analysis, restoration, and VBVR",
    "description": (
        "Unified video command.\n\n"
        "Sub-actions:\n"
        "  generate (default) — T2V/I2V/A2V video generation\n"
        "  review generate    — Generate video + auto-launch A/B reviewer\n"
        "  review             — Review existing manifests\n"
        "  compare            — Pipeline A/B: Z-Image → caption → multi-pipeline → review\n"
        "  quality            — No-reference quality analysis (noise, sharpness, artifacts)\n"
        "  restore            — IC-LoRA restoration (remove watermarks/subtitles, deblur, upscale)\n"
        "  vbvr               — I2V generation with VBVR reasoning LoRA\n"
        "  relay              — Multi-segment Prompt-Relay short film + custom audio\n\n"
        "Examples:\n"
        "  run.py video --test-prompt rainy-street\n"
        "  run.py video generate --test-prompt rainy-street\n"
        "  run.py video review generate --test-prompt rainy-street --variations 4\n"
        "  run.py video review --inputs output/*.manifest.json\n"
        "  run.py video compare --source-image ref.png --prompt 'person walking'\n"
        "  run.py video compare --pipelines i2v,distilled-i2v --list-pipelines\n"
        "  run.py video quality --quality-inputs output/video.mp4\n"
        "  run.py video quality --self-test --test-prompt video:t2v-forest\n"
        "  run.py video restore --restore-input degraded.mp4 --low-ram\n"
        "  run.py video restore --restore-input degraded.mp4 --output restored.mp4 --frames 49\n"
        "  run.py video vbvr --input-image base.jpg --prompt 'person opens a door'\n"
        "  run.py video vbvr --prompt 'ball bounces off wall' --frames 49\n"
        "  run.py video relay --relay-prompt-file prompts.txt --relay-first-image base.jpg\n"
        "  run.py video relay --relay-prompt-file prompts.txt --relay-audio music.mp3 --low-ram\n"
        "\n"
        "Voice / speech tips (audio is generated from the SAME prompt; intelligible-with-effort\n"
        "ceiling on MLX — see docs/ltx-voice.md):\n"
        "  - For SPEECH use --stage1-steps 16 --stage2-steps 3 (8 steps = audio noise);\n"
        "    49-57 frames speak clearest (longer clips get quieter).\n"
        "  - Keep the prompt <100 tokens, close-up framing, with quoted dialog + 'speaking'\n"
        "    + a voice descriptor. NO negations ('no human ears' -> use 'fluffy cat ears');\n"
        "    drop text-rendering asks (e.g. burning text) — unrenderable and competes with speech.\n"
    ),
}


def add_args(parser: "argparse.ArgumentParser") -> None:
    # Optional positional sub-action
    parser.add_argument(
        "action",
        nargs="?",
        default="generate",
        choices=["generate", "review", "compare", "quality", "restore", "vbvr", "relay"],
        help="Sub-action: 'generate' (default), 'review', 'compare', 'quality', 'restore', 'vbvr', or 'relay'",
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
    # Quality args: --self-test, --sample-every, --json, --labels, --no-html
    # --self-test is registered via add_common_generation_args() above
    _quality.add_quality_args(parser)

    # Restore args: --input, --output, --seed, --frames, --restoration-lora, etc.
    _restore.add_restore_args(parser)

    # VBVR args: --vbvr-prompt, --vbvr-input-image, --vbvr-lora, etc.
    _vbvr.add_vbvr_args(parser)

    # Relay args: --relay-prompt-file, --relay-audio, --relay-first-image, etc.
    _relay.add_relay_args(parser)


def run(args: "argparse.Namespace") -> None:
    # Normalize --self-test (shared nargs="*" → legacy scalar/bool form)
    from app.commands._shared import normalize_self_test
    normalize_self_test(args)

    action = getattr(args, "action", "generate") or "generate"
    if action == "relay":
        _relay.run_relay(args)
    elif action == "vbvr":
        _vbvr.run_vbvr(args)
    elif action == "restore":
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
