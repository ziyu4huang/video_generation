"""image-anime2real — Anime-to-realistic style transfer with identity preservation.

Uses Flux2KleinEdit reference conditioning + anime2real LoRA to convert anime-style
images to realistic output while preserving the original character's appearance
(hair color, clothing, facial features, pose).

Default style: 3D Game (Unreal Engine 5 aesthetic).
  A/B test result (2026-06-09): 3D Game won 3/4 votes vs photorealistic (0) and
  semi-realistic (1). Users preferred the "3D game realistic" look over plain
  photorealism. Use --realism-style to switch styles.

How it works
  Unlike traditional I2I (which mixes clean latents with noise and loses identity at
  high denoise), this approach uses Flux2KleinEdit's reference conditioning:

  1. The anime input image is VAE-encoded into reference latent tokens
  2. These tokens are concatenated with the noise latents (not mixed)
  3. The model "sees" the original character at every denoising step
  4. The anime2real LoRA biases the transformer toward realistic output

  Result: the output looks like a high-fidelity 3D game character model of the
  original anime character, preserving hair color, outfit, etc.

  This is far superior to the old I2I approach (denoise=0.6) which destroyed identity
  completely — different hair color, different clothing, different face.

Verified best parameters (3D Game default)
  --realism-style 3d-game  Default; Unreal Engine 5 game character aesthetic
  --steps 8                4 steps = too soft; 8 = crisp detail
  --anime2real-lora-scale 0.7  Balanced for 3D game style (1.0 = too photorealistic)
  --ref-count 1            1 reference copy sufficient (3 is 3x slower, similar result)
  --skip-preprocess (flag) Must use raw image, not canny/edge detection

Public API:
  add_anime2real_args(parser)  — register CLI arguments
  run_anime2real(args)         — execute anime-to-real style transfer
"""

import gc
import os
import sys
import time
from datetime import datetime, timezone

from app import config as cfg

# Default LoRA for anime-to-real style transfer
_DEFAULT_LORA = "anime-girl-turned-into-real-person"

# Realism style presets — prompt, lora_scale, steps
_REALISM_STYLES = {
    "photorealistic": {
        "prompt": (
            "A photorealistic portrait photograph of the same character, detailed realistic "
            "skin texture, natural lighting, DSLR camera, shallow depth of field, "
            "keeping the original hair color, clothing, and all character features"
        ),
        "lora_scale": 1.0,
        "steps": 8,
    },
    "3d-game": {
        "prompt": (
            "A high-quality 3D game character render of the same character, "
            "Unreal Engine 5, subsurface scattering skin, natural-looking eyes with "
            "realistic iris detail and reflections, cinematic rim lighting, "
            "realistic body proportions, game asset style, keeping the original "
            "hair color, clothing, and all character features"
        ),
        "lora_scale": 0.7,
        "steps": 8,
    },
    "semi-realistic": {
        "prompt": (
            "A semi-realistic digital illustration of the same character, "
            "detailed but slightly stylized, smooth skin, soft ambient lighting, "
            "blend of realistic and stylized aesthetics, keeping the original "
            "hair color, clothing, and all character features"
        ),
        "lora_scale": 0.85,
        "steps": 6,
    },
}

# Default prompt (matches --realism-style 3d-game)
_DEFAULT_PROMPT = _REALISM_STYLES["3d-game"]["prompt"]

# Self-test: anime prompts for comprehensive evaluation
_ANIME_TEST_PROMPTS = {
    "anime-portrait": (
        "anime girl with long pink hair, big sparkling eyes, wearing a school uniform, "
        "gentle smile, cel shading, anime art style, vibrant colors, simple background"
    ),
    "anime-warrior": (
        "anime girl with silver hair and red eyes, wearing dark armor, holding a katana, "
        "determined expression, standing in a misty battlefield, dramatic lighting, "
        "anime art style, detailed illustration"
    ),
    "anime-magical": (
        "anime girl with twin-tail blonde hair, wearing a frilly magical girl outfit "
        "with ribbons and lace, holding a star-tipped wand, sparkling magical effects, "
        "pastel colors, cheerful expression, anime art style"
    ),
    "anime-cyberpunk": (
        "anime girl with short blue hair and cybernetic implants, wearing a neon jacket "
        "over a crop top, futuristic city at night, holographic displays, "
        "cyberpunk anime art style, cool expression, vibrant neon lighting"
    ),
}

_I2I_PROMPT = (
    "Preserve the subject's features and generate a high quality "
    "realistic human photograph"
)


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

