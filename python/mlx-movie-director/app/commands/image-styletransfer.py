"""image-styletransfer — restyle an image to a target visual language (OM gap D).

OpenMontage recurrently wants local edit/style-transfer/repaint, but the path
was not reachable from ``run.py`` / the agent. This command restyles a content
image to a named target style using the PROVEN Flux2 Klein img2img path: the
content image is the img2img base (structure preserved), the style prompt
repaints it, and ``--strength`` (denoise) controls how much the original gives
way to the target style. No ControlNet port, no cloud — constraint 1.

WHY img2img (not a ControlNet/K/V-injection port):
  - The full training-free krea2 style transfer (reference-forecast + per-freq
    K/V injection) lives only in the Swift director (``swift/krea2-image-director``),
    whose release binary is NOT built; a faithful Python port is large + novel.
  - Flux2 Klein img2img is certified daily and IS a reference-conditioning
    approach (the goal's Step-2 spike preference). Content structure comes from
    the input latent; the style comes from the prompt. Sufficient for OM's
    restyle-to-visual-language need.

STYLE SOURCES (combined; --prompt may amplify a preset/playbook):
  --playbook <yaml>   load the playbook's ``asset_generation.image_prompt_prefix``
                      + ``consistency_anchors`` + ``visual_language`` texture/composition
                      via ``app.planning.playbook`` → the canonical OM style contract.
  --style-preset <p>  a built-in named preset (clean-professional, watercolor,
                      oil-painting, anime, cinematic, 3d-render, line-art, low-poly).
  --prompt <text>     free-form style description (the fallback / override).

Imported by app.commands.image via importlib (hyphen in filename).

Public API:
  build_style_prompt(args)     — resolve the style source → a prompt string (pytest)
  add_styletransfer_args(p)    — register styletransfer-specific CLI arguments
  run_styletransfer(args)      — execute style transfer
"""
import argparse
import os
import sys

from app import config as cfg

# ---------------------------------------------------------------------------
# Built-in style presets — prompt fragments that describe each visual language.
# `clean-professional` mirrors bun-apps/.../data/styles/clean-professional.yaml
# so a no-playbook restyle still matches OM's baseline aesthetic.
# ---------------------------------------------------------------------------

_STYLE_PRESETS: dict[str, str] = {
    "clean-professional": (
        "clean professional flat illustration, corporate style, "
        "white background, blue and orange accents, soft even lighting, "
        "generous whitespace, no grain, vector aesthetic"
    ),
    "watercolor": (
        "loose watercolor painting, soft pigment bleeds, wet-on-wet washes, "
        "delicate color transitions, textured paper, hand-painted, artistic"
    ),
    "oil-painting": (
        "classical oil painting, rich visible brushstrokes, warm golden lighting, "
        "chiaroscuro, museum-quality portraiture, impasto texture"
    ),
    "anime": (
        "anime key visual, cel-shaded, clean line art, vibrant flat colors, "
        "detailed eyes, studio anime production, high quality"
    ),
    "cinematic": (
        "cinematic film still, dramatic volumetric lighting, shallow depth of field, "
        "teal-and-orange color grade, anamorphic, 35mm film grain, moody atmosphere"
    ),
    "3d-render": (
        "3D render, soft global illumination, subsurface scattering, "
        "Pixar-style stylized characters, rounded forms, polished materials"
    ),
    "line-art": (
        "clean line art, single-weight ink outlines, minimal shading, "
        "monochrome, technical illustration, crisp vector strokes"
    ),
    "low-poly": (
        "low-poly 3D illustration, faceted geometric surfaces, flat-shaded triangles, "
        "stylized minimal palette, isometric, clean"
    ),
}


# ---------------------------------------------------------------------------
# Style-source resolution (pure — the pytest target, no pipeline/model)
# ---------------------------------------------------------------------------

