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
  vae:ultraflux                  — Default VAE vs UltraFlux VAE quality comparison (was: ultraflux)
  lora:sda-portrait              — SDA LoKr A/B: portrait prompt, quality metrics + voting (was: zit-sda-v1)
  lora:sda-fullbody              — SDA LoKr A/B: full-body prompt, quality metrics + voting (was: zit-sda-v1-fullbody)
  lora:sda-sweep                 — SDA LoKr sweep: 8 diverse prompt styles, cross-prompt quality (was: zit-sda-v1-sweep)
  lora:anime2real                — anime2real LoRA: T2I→I2I style transfer (was: anime2real)
  lora:anime2real-ref            — anime2real Ref+LoRA: identity-preserving review (was: anime2real-ref)
  swap:face-crossgender          — Woman body + man head swap, cross-gender BFS (was: faceswap-crossgender)
  swap:face-crossgender-reverse  — Man body + woman head swap (was: faceswap-crossgender-reverse)
  workflow:postprocess           — PostProcessChain on synthetic image (no model)
  workflow:portrait              — A/B/C: base → detail+post → full+upscale (was: portrait-full)
  workflow:grain                 — Film grain intensity sweep (was: grain-sweep)
  workflow:face-detail           — Face detailer denoise strength A/B (was: face-detail-ab)
  workflow:landscape             — Post-processing chain on landscape (was: landscape-post)
  video:flf2v-coffee             — FLF2V: man making coffee, standing→seated (was: flf2v-kitchen-coffee)
  video:flf2v-turn               — FLF2V: portrait head turn with smile (was: flf2v-studio-turn)
  video:flf2v-dusk               — FLF2V: meadow golden hour→dusk (was: flf2v-landscape-dusk)
  swap:sam-face                  — SAM3 face swap: JK girl + European woman (was: swap-face)
  swap:sam-outfit                — SAM3 outfit swap: casual → elegant dress (was: swap-outfit)
  swap:sam-object                — SAM3 object swap: ramune bottle → coffee cup (was: swap-object)
  swap:sam-food                  — SAM3 food swap: chocolate cake → macaron tower (was: swap-food)

'run.py generate' is an alias for this command (see run.py COMMAND_ALIASES).

Usage:
  run.py image --prompt 'Moody portrait'
  run.py image t2i --prompt 'Moody portrait' --pipeline flux2-klein
  run.py image t2i --prompt '...' --ab-test
  run.py image t2i --self-test vae:ultraflux
  run.py image review vae --self-test vae:ultraflux
  run.py image review lora --self-test lora:sda-portrait
  run.py image review lora --self-test lora:sda-portrait --seeds 42,123 --lora-scale 0.7
  run.py image angle --input output/portrait.png
  run.py image angle --input photo.png --azimuth 270 --elevation -20
  run.py image profile --input char.png
  run.py image controlnet
  run.py image controlnet --input-image photo.png --prompt '背面拍摄...'
  run.py image controlnet --controlnet-type pose --controlnet-strength 0.8
  run.py image faceswap --input body.png --face source.png
  run.py image faceswap --self-test
  run.py image faceswap --self-test crossgender
  run.py image --self-test faceswap-crossgender-reverse
  run.py image workflow --self-test portrait-full
  run.py image workflow --self-test grain-sweep
  run.py image workflow --self-test face-detail-ab
  run.py image workflow --self-test landscape-post
  run.py image review --self-test kitchen-coffee
  run.py image review --self-test flf2v-studio-turn
