"""image-angle — angle-view reframe sub-action for 'run.py image angle'.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_angle_args(parser)  — register angle-specific CLI arguments
  run_angle(args)         — execute angle-view reframe
  ANGLE_PRESETS           — named (azimuth, elevation) presets (also in schema-defaults)
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import (
    DEFAULT_UPSCALE_MODEL,
    _apply_upscale,
    _arg_registered,
    _resolve_resolution,
)

_ANGLE_DEFAULT_STEPS = 6

# Multi-reference conditioning count ceiling for the distilled Flux2KleinEdit
# pipeline. Validated via A/B (mirror image-profile.py:648-661): ref-count 1-3
# work (default 3 = best identity fidelity); >3 over-conditions → solid-black /
# abstract texture. THIS is the real identity lever for angle — NOT image_strength
# (which is a txt2img-only path that breaks edit pipelines; see
# image-profile.py:663-673 / memory: profile-ref-strength-breaks-flux2-edit).
_ANGLE_MAX_REF_COUNT = 3
_ANGLE_DEFAULT_REF_COUNT = 3

# Named camera-angle presets → (azimuth_deg, elevation_deg). Azimuth uses the
# canonical 0-360 form (the modulo in _angle_to_text normalizes any value).
# Surfaced to the GUI via schema-defaults (serverDefaults.angle_presets) so the
# preset names can never drift from what --angle resolves on the server.
ANGLE_PRESETS = {
    # Eye-level compass (8-way)
    "front":        (0.0,   0.0),
    "front-right":  (45.0,  0.0),
    "right":        (90.0,  0.0),
    "rear-right":   (135.0, 0.0),
    "back":         (180.0, 0.0),
    "rear-left":    (225.0, 0.0),
    "left":         (270.0, 0.0),
    "front-left":   (315.0, 0.0),
    # Elevated / depressed (±45°)
    "front-high":   (0.0,   45.0),
    "right-high":   (90.0,  45.0),
    "back-high":    (180.0, 45.0),
    "front-low":    (0.0,  -45.0),
    "right-low":    (90.0, -45.0),
    # Extreme vertical
    "birds-eye":    (0.0,   75.0),
    "worms-eye":    (0.0,  -75.0),
}


def add_angle_args(parser: "argparse.ArgumentParser") -> None:
    """Register angle-specific arguments on an argparse parser."""
    parser.add_argument(
        "--input", "--input-image",
        metavar="IMAGE",
        dest="input_image",
        default=None,
        help="Reference/input image path. Required for 'angle' sub-action. "
             "(--input-image is a deprecated alias; --input is preferred.) "
             "For T2I: provides visual anchor for image-conditioned generation — "
             "use with same seed + different prompt to generate FLF2V keyframe pairs "
             "with consistent background.",
    )
    # --azimuth / --elevation use SUPPRESS so hasattr() can tell "user passed an
    # explicit value" from "attribute absent". This lets --angle presets act as
    # defaults that explicit degrees override. These dests are angle-exclusive
    # (no other command registers them), so SUPPRESS is safe.
    parser.add_argument(
        "--azimuth",
        type=float,
        default=argparse.SUPPRESS,
        metavar="DEG",
        help="Horizontal camera angle: 0=front 90=right 180=back 270=left. "
             "Explicit value overrides --angle preset (default: 90 / from --angle).",
    )
    parser.add_argument(
        "--elevation",
        type=float,
        default=argparse.SUPPRESS,
        metavar="DEG",
        help="Vertical camera angle: >0=high-angle(camera above) <0=low-angle(camera below). "
             "Explicit value overrides --angle preset (default: 0 / from --angle).",
    )
    parser.add_argument(
        "--angle",
        default=None,
        metavar="PRESET",
        help="Named camera-angle preset (clearer than raw degrees): "
             "front/front-right/right/rear-right/back/rear-left/left/front-left, "
             "+ front-high/right-high/back-high/front-low/right-low, + birds-eye/worms-eye. "
             "Explicit --azimuth/--elevation override the preset.",
    )
    # NOTE: --ref-count is NOT registered here — it is registered by add_profile_args()
    # on the same shared image parser (dest=ref_count, default=3). Angle consumes it
    # via getattr() exactly like --transformer/--steps/--seed (registered by t2i/common).
    # Semantically identical: both are multi-reference conditioning for Flux2KleinEdit.
    # run_angle clamps it to _ANGLE_MAX_REF_COUNT with a warning (profile does too).
    parser.add_argument(
        "--rich-angle-text",
        action="store_true",
        default=False,
        help="Use finer-grained elevation phrasing in the prompt (5 buckets: birds-eye/"
             "high/eye-level/low/worms-eye). Off by default to keep prompts byte-identical "
             "to prior runs (reproducibility).",
    )
    # --transformer is registered first by add_t2i_args() on the shared image
    # parser, so the guard skips here in practice — but registering it (guarded)
    # makes angle self-documenting and robust if angle ever runs its own parser.
    if not _arg_registered(parser, "transformer"):
        parser.add_argument(
            "--transformer", default="klein-9b", metavar="NAME",
            help="Transformer instance dir under models/transformer/ (default: klein-9b). "
                 "Any flux2-klein-family instance (klein-9b, kleinova-nsfw-v3, luciddreamer-z, ...).",
        )


def run_angle(args: "argparse.Namespace") -> None:
    """Execute angle-view reframe. Called by image.py dispatcher."""
    if not args.input_image:
        print("ERROR: 'image angle' requires --input IMAGE_PATH", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.input_image):
        print(f"ERROR: Input file not found: {args.input_image}", file=sys.stderr)
        sys.exit(1)

    azimuth, elevation, angle_preset = _resolve_effective_angle(args)
    ref_count = _clamp_ref_count(int(getattr(args, "ref_count", _ANGLE_DEFAULT_REF_COUNT)))

    steps = args.steps if args.steps is not None else _ANGLE_DEFAULT_STEPS
    # --seed defaults to None (profile registers it as a sentinel); fall back to
    # the shared default 777 so bare `image angle IMG` doesn't TypeError on `%`.
    seed = (args.seed if args.seed is not None else 777) % (2 ** 32)

    # ── Resolution: --resolution tier/override > --width/--height > 640×960 ──
    # (angle previously read width/height directly and silently ignored --resolution.)
    res_override = _resolve_resolution(getattr(args, "resolution", None), "flux2-klein")
    if res_override:
        width, height = res_override
    else:
        width = args.width if args.width is not None else 640
        height = args.height if args.height is not None else 960

    transformer_name = getattr(args, "transformer", "klein-9b")
    rich = bool(getattr(args, "rich_angle_text", False))
    angle_text = _angle_to_text(azimuth, elevation, rich=rich)
    user_prompt = getattr(args, "prompt", None)
    if getattr(args, "prompt_file", None):
        with open(args.prompt_file, "r") as f:
            user_prompt = f.read().strip()
    prompt = _build_angle_prompt(user_prompt, angle_text)

    src = f"--angle {angle_preset}" if angle_preset else "explicit degrees"
    print(f"Input:     {args.input_image}")
    print(f"Angle:     azimuth={azimuth}°  elevation={elevation}°  ({src})  → \"{angle_text}\"")
    print(f"Reference: ×{ref_count}  (identity conditioning)")
    print(f"Transform: {transformer_name}  (variant {getattr(args, 'variant', '9b')})")
    print(f"Prompt:    {prompt}")
    print(f"Size:      {width}×{height}  steps={steps}  seed={seed}")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = f"image_angle_{time.strftime('%Y%m%d_%H%M%S')}"
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")

    run_meta = {
        "command": "image",
        "action": "angle",
        "input": args.input_image,
        "angle_preset": angle_preset,
        "azimuth": azimuth,
        "elevation": elevation,
        "angle_text": angle_text,
        "rich_angle_text": rich,
        "ref_count": ref_count,
        "transformer": transformer_name,
        "resolution": getattr(args, "resolution", None),
        "prompt": prompt,
        "width": width,
        "height": height,
        "steps": steps,
        "seed": seed,
        "variant": getattr(args, "variant", "9b"),
    }
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    start_time = datetime.now(timezone.utc).isoformat()
    last_timings = {}
    all_outputs = []

    upscale_model = None
    if args.upscale:
        upscale_model = getattr(args, "upscale_model", None) or DEFAULT_UPSCALE_MODEL
    upscale_method = getattr(args, "upscale_method", "esrgan")

    from app.flux2_pipeline import Flux2KleinPipeline
    from app.manifest import Manifest, collect_model_fingerprint

    pipeline = Flux2KleinPipeline(
        model_path=getattr(args, "flux2_model_path", None),
        quantize=getattr(args, "quantize", None),
        variant=getattr(args, "variant", "9b"),
        transformer_name=transformer_name,
    )

    # Multi-reference conditioning: pass the input N× to strengthen identity.
    reference_images = [args.input_image] * ref_count

    try:
        count = max(1, getattr(args, "count", 1))
        seed_start = getattr(args, "seed_start", None)

        for i in range(count):
            item_seed = ((seed_start + i) if seed_start is not None else seed) % (2 ** 32)
            if count > 1:
                print(f"\n=== Batch {i + 1}/{count} (seed={item_seed}) ===")

            result = pipeline.generate(
                seed=item_seed,
                prompt=prompt,
                reference_images=reference_images,
                width=width,
                height=height,
                steps=steps,
                cfg_scale=getattr(args, "cfg_scale", None),
            )

            if args.upscale and upscale_model:
                result = _apply_upscale(
                    result, upscale_method, upscale_model,
                    upscale_resolution=getattr(args, "upscale_resolution", "2x"),
                    upscale_softness=getattr(args, "upscale_softness", 0.5),
                    seed=item_seed,
                )

            suffix = f"_s{item_seed}" if count > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}{suffix}.png")
            result.image.save(out_path)
            print(f"Saved: {out_path}")

            last_timings = result.timings
            all_outputs.append({
                "path": out_path,
                "seed": item_seed,
                "size_bytes": os.path.getsize(out_path),
                "width": result.image.width,
                "height": result.image.height,
            })

        end_time = datetime.now(timezone.utc).isoformat()
        models = collect_model_fingerprint(lora_path=None, upscale_model=upscale_model)
        manifest = Manifest.from_success(run_file, start_time, end_time,
                                         last_timings, all_outputs, models)
        manifest.to_json(manifest_file)
        print(f"Run config: {run_file}")
        print(f"Manifest:   {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, last_timings, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_effective_angle(args: "argparse.Namespace") -> tuple[float, float, "str | None"]:
    """Resolve the effective (azimuth, elevation, angle_preset) from args.

    Precedence: explicit --azimuth/--elevation  >  --angle preset  >  builtin default.
    --azimuth/--elevation use argparse.SUPPRESS, so the attribute is absent unless the
    user passed an explicit value — that absence is how a preset acts as an overridable
    default. Returns angle_preset=None when explicit degrees are the effective input.
    """
    angle_preset = getattr(args, "angle", None)
    if hasattr(args, "azimuth") or hasattr(args, "elevation"):
        return float(getattr(args, "azimuth", 90.0)), float(getattr(args, "elevation", 0.0)), None
    if angle_preset:
        if angle_preset not in ANGLE_PRESETS:
            avail = ", ".join(sorted(ANGLE_PRESETS))
            print(f"ERROR: unknown --angle preset '{angle_preset}'. Available: {avail}",
                  file=sys.stderr)
            sys.exit(1)
        azimuth, elevation = ANGLE_PRESETS[angle_preset]
        return float(azimuth), float(elevation), angle_preset
    return 90.0, 0.0, None


def _clamp_ref_count(count: int) -> int:
    """Clamp multi-reference count to [1, _ANGLE_MAX_REF_COUNT], warning if reduced.

    >3 over-conditions the distilled Flux2KleinEdit pipeline (solid-black/texture).
    Mirrors image-profile.py:648-661. (memory: profile-ref-strength-breaks-flux2-edit)
    """
    count = max(1, int(count))
    if count > _ANGLE_MAX_REF_COUNT:
        print(f"WARNING: --ref-count {count} over-conditions the distilled "
              f"Flux2KleinEdit pipeline (solid-black/texture above "
              f"{_ANGLE_MAX_REF_COUNT}); clamping to {_ANGLE_MAX_REF_COUNT} "
              f"(the validated best value).")
        return _ANGLE_MAX_REF_COUNT
    return count


# 8-way compass directions (45° buckets). Used by both rich and non-rich paths —
# only the elevation granularity differs.
_AZIMUTH_DIRECTIONS = [
    "front view",
    "front-right three-quarter view",
    "right side profile",
    "rear-right three-quarter view",
    "back view",
    "rear-left three-quarter view",
    "left side profile",
    "front-left three-quarter view",
]


def _angle_to_text(azimuth: float, elevation: float, rich: bool = False) -> str:
    """Convert azimuth/elevation degrees to a human-readable camera-angle phrase.

    The default (rich=False) path is byte-identical to the historical mapping, so
    prior runs reproduce exactly. rich=True adds finer-grained elevation buckets
    (birds-eye/worms-eye) for clearer prompting — opt-in via --rich-angle-text.
    """
    az_idx = int((azimuth % 360 + 22.5) / 45) % 8
    az_text = _AZIMUTH_DIRECTIONS[az_idx]

    if rich:
        if elevation > 60:
            el_text = ", birds-eye view (camera far above, looking steeply down)"
        elif elevation > 20:
            el_text = ", high angle shot (camera above, looking down)"
        elif elevation < -60:
            el_text = ", worms-eye view (camera far below, looking steeply up)"
        elif elevation < -20:
            el_text = ", low angle shot (camera below, looking up)"
        else:
            el_text = ""
    else:
        if elevation > 20:
            el_text = ", high angle shot (camera above, looking down)"
        elif elevation < -20:
            el_text = ", low angle shot (camera below, looking up)"
        else:
            el_text = ""

    return az_text + el_text


def _build_angle_prompt(user_prompt: str | None, angle_text: str) -> str:
    """Build the Flux2-Klein generation prompt for an angle reframe."""
    if user_prompt:
        base = f"{user_prompt}，"
    else:
        base = "保持人物外貌、服裝、髮型完全一致，"
    return (
        f"{base}{angle_text}, "
        "photorealistic, maintain character identity and appearance consistency"
    )