def build_style_prompt(args: "argparse.Namespace") -> str:
    """Resolve the style source (playbook + preset + prompt) → one prompt string.

    All three sources are COMBINED (deduped, joined): the preset fragment, the
    playbook's image_prompt_prefix + style_anchor + aesthetic, and an explicit
    ``--prompt`` appended last as extra direction (it AMPLIFIES a preset/playbook,
    or stands alone when it is the only source). Raises SystemExit(1) with a
    clear message if no style source is given.
    """
    playbook_path = getattr(args, "playbook", None)
    preset = getattr(args, "style_preset", None)
    extra = (getattr(args, "prompt", None) or "").strip()

    base_parts: list[str] = []

    if preset:
        key = preset.strip().lower()
        if key not in _STYLE_PRESETS:
            print(f"ERROR: unknown --style-preset '{preset}'. Available: "
                  f"{', '.join(sorted(_STYLE_PRESETS))}", file=sys.stderr)
            sys.exit(1)
        base_parts.append(_STYLE_PRESETS[key])

    if playbook_path:
        if not os.path.exists(playbook_path):
            print(f"ERROR: playbook not found: {playbook_path}", file=sys.stderr)
            sys.exit(1)
        from app.planning.playbook import load_playbook, style_anchor
        pb = load_playbook(playbook_path)
        prefix = (pb.image_prompt_prefix or "").strip()
        if prefix:
            base_parts.append(prefix.rstrip(", ").rstrip())
        anchor = style_anchor(pb)
        if anchor:
            base_parts.append(anchor)
        if pb.aesthetic:
            base_parts.append(pb.aesthetic)

    # When the user gives --prompt AND a preset/playbook, treat --prompt as
    # extra direction (amplify). When --prompt is the ONLY source, it IS the style.
    if extra:
        base_parts.append(extra)

    if not base_parts:
        print("ERROR: a style source is required — pass --style-preset <preset>, "
              "--playbook <yaml>, or --prompt <text>.", file=sys.stderr)
        sys.exit(1)

    # Dedup while preserving order, join into one prompt.
    seen: set[str] = set()
    ordered: list[str] = []
    for p in base_parts:
        p = p.strip().rstrip(",")
        if p and p not in seen:
            seen.add(p)
            ordered.append(p)
    return ", ".join(ordered)


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Restyle an image to a target visual language (playbook/preset/prompt)",
    "description": (
        "Style transfer: repaint a content image in a target style via Flux2 Klein\n"
        "img2img. The content image is the img2img base (structure preserved); the\n"
        "style prompt repaints it; --strength (denoise) controls the style/content\n"
        "balance. Closes OpenMontage gap D (local style transfer / repaint).\n\n"
        "Style sources (combined; --prompt may amplify a preset/playbook):\n"
        "  --playbook <yaml>    OM playbook visual_language (image_prompt_prefix + anchors)\n"
        "  --style-preset <p>   clean-professional | watercolor | oil-painting | anime |\n"
        "                      cinematic | 3d-render | line-art | low-poly\n"
        "  --prompt <text>     free-form style description\n\n"
        "Examples:\n"
        "  run.py image styletransfer --input photo.png --style-preset watercolor\n"
        "  run.py image styletransfer --input char.png --playbook clean-professional.yaml\n"
        "  run.py image styletransfer --input scene.png --style-preset cinematic --strength 0.6\n"
        "  run.py image styletransfer --input hero.png --prompt 'neon synthwave, 80s retro'\n"
        "  run.py image styletransfer --self-test\n"
    ),
}


def _option_registered(parser: "argparse.ArgumentParser", option: str) -> bool:
    for act in parser._actions:  # noqa: SLF001
        if option in act.option_strings:
            return True
    return False


