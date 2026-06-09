"""image — unified image command: dispatcher for t2i, angle, review, profile, controlnet, i2i, faceswap, quality, workflow sub-actions.

Sub-actions (loaded from sibling modules via importlib):
  t2i (default)   — text-to-image    → app/commands/image-t2i.py
  angle           — angle reframe    → app/commands/image-angle.py
  review          — image review     → app/commands/image-review.py
    review vae    —   VAE A/B comparison: generate + quality + HTML
    review lora   —   LoRA A/B test: baseline vs adapter, multi-seed paired
                     quality metrics + HTML voting (quality on by default, --no-quality to skip)
  profile         — character sheet  → app/commands/image-profile.py
  controlnet      — Z-Image ControlNet (native MLX) → app/commands/image-controlnet.py
  i2i             — Image-to-Image (+ optional ControlNet) → app/commands/image-i2i.py
  faceswap        — BFS face/head swap via Flux2 Klein + BFS LoRA → app/commands/image-faceswap.py
  anime2real      — Anime→realistic style transfer (Flux2KleinEdit ref + LoRA) → app/commands/image-anime2real.py
  quality         — No-reference image quality analysis + VAE A/B self-test → app/commands/image-quality.py
  workflow        — Multi-stage: generate → face detail → post-process → upscale → app/commands/image-workflow.py

Named self-tests (--self-test <id>):
  ultraflux / vae-ultra-flux  — Default VAE vs UltraFlux VAE quality comparison
  zit-sda-v1 / sda            — SDA LoKr A/B: portrait prompt, quality metrics + voting
  zit-sda-v1-fullbody / sda-fullbody — SDA LoKr A/B: full-body prompt, quality metrics + voting
  zit-sda-v1-sweep / sda-sweep — SDA LoKr sweep: 8 diverse prompt styles, cross-prompt quality comparison
  anime2real / anything2real  — anime2real LoRA: T2I→I2I style transfer, caption + quality review
  anime2real-ref               — anime2real Ref+LoRA: identity-preserving anime→real with multi-prompt HTML review
  workflow-postprocess         — PostProcessChain on synthetic image (no model)
  workflow-basic               — Full pipeline at 4 steps / 512×512
  portrait-full                — A/B/C: base → detail+post → full+upscale
  grain-sweep                  — Film grain intensity sweep
  face-detail-ab               — Face detailer denoise strength A/B
  landscape-post               — Post-processing chain on landscape
  flf2v-kitchen-coffee / kitchen-coffee — FLF2V: man making coffee, standing→seated
  flf2v-studio-turn / studio-turn — FLF2V: portrait head turn with smile
  flf2v-landscape-dusk / landscape-dusk — FLF2V: meadow golden hour→dusk

'run.py generate' is an alias for this command (see run.py COMMAND_ALIASES).

Usage:
  run.py image --prompt 'Moody portrait'
  run.py image t2i --prompt 'Moody portrait' --pipeline flux2-klein
  run.py image t2i --prompt '...' --ab-test
  run.py image t2i --self-test ultraflux
  run.py image review vae --self-test ultraflux
  run.py image review lora --self-test zit-sda-v1
  run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7
  run.py image angle --input output/portrait.png
  run.py image angle --input photo.png --azimuth 270 --elevation -20
  run.py image profile --input char.png
  run.py image controlnet
  run.py image controlnet --input-image photo.png --prompt '背面拍摄...'
  run.py image controlnet --controlnet-type pose --controlnet-strength 0.8
  run.py image faceswap --input body.png --face source.png
  run.py image faceswap --self-test
  run.py image workflow --self-test portrait-full
  run.py image workflow --self-test grain-sweep
  run.py image workflow --self-test face-detail-ab
  run.py image workflow --self-test landscape-post
  run.py image review --self-test kitchen-coffee
  run.py image review --self-test flf2v-studio-turn
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
_i2i = importlib.import_module("app.commands.image-i2i")
_faceswap = importlib.import_module("app.commands.image-faceswap")
_anime2real = importlib.import_module("app.commands.image-anime2real")
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
    "help": "Image generation: T2I (default), angle, review, profile, controlnet, i2i, quality, or workflow",
    "description": (
        "Unified image command. 'run.py generate' is an alias.\n\n"
        "Sub-actions:\n"
        "  t2i (default) — text-to-image (zimage or flux2-klein pipeline)\n"
        "  angle         — Flux2-Klein Kontext reframe from a different camera angle\n"
        "  review        — Image review (angle grid, generation, manifest, vae, lora, or anime2real)\n"
        "  review vae    — VAE A/B comparison: generate + quality metrics + HTML\n"
        "  review lora   — LoRA A/B test: baseline vs adapter, quality metrics + voting\n"
        "                  (quality on by default; --no-quality to skip)\n"
        "  review anime2real — anime2real Ref+LoRA self-test with cross-pipeline HTML review\n"
        "  profile       — Multi-view character profile sheet (front / back / side)\n"
        "  controlnet    — ControlNet: Z-Image native or Flux2 Klein reference conditioning\n"
        "  i2i           — Image-to-Image (Z-Image w/ ControlNet, or Flux2-Klein w/ LoRA)\n"
        "  faceswap      — BFS face/head swap via Flux2 Klein + BFS LoRA\n"
        "  anime2real    — Anime→realistic with identity preservation (Flux2KleinEdit ref + LoRA)\n"
        "  quality       — No-reference image quality analysis + VAE A/B self-test\n\n"
        "Named self-tests (--self-test <id>):\n"
        "  ultraflux / vae-ultra-flux  — Default VAE vs UltraFlux VAE comparison\n"
        "  zit-sda-v1 / sda            — SDA LoKr A/B: portrait, quality + voting\n"
        "  zit-sda-v1-fullbody / sda-fullbody — SDA LoKr A/B: full-body, quality + voting\n"
        "  anime2real / anything2real  — anime2real LoRA: T2I→I2I style transfer + caption review\n"
        "  anime2real-ref              — anime2real Ref+LoRA: identity-preserving multi-prompt review\n"
        "  anime2real-ab / a2r-ab      — A/B test: photorealistic vs 3D game vs semi-realistic\n"
        "  anime2real-pipeline / -v3   — Cross-pipeline: flux2-klein Ref+LoRA vs zimage I2I+LoRA\n"
        "  portrait-full               — Workflow A/B/C: base → detail+post → full+upscale\n"
        "  grain-sweep                 — Workflow: film grain intensity sweep\n"
        "  face-detail-ab              — Workflow: face detailer denoise strength A/B\n"
        "  landscape-post              — Workflow: post-processing chain on landscape\n\n"
        "Examples:\n"
        "  run.py image --prompt 'Moody portrait'\n"
        "  run.py image t2i --prompt '...' --pipeline flux2-klein\n"
        "  run.py image t2i --prompt '...' --ab-test\n"
        "  run.py image t2i --self-test ultraflux\n"
        "  run.py image review vae --self-test ultraflux\n"
        "  run.py image review lora --self-test zit-sda-v1\n"
        "  run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7\n"
        "  run.py image review lora --self-test zit-sda-v1 --no-quality\n"
        "  run.py image --self-test sda-fullbody\n"
        "  run.py image --self-test sda-sweep\n"
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
        "  run.py image i2i --input-image photo.jpg --denoise-strength 0.4 --prompt 'oil painting'\n"
        "  run.py image i2i --input-image photo.jpg --reference-image pose.jpg --denoise-strength 0.4\n"
        "  run.py image i2i --pipeline flux2-klein --input-image anime.png --lora-path my-lora --denoise-strength 0.6\n"
        "  run.py image anime2real --input-image anime.png\n"
        "  run.py image anime2real --input-image anime.png --steps 8 --anime2real-lora-scale 1.0\n"
        "  run.py image --self-test anime2real\n"
        "  run.py image --self-test anime2real-ref\n"
        "  run.py image review anime2real --self-test anime2real-pipeline\n"
        "  run.py image i2i --self-test\n"
        "  run.py image faceswap --input body.png --face source.png\n"
        "  run.py image faceswap --input body.png --face source.png --mode head\n"
        "  run.py image faceswap --self-test\n"
        "  run.py image workflow --self-test portrait-full\n"
        "  run.py image workflow --self-test grain-sweep\n"
        "  run.py image workflow --self-test landscape-post\n"
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
        help="t2i (default) | angle | review | profile | controlnet | i2i | faceswap | anime2real | quality | workflow",
    )
    # Secondary positional — meaningful for review (angle/generation/vae/lora) and others
    parser.add_argument(
        "sub_action",
        nargs="?",
        default=None,
        metavar="SUB_ACTION",
        help="For 'review': angle | generation | vae | lora | anime2real | (omit = manifest review from --inputs/--last)",
    )

    # T2I-specific args: --width, --height, --pipeline, --ab-test, --variant, etc.
    _t2i.add_t2i_args(parser)

    # Angle-specific args: --input, --azimuth, --elevation
    _angle.add_angle_args(parser)

    # Review-specific args: --elevations, --inputs, --labels, --seeds, etc.
    _review.add_review_args(parser)

    # Profile-specific args: --views, --base-prompt, --ratio, etc.
    _profile.add_profile_args(parser)

    # ControlNet-specific args: --input-image, --controlnet-type, --controlnet-strength, --scale, --server
    _controlnet.add_controlnet_args(parser)

    # I2I-specific args: --reference-image, --denoise-strength, --controlnet-strength (i2i)
    _i2i.add_i2i_args(parser)

    # FaceSwap-specific args: --face, --mode, --lora
    _faceswap.add_faceswap_args(parser)

    # Anime2Real-specific args: --anime2real-ref-count, --anime2real-lora-scale
    _anime2real.add_anime2real_args(parser)

    # Quality-specific args: --quality-inputs, --self-test, --test-prompt, etc.
    _quality.add_quality_args(parser)

    # Workflow-specific args: --face-detail, --film-grain, --sharpening, --lut, etc.
    _workflow.add_workflow_args(parser)

    # Common args: --prompt/--prompt-file, --steps, --seed, --upscale, --count, etc.
    # CAUTION: Some subcommands above register shared args (e.g. --lora-scale)
    # with different defaults before add_common_generation_args() runs.  The
    # _arg_registered() guard in _shared.py skips already-registered args, so
    # the first registration's default wins.  Run functions must handle None
    # defaults defensively: `getattr(args, "lora_scale", None) or 1.0`.
    add_common_generation_args(parser)

    # LoRA discovery
    parser.add_argument(
        "--list-loras", action="store_true", default=False,
        help="List available LoRAs (optionally filter with --lora-pipeline)",
    )
    parser.add_argument(
        "--lora-pipeline", type=str, default=None,
        help="Filter --list-loras by pipeline (e.g. zimage-turbo, flux2-klein)",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(args):
    action = getattr(args, "action", "t2i") or "t2i"
    self_test_val = getattr(args, "self_test", None)

    # --list-loras: discover available LoRAs and exit
    if getattr(args, "list_loras", False):
        from app.commands._shared import list_available_loras
        list_available_loras(pipeline_filter=getattr(args, "lora_pipeline", None))
        return

    # Named self-test: route ALL --self-test values through the unified selftest dispatcher
    # in image-review.py, except for:
    #   'review'   — checks self_test internally
    #   'quality'  — has its own traditional-metrics self-test
    #   'workflow'  — has its own dedicated self-test runner + HTML renderer
    #   'i2i'      — handles self_test internally
    if isinstance(self_test_val, str) and action not in ("review", "quality", "workflow", "i2i"):
        _review.run_review(args, sub="selftest")
        return

    if action == "angle":
        _angle.run_angle(args)
    elif action == "review":
        sub = getattr(args, "sub_action", None) or "manifest"
        _review.run_review(args, sub=sub)
    elif action == "profile":
        _profile.run_profile(args)
    elif action == "controlnet":
        _controlnet.run_controlnet(args)
    elif action == "i2i":
        _i2i.run_i2i(args)
    elif action == "faceswap":
        _faceswap.run_faceswap(args)
    elif action == "anime2real":
        _anime2real.run_anime2real(args)
    elif action == "quality":
        _quality.run_quality(args)
    elif action == "workflow":
        _workflow.run_workflow(args)
    else:
        _t2i.run_t2i(args)
