"""image-character — character sheet + transparent parts + IdentitySpec (OM gap F).

OpenMontage's character-animation asset need is a bundle: a multi-view sheet of
one hero, transparent cutouts of each view (for rigging), and a PERSISTENT
identity spec so the SAME character recurs in later T2I/storyboard calls. MLX
had the pieces (``image profile`` multi-view ref-conditioning, Step-1 ``image
cutout``) but no single command + no persistent identity lock. This is it.

PIPELINE (composes the certified primitives — zero new MLX generation code):
  1. ``image profile`` multi-view (front / side / back) — Flux2KleinEdit
     reference conditioning on the hero, locked seed across views. Delegated to
     ``app/commands/image-profile.py`` (reuses its proven generation + VLM angle
     verification). Returns the timestamped view folder + the locked seed.
  2. Step-1 ``cutout`` per view — SAM3 segments the figure → feathered alpha →
     RGBA transparent PNG (the rigging "parts"). One transparent cutout per view.
  3. ``IdentitySpec.json`` (schema ``character-lock.v1`` — mirrors
     ``bun-apps/.../src/character_lock.ts``) capturing hero + the locked
     seed/ref/style params, so a later ``image storyboard --character <hero>``
     consumes it and renders the same identity. The `views[]` extension lists
     the generated sheet + cutout paths.

This is the LOCAL path (constraint 1: never cloud). The deep CharaConsist /
Kontext port is Future (the soft ref-conditioning lock is the certified path).

Imported by app.commands.image via importlib (hyphen in filename).

Public API:
  build_identity_spec(hero, seed, args, views)  — pure builder (pytest target)
  add_character_args(parser)                    — register character args
  run_character(args)                           — execute the character sheet
"""
import argparse
import json
import os
import sys

import numpy as np

from app import config as cfg


_SCHEMA = "character-lock.v1"

# Default SAM3 subject prompt for the figure cutout. SAM3 text segmentation
# prefers CONCISE prompts — "person" reliably scores ~0.94, while comma lists
# ("character, person, full figure") return 0 detections. Keep it short.
_DEFAULT_CUTOUT_SUBJECT = "person"


# ---------------------------------------------------------------------------
# IdentitySpec builder (pure — the pytest target, no generation/model)
# ---------------------------------------------------------------------------

def build_identity_spec(
    hero: str,
    seed: int,
    args: "argparse.Namespace",
    views: list[dict],
) -> dict:
    """Build the ``character-lock.v1`` IdentitySpec dict from the lock params.

    Pure: assembles the spec the way ``character_lock.ts`` defines it, so a
    downstream consumer (the storyboard character-lock) can persist + reuse it.
    ``views`` is a list of ``{view, image, cutout}`` dicts (the sheet artifacts);
    it rides as an extension field (extra fields don't break the v1 schema).
    """
    pipeline = (getattr(args, "pipeline", None) or "flux2-klein")
    if pipeline == "auto":
        pipeline = "flux2-klein"
    lock = {
        "pipeline": pipeline,
        "seed": int(seed),
        "refCount": int(getattr(args, "ref_count", 3) or 3),
        "refStrength": float(getattr(args, "ref_strength", 0.8) or 0.8),
        "styleAnchor": (getattr(args, "style_anchor", None) or "").strip(),
    }
    lora_paths = getattr(args, "lora_path", None)
    if lora_paths:
        first = lora_paths[0] if isinstance(lora_paths, list) else lora_paths
        lock["loraPath"] = first
        lock["loraScale"] = float(getattr(args, "lora_scale", None) or 1.0)
    cfg_scale = getattr(args, "cfg_scale", None)
    if cfg_scale is not None:
        lock["cfgScale"] = float(cfg_scale)

    spec = {
        "schema": _SCHEMA,
        "hero": hero,
        "lock": lock,
        "shots": [],  # the sheet is the asset; future shots planned by character_lock.ts
        "views": views,  # extension: the generated multi-view sheet + cutouts
    }
    return spec


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Character sheet: multi-view + transparent cutouts + IdentitySpec (OM F)",
    "description": (
        "Build a reusable character asset from one hero image:\n"
        "  1. image profile multi-view (front/side/back) via Flux2 Klein ref-cond\n"
        "  2. transparent cutout per view (SAM3 → alpha PNG)\n"
        "  3. IdentitySpec.json (character-lock.v1) — locks seed/ref/style so the\n"
        "     SAME character recurs in later storyboard/T2I calls\n\n"
        "Composes the certified profile + cutout primitives (no new MLX code).\n\n"
        "Examples:\n"
        "  run.py image character --input hero.png\n"
        "  run.py image character --input hero.png --views front side back\n"
        "  run.py image character --input hero.png --style-anchor 'soft anime shading, blue palette'\n"
        "  run.py image character --self-test\n"
    ),
}