def add_styletransfer_args(parser: "argparse.ArgumentParser") -> None:
    """Register styletransfer-specific arguments.

    Common args (--input→input_image, --prompt, --steps, --seed, --self-test,
    --gen-output-dir) are added by add_common_generation_args. ``--style`` is
    distinct from ``--prompt``; ``--playbook`` loads an OM style contract.
    """
    if not _option_registered(parser, "--style-preset"):
        parser.add_argument(
            "--style-preset", type=str, default=None, dest="style_preset",
            help="Named style preset. One of: "
                 + ", ".join(sorted(_STYLE_PRESETS)) + ".",
        )
    if not _option_registered(parser, "--playbook"):
        parser.add_argument(
            "--playbook", type=str, default=None,
            help="Path to an OM playbook YAML — restyle to its visual_language "
                 "(asset_generation.image_prompt_prefix + consistency_anchors + aesthetic).",
        )
    if not _option_registered(parser, "--strength"):
        parser.add_argument(
            "--strength", type=float, default=0.55, dest="style_strength",
            help="Style strength = img2img denoise (0–1, default 0.55). Lower "
                 "preserves more content structure; higher applies the style harder.",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_styletransfer(args: "argparse.Namespace") -> dict[str, str] | None:
    """Execute style transfer. Called by image.py dispatcher.

    Builds the style prompt, then delegates to the shared Flux2 Klein img2img
    generation path (execute_generation), which writes the image + manifest and
    prints the `Manifest: <path>` sentinel the bridge adapter parses.
    """
    from app.run_config import RunConfig
    from app.commands._shared import execute_generation, resolve_lora_paths

    # Self-test: synthesize a content image (a simple T2I) + force a preset. ---
    if getattr(args, "self_test", None):
        args.input_image = _synth_content(cfg.OUTPUT_DIR)
        if not getattr(args, "style_preset", None) and not getattr(args, "prompt", None):
            args.style_preset = "watercolor"
        if getattr(args, "steps", None) is None:
            args.steps = 4
        print(f"[styletransfer] self-test: src={args.input_image} "
              f"style={getattr(args, 'style_preset', None)}", flush=True)

    input_path = getattr(args, "input_image", None)
    if not input_path:
        print("ERROR: --input (content image) is required for styletransfer.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(input_path):
        print(f"ERROR: content image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    style_prompt = build_style_prompt(args)
    strength = getattr(args, "style_strength", 0.55)
    if strength is None:
        strength = 0.55
    strength = max(0.05, min(1.0, float(strength)))

    if getattr(args, "steps", None) is None:
        args.steps = 4  # Flux2 Klein distilled default

    print(f"[styletransfer] Content : {input_path}", flush=True)
    print(f"[styletransfer] Style   : {style_prompt[:100]}"
          f"{'…' if len(style_prompt) > 100 else ''}", flush=True)
    print(f"[styletransfer] Strength: {strength}  steps={getattr(args, 'steps')}",
          flush=True)

    # Build a RunConfig and delegate to the certified img2img generation path.
    run_config = RunConfig.from_args(args, command="image styletransfer")
    run_config.pipeline = "flux2-klein"
    run_config.prompt = style_prompt
    run_config.denoise_strength = strength
    lora_paths = resolve_lora_paths(getattr(args, "lora_path", None) or [])
    if lora_paths:
        run_config.lora_paths = lora_paths
        run_config.lora_path = lora_paths[0]

    execute_generation(run_config, pipeline_type="flux2-klein")
    return None


# ---------------------------------------------------------------------------
# Self-test content synthesis
# ---------------------------------------------------------------------------

def _synth_content(out_dir: str) -> str:
    """Generate a simple content image (ZImage T2I) for the self-test.

    The style-transfer MODEL runs on it; certification is via ``caption --style
    review`` that the style applied + content preserved. Deterministic prompt.
    """
    import gc
    import time

    import mlx.core as mx

    from app.pipeline import ZImagePipeline
    from app.commands._shared import generate_base_name

    os.makedirs(out_dir, exist_ok=True)
    prompt = (
        "A detective in a trench coat standing in a rainy noir alley, holding "
        "a magnifying glass, dramatic street lamp lighting, wet cobblestone, "
        "medium shot, detailed, high quality."
    )
    print("[styletransfer] self-test: generating content image (ZImage)...",
          flush=True)
    pipeline = ZImagePipeline()
    try:
        result = pipeline.generate(prompt=prompt, width=768, height=1024,
                                   steps=9, seed=42)
    finally:
        del pipeline
        mx.clear_cache()
        gc.collect()
    base = generate_base_name()
    ts = time.strftime("%Y%m%d_%H%M%S")
    path = os.path.join(out_dir, f"{base}_styletransfer_src_{ts}.png")
    result.image.save(path)
    print(f"[styletransfer] self-test: content saved {path}", flush=True)
    return path