"""

import argparse
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
_swap = importlib.import_module("app.commands.image-swap")
_anime2real = importlib.import_module("app.commands.image-anime2real")
_quality = importlib.import_module("app.commands.image-quality")
_workflow = importlib.import_module("app.commands.image-workflow")
_expansion = importlib.import_module("app.commands.image-expansion")
_purify = importlib.import_module("app.commands.image-purify")
_restore = importlib.import_module("app.commands.image-restore")

# ---------------------------------------------------------------------------
# Load sample prompts for --help display (absorbed from generate.py)
# ---------------------------------------------------------------------------

_PROMPTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prompts.md")
_sample_prompts = ""
if os.path.exists(_PROMPTS_FILE):
    with open(_PROMPTS_FILE, "r") as _f:
        _sample_prompts = _f.read().strip()

PARSER_META = {
    "help": "Image generation: T2I (default), angle, review, profile, controlnet, i2i, quality, workflow, expansion, or purify",
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
        "  swap          — SAM3 text-prompted swap (any region) + compositing\n"
        "  anime2real    — Anime→realistic with identity preservation (Flux2KleinEdit ref + LoRA)\n"
        "  quality       — No-reference image quality analysis + VAE A/B self-test\n"
        "  expansion     — Flux2 Klein outpaint / image expansion (latent-mask, native MLX)\n"
"  purify        — SeedVR2 AI high-quality redraw + upscale (purify / enhance / redraw)\n\n"
        "Named self-tests (--self-test <id>):\n"
        "  vae:ultraflux           — VAE comparison (was: ultraflux)\n"
        "  lora:sda-portrait       — SDA LoKr A/B: portrait (was: zit-sda-v1)\n"
        "  lora:sda-fullbody       — SDA LoKr A/B: full-body (was: zit-sda-v1-fullbody)\n"
        "  lora:anime2real         — T2I→I2I style transfer (was: anime2real)\n"
        "  lora:anime2real-ref     — Ref+LoRA identity-preserving (was: anime2real-ref)\n"
        "  lora:anime2real-ab      — Realism style A/B (was: anime2real-ab)\n"
        "  lora:anime2real-pipeline— Cross-pipeline compare (was: anime2real-pipeline)\n"
        "  swap:face-crossgender   — Woman body + man head (was: faceswap-crossgender)\n"
        "  swap:face-crossgender-reverse — Man body + woman head (was: faceswap-crossgender-reverse)\n"
        "  workflow:portrait       — A/B/C: base→full+upscale (was: portrait-full)\n"
        "  workflow:grain          — Film grain sweep (was: grain-sweep)\n"
        "  workflow:face-detail    — Face detailer A/B (was: face-detail-ab)\n"
        "  workflow:landscape      — Post-processing on landscape (was: landscape-post)\n"
        "  swap:sam-face           — SAM3 face swap (was: swap-face)\n"
        "  swap:sam-outfit         — SAM3 outfit swap (was: swap-outfit)\n"
        "  swap:sam-object         — SAM3 object swap (was: swap-object)\n"
        "  swap:sam-food           — SAM3 food swap (was: swap-food)\n"
        "  expansion:basic         — Outpaint directional+16:9 (was: expansion)\n"
        "  expansion:sweep         — Outpaint sweep (was: expansion-sweep)\n"
        "  expansion:multi         — Multi-scene (was: expansion-multi)\n"
        "  expansion:full          — Comprehensive (was: expansion-comprehensive)\n"
        "  expansion:ref-strength  — Ref strength sweep (was: expansion-ref-strength)\n"
        "  expansion:edge          — Edge cases (was: expansion-edge-cases)\n"
        "  expansion:overlap       — Overlap sweep (was: expansion-overlap-sweep)\n"
        "  expansion:feather       — Feather sweep (was: expansion-feather-sweep)\n"
        "  expansion:steps         — Steps sweep (was: expansion-steps-sweep)\n"
        "  expansion:pixels        — Pixels sweep (was: expansion-pixels-sweep)\n"
        "  expansion:defaults-ab   — Defaults A/B (was: expansion-defaults-ab)\n"
        "  video:t2v-rainy         — T2V: woman walking in rain (was: video-rainy-street)\n"
        "  video:t2v-forest        — T2V: forest hiking (was: video-forest-hiker)\n"
        "  video:flf2v-coffee      — FLF2V: coffee scene (was: flf2v-kitchen-coffee)\n"
        "  video:flf2v-turn        — FLF2V: portrait turn (was: flf2v-studio-turn)\n"
        "  video:flf2v-dusk        — FLF2V: landscape dusk (was: flf2v-landscape-dusk)\n"
        "  t2i:portrait            — 4-seed portrait (was: portrait-seeds)\n"
        "  t2i:landscape           — 4-seed landscape (was: landscape-seeds)\n"
        "  profile:zimage          — 3-view profile (was: profile-zimage)\n"
        "  profile:prompt-abc      — Prompt A/B/C (was: profile-prompt-abc)\n"
        "  profile:flux2-gen       — ZImage→Flux2 3-view (was: profile-flux2-gen)\n"
        "  controlnet:basic        — I2I+ControlNet debug (was: basic-controlnet)\n"
        "  controlnet:pose         — OpenPose skeleton (was: cnet-pose)\n"
        "  controlnet:dual         — OpenPose+inpaint anchor (was: dual-guidance)\n"
        "  lora:anatomy            — Anatomy stress test (was: anatomy-challenge)\n"
        "  lora:sda-sweep          — SDA 8-prompt sweep (was: zit-sda-v1-sweep)\n"
        "  swap:sam-all            — Run all SAM3 swap tests\n"
        "Run `run.py image review --self-test list` for full listing.\n\n"
        "Examples:\n"
        "  run.py image --prompt 'Moody portrait'\n"
        "  run.py image t2i --prompt '...' --pipeline flux2-klein\n"
        "  run.py image t2i --prompt '...' --ab-test\n"
        "  run.py image t2i --self-test vae:ultraflux\n"
        "  run.py image review vae --self-test vae:ultraflux\n"
        "  run.py image review lora --self-test lora:sda-portrait\n"
        "  run.py image review lora --self-test lora:sda-portrait --seeds 42,123 --lora-scale 0.7\n"
        "  run.py image review lora --self-test lora:sda-portrait --no-quality\n"
        "  run.py image --self-test lora:sda-fullbody\n"
        "  run.py image --self-test lora:sda-sweep\n"
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
        "  run.py image review anime2real --self-test lora:anime2real-pipeline\n"
        "  run.py image i2i --self-test\n"
        "  run.py image faceswap --input body.png --face source.png\n"
        "  run.py image faceswap --input body.png --face source.png --mode head\n"
        "  run.py image faceswap --self-test\n"
        "  run.py image faceswap --self-test swap:face-crossgender\n"
        "  run.py image --self-test swap:face-crossgender-reverse\n"
        "  run.py image workflow --self-test workflow:portrait\n"
        "  run.py image workflow --self-test workflow:grain\n"
        "  run.py image workflow --self-test workflow:landscape\n"
        "  run.py image expansion --input photo.png --expand left,right --pixels 768 --prompt '...'\n"
        "  run.py image expansion --input photo.png --aspect 16:9 --upscale --upscale-method seedvr2\n"
        "  run.py image --self-test expansion:basic\n"
        "  run.py image purify --input-image output/photo.png\n"
        "  run.py image purify --input-image output/photo.png --purify-mode redraw --resolution 2x\n"
        "  run.py image purify --input-image output/photo.png --purify-mode purify --resolution same\n"
        "  run.py image purify --input-image output/photo.png --softness-override 0.95 --resolution same\n"
        "  run.py image purify --input-image photo.png --purify-mode enhance --resolution 2160 --film-grain 0.02 --sharpening 0.1\n"
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

def add_args(parser: "argparse.ArgumentParser") -> None:
    # Primary action (nargs="?" fills before sub_action)
    parser.add_argument(
        "action",
        nargs="?",
        default="t2i",
        metavar="ACTION",
        help="t2i (default) | angle | review | profile | controlnet | i2i | faceswap | swap | anime2real | quality | workflow | expansion | purify",
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

    # Swap-specific args: --reference, --sam-prompt, --sam-threshold, --feather, --blend
    _swap.add_swap_args(parser)

    # Anime2Real-specific args: --anime2real-ref-count, --anime2real-lora-scale
    _anime2real.add_anime2real_args(parser)

    # Quality-specific args: --quality-inputs, --self-test, --test-prompt, etc.
    _quality.add_quality_args(parser)

    # Workflow-specific args: --face-detail, --film-grain, --sharpening, --lut, etc.
    _workflow.add_workflow_args(parser)

    # Expansion-specific args: --expand, --pixels, --ratio, --feather, --longest
    _expansion.add_expansion_args(parser)

    # Purify-specific args: --mode, --resolution, --softness-override, --film-grain, --sharpening
    _purify.add_purify_args(parser)

    # Restore-specific args: none (reuses i2i + common args)
    _restore.add_restore_args(parser)

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

def run(args: "argparse.Namespace") -> None:
    action = getattr(args, "action", "t2i") or "t2i"
    # Restore legacy --self-test semantics (bare→True, single→str); only a
    # multi-name list (≥2) survives for the unified review path.
    from app.commands._shared import normalize_self_test
    normalize_self_test(args)
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
    # A real test value is a name (str) or a multi-name list; bare True is NOT routed.
    if (self_test_val is not None and self_test_val is not True
            and action not in ("review", "quality", "workflow", "i2i")):
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
    elif action == "swap":
        _swap.run_swap(args)
    elif action == "anime2real":
        _anime2real.run_anime2real(args)
    elif action == "quality":
        _quality.run_quality(args)
    elif action == "workflow":
        _workflow.run_workflow(args)
    elif action == "expansion":
        _expansion.run_expansion(args)
    elif action == "purify":
        _purify.run_purify(args)
    elif action == "restore":
        _restore.run_restore(args)
    else:
        _t2i.run_t2i(args)