def _option_registered(parser: "argparse.ArgumentParser", option: str) -> bool:
    for act in parser._actions:  # noqa: SLF001
        if option in act.option_strings:
            return True
    return False


def add_character_args(parser: "argparse.ArgumentParser") -> None:
    """Register character-specific arguments.

    Most generation params (--views, --ratio, --seed, --ref-count, --ref-strength,
    --lora-path, --pipeline, --input→input_image) are shared with `image profile`
    and already registered by add_profile_args / add_common_generation_args.
    """
    if not _option_registered(parser, "--style-anchor"):
        parser.add_argument(
            "--style-anchor", type=str, default=None, dest="style_anchor",
            help="Shared prompt suffix locked into the IdentitySpec so every later "
                 "shot of this character inherits the same look/palette.",
        )
    if not _option_registered(parser, "--cutout-subject"):
        parser.add_argument(
            "--cutout-subject", type=str, default=_DEFAULT_CUTOUT_SUBJECT,
            help="SAM3 text prompt for the per-view figure cutout "
                 f"(default: '{_DEFAULT_CUTOUT_SUBJECT}').",
        )


# ---------------------------------------------------------------------------
# Per-view transparent cutout (reuses Step-1 cutout machinery)
# ---------------------------------------------------------------------------

def _cutout_view(
    src_path: str,
    subject: str,
    threshold: float,
    feather: int,
    fill_holes: bool,
) -> tuple[str | None, str | None]:
    """Segment + alpha-composite one view → transparent RGBA PNG.

    Returns (cutout_path, mask_path). cutout_path is None if SAM3 found nothing.
    Reuses get_sam3_predictor / segment_image / feather_mask / alpha_cutout /
    _fill_holes from image-cutout (Step 1) — the same certified machinery.
    """
    from PIL import Image
    import importlib as _imp
    # Hyphenated module name — must use importlib (a normal `from` import fails).
    _cutout_mod = _imp.import_module("app.commands.image-cutout")
    alpha_cutout = _cutout_mod.alpha_cutout
    fill_holes_fn = _cutout_mod._fill_holes
    from app.sam3_predictor import get_sam3_predictor, segment_image, feather_mask

    with Image.open(src_path) as _im:
        source = _im.convert("RGB")

    predictor = get_sam3_predictor(threshold=threshold)
    result = segment_image(predictor, source, subject, score_threshold=threshold)
    if len(result.scores) == 0:
        print(f"  [cutout] no detection for '{subject}' in {os.path.basename(src_path)}",
              flush=True)
        return None, None

    best = int(np.argmax(result.scores))
    mask = result.masks[best]
    score = float(result.scores[best])
    if fill_holes:
        mask = fill_holes_fn(mask)
    alpha = feather_mask(mask, radius=feather)
    rgba = alpha_cutout(source, alpha)

    d = os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]
    cutout_path = os.path.join(d, f"{stem}_cutout.png")
    rgba.save(cutout_path)
    print(f"  [cutout] {os.path.basename(src_path)} → {os.path.basename(cutout_path)} "
          f"(score={score:.3f})", flush=True)
    return cutout_path, None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_character(args: "argparse.Namespace") -> dict[str, str] | None:
    """Execute the character sheet. Called by image.py dispatcher."""
    import importlib

    _profile = importlib.import_module("app.commands.image-profile")

    # Self-test: synthesize a hero portrait, then build the sheet. -----------
    if getattr(args, "self_test", None):
        args.input_image = _synth_hero(cfg.OUTPUT_DIR)
        if getattr(args, "steps", None) is None:
            args.steps = 4  # faster multi-view for the self-test
        if not getattr(args, "views", None):
            args.views = ["front", "side", "back"]
        print(f"[character] self-test: hero={args.input_image}", flush=True)

    hero = getattr(args, "input_image", None) or getattr(args, "input", None)
    if not hero:
        print("ERROR: --input (hero image) is required for character.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(hero):
        print(f"ERROR: hero image not found: {hero}", file=sys.stderr)
        sys.exit(1)

    # Default views = the full sheet.
    if not getattr(args, "views", None):
        args.views = ["front", "side", "back"]

    print(f"[character] Hero : {hero}", flush=True)
    print(f"[character] Views: {args.views}", flush=True)

    # Phase 1: multi-view generation via the certified profile command. -----
    print(f"\n{'='*60}\n[character] Phase 1: multi-view profile\n{'='*60}", flush=True)
    profile_result = _profile.run_profile(args)
    if not profile_result:
        print("ERROR: profile generation failed; aborting character sheet.",
              file=sys.stderr)
        sys.exit(1)
    out_dir = profile_result["out_dir"]
    view_outputs = profile_result["view_outputs"]
    seed = profile_result["seed"]
    print(f"[character] Views generated in {out_dir}", flush=True)

    # Phase 2: transparent cutout per view. ---------------------------------
    print(f"\n{'='*60}\n[character] Phase 2: transparent cutouts\n{'='*60}", flush=True)
    subject = getattr(args, "cutout_subject", None) or _DEFAULT_CUTOUT_SUBJECT
    threshold = float(getattr(args, "sam_threshold", 0.3) or 0.3)
    feather = int(getattr(args, "feather", 10) or 0)
    # A character turnaround silhouette MUST be solid — fill interior holes so
    # gaps between arm/torso don't render as translucent slits. NOTE: the shared
    # --fill-holes flag (registered by `image cutout`) defaults to False, so
    # reading getattr(args, "fill_holes", True) would return False (the registered
    # default wins over our fallback — the same `getattr(...) or default` pitfall
    # that bit profile's --transformer). A character sheet always fills.
    fill_holes = True

    views_meta: list[dict] = []
    cutout_count = 0
    for vo in view_outputs:
        view = vo.get("view")
        img_path = vo.get("path")
        entry = {"view": view, "image": img_path, "cutout": None}
        if img_path and os.path.exists(img_path):
            cutout_path, _ = _cutout_view(img_path, subject, threshold, feather, fill_holes)
            if cutout_path:
                entry["cutout"] = cutout_path
                cutout_count += 1
        views_meta.append(entry)
    print(f"[character] {cutout_count}/{len(view_outputs)} transparent cutouts produced.",
          flush=True)

    # Phase 3: IdentitySpec.json. -------------------------------------------
    spec = build_identity_spec(hero, seed, args, views_meta)
    spec_path = os.path.join(out_dir, "IdentitySpec.json")
    with open(spec_path, "w") as f:
        json.dump(spec, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\n[character] IdentitySpec: {spec_path}", flush=True)
    print(f"[character] schema={spec['schema']} seed={spec['lock']['seed']} "
          f"refCount={spec['lock']['refCount']} cutouts={cutout_count}", flush=True)

    # Manifest sentinel (point at the IdentitySpec; bridge globs the folder).
    print(f"Manifest:   {spec_path}")
    return {"identity_spec": spec_path, "out_dir": out_dir,
            "cutouts": cutout_count}


# ---------------------------------------------------------------------------
# Self-test hero synthesis
# ---------------------------------------------------------------------------

def _synth_hero(out_dir: str) -> str:
    """Generate a hero portrait (ZImage T2I) for the self-test."""
    import gc
    import time

    import mlx.core as mx

    from app.commands._shared import generate_base_name
    from app.pipeline import ZImagePipeline

    os.makedirs(out_dir, exist_ok=True)
    prompt = (
        "Full-body character design sheet of a young woman detective, brown "
        "trench coat, white shirt, black trousers, short bob hair, confident "
        "expression, standing A-pose, plain white background, studio lighting, "
        "clean character turnaround reference, high quality."
    )
    print("[character] self-test: generating hero (ZImage)...", flush=True)
    pipeline = ZImagePipeline()
    try:
        result = pipeline.generate(prompt=prompt, width=832, height=1216,
                                   steps=9, seed=42)
    finally:
        del pipeline
        mx.clear_cache()
        gc.collect()
    base = generate_base_name()
    ts = time.strftime("%Y%m%d_%H%M%S")
    path = os.path.join(out_dir, f"{base}_character_hero_{ts}.png")
    result.image.save(path)
    print(f"[character] self-test: hero saved {path}", flush=True)
    return path
