"""image-multicouple — put two characters (same art style, different look/body/
age) in ONE picture via LATENT-space compositing (Latent-Couple).

Imported by app.commands.image via importlib (hyphen in filename prevents regular
import statements).

WHY LATENT SPACE (not the pixel composite+blend shipped in v1 of
multi-character-compose): each character is generated as *character + its own
background*. Compositing in PIXEL space bakes two incompatible backgrounds in —
the VAE encode of a hard seam is a fact the low-denoise i2i pass cannot undo, so
the central seam stays visible (v1 scored ~2/5 background continuity). Here we
composite the two LATENTS side-by-side and resume-denoise the merge: the DiT's
joint self-attention crosses the seam and regenerates ONE coherent background.
See docs/multi-character-compose.md (the "Latent-Couple" section).

Pipeline (all three stages reuse one ZImagePipeline instance; serial, GPU-safe):
  1. generate charA with return_latent=True  → image + latent_A
  2. generate charB with return_latent=True  → image + latent_B
  3. composite_latents_side_by_side(A, B)     → merged latent
     generate(init_latent=merged, denoise_strength=merge_denoise) → final

Public API:
  add_multicouple_args(parser) — register multicouple-specific CLI arguments
  run_multicouple(args)        — execute the latent-couple pipeline
"""

import argparse
import json
import os
import sys

from app import config as cfg

# Z-Image CFG is the single biggest quality lever (zimage-cfg-wired-biggest-
# quality-lever): ~3.0 jumps overall 4→6. Default ON for every multicouple pass
# (A, B, and the resume). Caller can override/disable via the shared --cfg-scale.
_DEFAULT_CFG = 3.0
_DEFAULT_MERGE_DENOISE = 0.6  # resume strength: 0.5–0.7 = enough freedom to repaint
# the two backgrounds into one, while the merged latent holds structure. Higher
# (0.7) unifies the background harder at the cost of more character drift.
_DEFAULT_FEATHER = 8  # latent cols (image px = ×8 = 64px feather band)
_DEFAULT_STYLE = (
    "cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, "
    "painterly fantasy atmosphere"
)
_DEFAULT_MERGE_PROMPT = (
    "two young women standing together in a dreamlike surreal fantasy scene, one "
    "on the left, one on the right, facing each other, unified cinematic lighting, "
    "hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere"
)


def add_multicouple_args(parser: argparse.ArgumentParser) -> None:
    """Register multicouple-specific arguments on an argparse parser.

    Shares --transformer/--width/--height/--steps/--cfg-scale/--seed/--json-summary
    (registered by image-t2i + common args). Only the multi-character knobs live here.
    """
    parser.add_argument(
        "--prompt-a", default=None, metavar="TEXT",
        help="Character A appearance prompt (left of frame). Style tags appended "
             "automatically via --style.",
    )
    parser.add_argument(
        "--prompt-b", default=None, metavar="TEXT",
        help="Character B appearance prompt (right of frame).",
    )
    parser.add_argument(
        "--merge-prompt", default=None, metavar="TEXT",
        help="Unified scene prompt for the resume pass (drives background unification). "
             f"Default: a dreamlike two-women scene. (default prompt: '{_DEFAULT_MERGE_PROMPT[:40]}…')",
    )
    parser.add_argument("--seed-a", type=int, default=42, help="Character A seed.")
    parser.add_argument("--seed-b", type=int, default=777, help="Character B seed.")
    parser.add_argument(
        "--merge-seed", type=int, default=42, metavar="N",
        help="Seed for the resume-denoise pass (the merge).",
    )
    parser.add_argument(
        "--merge-denoise", type=float, default=_DEFAULT_MERGE_DENOISE, metavar="0..1",
        help=f"Resume denoise strength ({_DEFAULT_MERGE_DENOISE}: enough to unify the two "
             "backgrounds; bump to 0.7 for harder unification at more character drift).",
    )
    parser.add_argument(
        "--merge-feather", type=int, default=_DEFAULT_FEATHER, metavar="LATENT_COLS",
        help="Latent-space seam feather width, in latent columns (image px = ×8). "
             f"Default {_DEFAULT_FEATHER} = {_DEFAULT_FEATHER * 8}px band.",
    )
    parser.add_argument(
        "--style", default=_DEFAULT_STYLE, metavar="TAGS",
        help="Trailing style tags appended to BOTH character prompts — the "
             "style-consistency lever (same transformer + same tags ⇒ same art style).",
    )


def _resolve_pipeline(args: argparse.Namespace):
    """Build a ZImagePipeline, resolving the transformer dir from --transformer."""
    from app.pipeline import ZImagePipeline

    transformer = getattr(args, "transformer", None)
    if transformer:
        t_dir = os.path.join(cfg.MODELS_DIR, "transformer", transformer)
        if not os.path.isdir(t_dir):
            raise FileNotFoundError(
                f"Transformer '{transformer}' not found at {t_dir}"
            )
        print(f"[Pipeline] Using transformer: {transformer}", flush=True)
        return ZImagePipeline(transformer_dir=t_dir), transformer
    return ZImagePipeline(), None