def add_anime2real_args(parser):
    """Register anime2real-specific CLI arguments."""
    from app.commands._shared import _arg_registered
    # NOTE: --ref-count and --lora-scale are NOT used here because other modules
    # (_shared.py, image-profile.py) register them with fixed defaults (3 and 1.0)
    # that conflict with anime2real's verified-best values (1 and per-style).
    # Anime2real uses dedicated params to avoid shared-default conflicts.
    parser.add_argument(
        "--anime2real-ref-count", type=int, default=1, metavar="N",
        help="Reference count for anime2real Flux2KleinEdit (1-4, default: 1). "
             "1 = fastest, sufficient quality. 3 = slower, marginally better.",
    )
    parser.add_argument(
        "--anime2real-lora-scale", type=float, default=None,
        help="LoRA scale override for anime2real. Default: depends on --realism-style "
             "(3d-game=0.7, photorealistic=1.0, semi-realistic=0.85).",
    )
    if not _arg_registered(parser, "realism_style"):
        parser.add_argument(
            "--realism-style", type=str, default="3d-game",
            choices=list(_REALISM_STYLES.keys()),
            help="Output realism style preset: 3d-game (default), photorealistic, semi-realistic. "
                 "Sets prompt, lora_scale, and steps unless overridden by explicit flags.",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_anime2real(args):
    """Execute anime-to-realistic style transfer.

    Uses Flux2KleinEdit reference conditioning + anime2real LoRA.
    The input anime image becomes a reference that preserves identity
    while the LoRA drives the style toward realistic.
    """
    from app.commands._shared import resolve_lora_path
    from app.flux2_controlnet_pipeline import Flux2KleinControlnetPipeline

    input_image_path = getattr(args, "input_image", None)
    if not input_image_path:
        print("ERROR: --input-image is required for anime2real mode.", file=sys.stderr)
        print("  Usage: run.py image anime2real --input-image anime.png", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(input_image_path):
        print(f"ERROR: Input image not found: {input_image_path}", file=sys.stderr)
        sys.exit(1)

    # Resolve parameters — apply realism-style preset first, then allow overrides.
    # lora_scale: uses dedicated --anime2real-lora-scale (default=None) to avoid
    # conflicting with the shared --lora-scale (default=1.0).  When None, the
    # per-style preset value is used (3d-game=0.7, photorealistic=1.0, etc.).
    realism_style = getattr(args, "realism_style", "3d-game")
    style_preset = _REALISM_STYLES.get(realism_style, _REALISM_STYLES["3d-game"])

    prompt = getattr(args, "prompt", None) or style_preset["prompt"]
    steps = getattr(args, "steps", None) or style_preset["steps"]
    seed = getattr(args, "seed", 42)
    lora_path_raw = getattr(args, "lora_path", None) or _DEFAULT_LORA
    lora_path = resolve_lora_path(lora_path_raw)

    # Use dedicated --anime2real-lora-scale if provided, otherwise style preset.
    lora_scale = getattr(args, "anime2real_lora_scale", None) or style_preset["lora_scale"]
    # NOTE: uses --anime2real-ref-count (default=1), NOT shared --ref-count (default=3).
    ref_count = getattr(args, "anime2real_ref_count", 1)

    # Get output dimensions from input image
    from PIL import Image
    with Image.open(input_image_path) as img:
        src_w, src_h = img.size
    out_w = (src_w // 16) * 16
    out_h = (src_h // 16) * 16

    # Create output directory
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_label = f"anime2real-{ts}_ref{ref_count}-{steps}st-s{seed}"
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{out_label}.png")

    print(f"\n{'═' * 60}")
    print(f" Anime → Realistic Style Transfer")
    print(f"{'═' * 60}")
    print(f"  Input     : {input_image_path} ({src_w}×{src_h})")
    print(f"  Output    : {out_w}×{out_h}")
    print(f"  Prompt    : {prompt[:80]}{'…' if len(prompt) > 80 else ''}")
    print(f"  LoRA      : {os.path.basename(lora_path)} (scale={lora_scale})")
    print(f"  Steps/seed: {steps} / {seed}")
    print(f"  Ref count : {ref_count}")
    print(f"  Method    : Flux2KleinEdit reference conditioning + LoRA")
    print()

    # --- Load pipeline with LoRA ---
    print(f"[anime2real] Loading Flux2KleinEdit + LoRA...")
    pipeline = Flux2KleinControlnetPipeline(
        lora_paths=[lora_path],
        lora_scales=[lora_scale],
    )

    # --- Generate with reference conditioning ---
    print(f"[anime2real] Generating {out_w}×{out_h} (steps={steps}, ref_count={ref_count})...")
    from PIL import Image as _PILImage
    ctrl_pil = _PILImage.open(input_image_path).convert("RGB").resize((out_w, out_h), _PILImage.LANCZOS)
    t0 = time.time()
    result = pipeline.generate(
        prompt=prompt,
        control_image=ctrl_pil,
        width=out_w,
        height=out_h,
        steps=steps,
        seed=seed,
        controlnet_strength=1.0,
        ref_count=ref_count,
    )
    elapsed = time.time() - t0

    # --- Save ---
    result.image.save(out_path)
    print(f"[anime2real] Saved: {out_path} ({elapsed:.1f}s)")

    # --- Save manifest ---
    manifest = {
        "command": "image anime2real",
        "timestamp": ts,
        "method": "Flux2KleinEdit reference conditioning + anime2real LoRA",
        "input_image": input_image_path,
        "prompt": prompt,
        "lora_path": lora_path,
        "lora_scale": lora_scale,
        "steps": steps,
        "seed": seed,
        "ref_count": ref_count,
        "output": out_path,
        "elapsed_seconds": round(elapsed, 1),
        "outputs": [{"path": out_path, "label": "anime2real"}],
    }
    manifest_path = out_path.replace(".png", ".manifest.json")
    import json
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"[anime2real] Manifest: {manifest_path}")

    # --- Cleanup ---
    del pipeline
    import mlx.core as mx
    mx.clear_cache()
    gc.collect()

    print(f"\n{'═' * 60}")
    print(f" Done! ({elapsed:.1f}s)")
    print(f"{'═' * 60}")