def run_multicouple(args: argparse.Namespace) -> None:
    """Execute the latent-couple multi-character pipeline. Called by image.py."""
    from app.pipeline import composite_latents_side_by_side

    width = getattr(args, "width", None) or 640
    height = getattr(args, "height", None) or 960
    steps = getattr(args, "steps", None) or 9
    # CFG: respect an explicit --cfg-scale, else default ON (the Z-Image quality lever).
    cfg_scale = getattr(args, "cfg_scale", None)
    if cfg_scale is None:
        cfg_scale = _DEFAULT_CFG
    style = args.style or ""

    prompt_a = getattr(args, "prompt_a", None)
    prompt_b = getattr(args, "prompt_b", None)
    if not prompt_a or not prompt_b:
        print("ERROR [multicouple]: --prompt-a and --prompt-b are required.",
              file=sys.stderr)
        sys.exit(1)
    merge_prompt = getattr(args, "merge_prompt", None) or _DEFAULT_MERGE_PROMPT

    # Style-consistency lever: identical trailing tags on both character prompts.
    prompt_a_full = f"{prompt_a}, {style}" if style else prompt_a
    prompt_b_full = f"{prompt_b}, {style}" if style else prompt_b

    pipeline, transformer_name = _resolve_pipeline(args)

    # ── Stage 1: character A (generate + capture latent) ───────────────────
    print(f"\n=== Stage 1/3: generate character A (seed={args.seed_a}, return latent) ===")
    res_a = pipeline.generate(
        prompt=prompt_a_full, width=width, height=height, steps=steps,
        seed=args.seed_a, cfg_scale=cfg_scale, return_latent=True,
    )
    char_a_path = os.path.join(cfg.OUTPUT_DIR, f"multicouple_a-s{args.seed_a}.png")
    res_a.image.save(char_a_path)
    print(f"Saved: {char_a_path}")
    if res_a.latent is None:
        print("ERROR [multicouple]: Stage 1 did not return a latent.", file=sys.stderr)
        sys.exit(1)

    # ── Stage 2: character B (generate + capture latent) ───────────────────
    print(f"\n=== Stage 2/3: generate character B (seed={args.seed_b}, return latent) ===")
    res_b = pipeline.generate(
        prompt=prompt_b_full, width=width, height=height, steps=steps,
        seed=args.seed_b, cfg_scale=cfg_scale, return_latent=True,
    )
    char_b_path = os.path.join(cfg.OUTPUT_DIR, f"multicouple_b-s{args.seed_b}.png")
    res_b.image.save(char_b_path)
    print(f"Saved: {char_b_path}")
    if res_b.latent is None:
        print("ERROR [multicouple]: Stage 2 did not return a latent.", file=sys.stderr)
        sys.exit(1)

    # ── Stage 3: latent composite + resume denoise (the Latent-Couple step) ─
    print(f"\n=== Stage 3/3: latent composite (feather={args.merge_feather} cols) "
          f"+ resume denoise ({args.merge_denoise}) ===")
    merged = composite_latents_side_by_side(res_a.latent, res_b.latent, args.merge_feather)
    _, _, m_h, m_w = merged.shape
    print(f"[Latent-Couple] merged latent {list(merged.shape)} → {m_w * 8}×{m_h * 8}px")

    res_f = pipeline.generate(
        prompt=merge_prompt, init_latent=merged,
        denoise_strength=args.merge_denoise, steps=steps,
        seed=args.merge_seed, cfg_scale=cfg_scale,
    )

    label = (f"multicouple_dn{args.merge_denoise}_f{args.merge_feather}_"
             f"{steps}st-s{args.merge_seed}")
    final_path = os.path.join(cfg.OUTPUT_DIR, f"{label}.png")
    res_f.image.save(final_path)
    print(f"Saved: {final_path}")

    # run.json meta (plain dict — mirrors image-i2i's run_config=None pattern).
    run_path = os.path.join(cfg.OUTPUT_DIR, f"{label}.run.json")
    with open(run_path, "w") as f:
        json.dump({
            "command": "image multicouple",
            "technique": "latent-couple (latent-space composite + resume denoise)",
            "transformer": transformer_name or "moody-pro-mix",
            "width": m_w * 8, "height": m_h * 8, "steps": steps,
            "cfg_scale": cfg_scale,
            "charA": {"seed": args.seed_a, "prompt": prompt_a_full, "image": char_a_path},
            "charB": {"seed": args.seed_b, "prompt": prompt_b_full, "image": char_b_path},
            "merge": {
                "seed": args.merge_seed, "denoise": args.merge_denoise,
                "feather": args.merge_feather, "prompt": merge_prompt,
            },
            "final_image": final_path,
        }, f, indent=2, ensure_ascii=False)
    print(f"Run config: {run_path}")

    if getattr(args, "json_summary", False):
        summary = json.dumps({
            "status": "success",
            "outputs": [char_a_path, char_b_path, final_path],
            "final": final_path,
            "run_json": run_path,
        })
        print(f"JSON_SUMMARY:{summary}")
