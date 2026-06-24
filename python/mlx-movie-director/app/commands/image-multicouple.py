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

import numpy as np
from PIL import Image

from app import config as cfg

# Z-Image CFG is the single biggest quality lever (zimage-cfg-wired-biggest-
# quality-lever): ~3.0 jumps overall 4→6. Default ON for every multicouple pass
# (A, B, and the resume). Caller can override/disable via the shared --cfg-scale.
_DEFAULT_CFG = 3.0
_DEFAULT_MERGE_DENOISE = 0.6  # resume strength: 0.5–0.7 = enough freedom to repaint
# the two backgrounds into one, while the merged latent holds structure. Higher
# (0.7) unifies the background harder at the cost of more character drift.
_DEFAULT_MERGE_DENOISE_LOCKED = 0.8  # when --lock-chars: characters are pinned by
# the Repaint mask, so the background can be denoised HARD (full tone unify) with
# zero character drift. 0.8 fully repaints the background into one tone.
_DEFAULT_FEATHER = 8  # latent cols (image px = ×8 = 64px feather band)
_DEFAULT_SAM_PROMPT = "the woman"  # SAM3 text prompt — each char image has one subject
_DEFAULT_MASK_DILATE = 4  # px; expand the char mask slightly so the feather edge
# of each character is locked (no char-edge bleed into the repainted background)
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
        "--merge-denoise", type=float, default=None, metavar="0..1",
        help="Resume denoise strength. Sentinel default (None): "
             f"{_DEFAULT_MERGE_DENOISE} normally, {_DEFAULT_MERGE_DENOISE_LOCKED} when "
             "--lock-chars (characters are pinned, so the background repaints harder). "
             "Set explicitly to override either.",
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
    parser.add_argument(
        "--lock-chars", action="store_true", default=False,
        help="MASKED variant: SAM3-segment each character, build a latent mask, and "
             "Repaint-pin the character region every step so the background can be "
             "denoised HARD (merge-denoise auto-bumps to "
             f"{_DEFAULT_MERGE_DENOISE_LOCKED}) with ZERO character drift — kills the "
             "residual cool→warm background shift the plain resume leaves. Needs SAM3. "
             "Reuses the shared --sam-prompt (default 'the woman' for this command).",
    )
    parser.add_argument(
        "--lock-dilate", type=int, default=_DEFAULT_MASK_DILATE, metavar="PX",
        help=f"Dilate each character mask by N px before locking (default {_DEFAULT_MASK_DILATE}) "
             "so the character's feather edge is pinned (no char-edge bleed into the "
             "repainted background). 0 = exact SAM3 mask. (Named --lock-dilate to avoid "
             "colliding with swap's shared --mask-dilate.)",
    )
    parser.add_argument(
        "--color-match", action=argparse.BooleanOptionalAction, default=True,
        help="COLOR-MATCH variant (DEFAULT ON): SAM3-segment each character, measure "
             "each image's BACKGROUND color temperature, and shift both images so their "
             "bg means land on a shared midpoint, then re-encode. This is the actual fix "
             "for the cool-left/warm-right background split (which --lock-chars provably "
             "cannot fix): the split is each character generated in its own "
             "color-temperature world, baked into the latent. Use --no-color-match to "
             "disable. Reuses the same SAM3 segmentation as --lock-chars.",
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


def _union_sam3_masks(result) -> "np.ndarray | None":
    """Union all detected masks in a SAM3 DetectionResult → (H, W) float [0,1].

    Returns None if there were no detections (caller falls back to no-mask).
    """
    masks = getattr(result, "masks", None)
    if masks is None or len(masks) == 0:
        return None
    union = np.zeros(masks.shape[1:], dtype=np.float32)
    for m in masks:
        union = np.maximum(union, m.astype(np.float32))
    return union


def _dilate_mask(mask_px: "np.ndarray", dilate_px: int) -> "np.ndarray":
    """Expand the locked region by `dilate_px` via a max (dilation) filter.

    Keeps the character's feather edge inside the lock so the repainted
    background does not bleed across the silhouette boundary.
    """
    if dilate_px <= 0:
        return mask_px
    from PIL import ImageFilter
    # MaxFilter size must be odd; ~2*dilate_px+1 covers a `dilate_px` radius.
    size = max(3, (int(dilate_px) * 2) + 1)
    pil = Image.fromarray((mask_px * 255).clip(0, 255).astype(np.uint8), mode="L")
    dilated = pil.filter(ImageFilter.MaxFilter(size))
    return np.array(dilated).astype(np.float32) / 255.0


def _downsample_mask_to_latent(mask_px: "np.ndarray", h_lat: int, w_lat: int) -> "np.ndarray":
    """Mean-pool a pixel mask (H_lat*8, W_lat*8) down to the latent grid (h_lat, w_lat).

    Mean-pooling yields a soft [0,1] mask at latent resolution (partial blocks at
    the silhouette become fractional), which gives a feathered lock boundary.
    """
    h, w = mask_px.shape
    if (h, w) != (h_lat * 8, w_lat * 8):
        # Defensive: crop/pad-independent path — resize via nearest then pool.
        mask_px = np.array(
            Image.fromarray((mask_px * 255).clip(0, 255).astype(np.uint8))
            .resize((w_lat * 8, h_lat * 8), Image.NEAREST)
        ).astype(np.float32) / 255.0
    return mask_px.reshape(h_lat, 8, w_lat, 8).mean(axis=(1, 3))


def segment_char_pixel_masks(
    img_a: "Image.Image",
    img_b: "Image.Image",
    sam_prompt: str,
    mask_dilate: int,
):
    """SAM3-segment the subject in each character image -> two (H, W) float masks.

    Single SAM3 load (singleton) shared by both the Repaint lock-mask and the
    color-temperature match. Returns (mask_a_px, mask_b_px); either is None if
    SAM3 found no subject in that image (caller falls back gracefully).
    """
    from app.sam3_predictor import get_sam3_predictor, segment_image

    print("[Char-Mask] Loading SAM3 + segmenting both characters...", flush=True)
    predictor = get_sam3_predictor(threshold=0.3)
    res_a = segment_image(predictor, img_a, text_prompt=sam_prompt)
    res_b = segment_image(predictor, img_b, text_prompt=sam_prompt)
    mask_a = _union_sam3_masks(res_a)
    mask_b = _union_sam3_masks(res_b)
    if mask_a is None or mask_b is None:
        missing = "A" if mask_a is None else "B"
        print(f"[Char-Mask] WARNING: SAM3 found no '{sam_prompt}' in character {missing} "
              f"(scores A={list(getattr(res_a,'scores',[]) or [])}, "
              f"B={list(getattr(res_b,'scores',[]) or [])}); segmentation unavailable.",
              file=sys.stderr)
        return None, None
    mask_a = _dilate_mask(mask_a.astype(np.float32), mask_dilate)
    mask_b = _dilate_mask(mask_b.astype(np.float32), mask_dilate)
    return mask_a, mask_b


def color_match_to_shared_temperature(
    img_a: "Image.Image",
    img_b: "Image.Image",
    mask_a_px: "np.ndarray",
    mask_b_px: "np.ndarray",
):
    """Equalize the two characters' BACKGROUND color temperature.

    The cool-left / warm-right split is not a compositing seam -- it is each
    character generated in its own color-temperature world (cool for the
    black/white/pale subject, warm for the orange/green/tan subject), baked into
    the latent and propagated into the background by the resume's self-attention.
    Locking characters (Repaint) cannot fix it; the only lever is to make both
    worlds share one temperature BEFORE compositing.

    Measures each image's BACKGROUND per-channel mean (background = NOT the
    subject mask) and shifts each WHOLE image so its bg mean lands on the shared
    midpoint. A full-image shift (measured on bg) moves each character's entire
    world-temperature toward the common target -- the ambient unification the
    resume needs. Returns (matched_a, matched_b, info_dict).
    """
    a = np.array(img_a.convert("RGB")).astype(np.float32)
    b = np.array(img_b.convert("RGB")).astype(np.float32)
    bg_a = (1.0 - mask_a_px) > 0.5     # background = everything NOT the subject
    bg_b = (1.0 - mask_b_px) > 0.5
    ma = a[bg_a].mean(axis=0) if bg_a.any() else a.reshape(-1, 3).mean(axis=0)
    mb = b[bg_b].mean(axis=0) if bg_b.any() else b.reshape(-1, 3).mean(axis=0)
    target = (ma + mb) / 2.0
    a_matched = np.clip(a + (target - ma), 0, 255).astype(np.uint8)
    b_matched = np.clip(b + (target - mb), 0, 255).astype(np.uint8)
    info = {
        "target_bg_mean": [round(float(v), 1) for v in target],
        "a_bg_mean": [round(float(v), 1) for v in ma],
        "b_bg_mean": [round(float(v), 1) for v in mb],
        "a_shift": [round(float(v), 1) for v in (target - ma)],
        "b_shift": [round(float(v), 1) for v in (target - mb)],
    }
    print(f"[Color-Match] bg means A={info['a_bg_mean']} B={info['b_bg_mean']} "
          f"-> target {info['target_bg_mean']} "
          f"(A d={info['a_shift']} B d={info['b_shift']})", flush=True)
    return Image.fromarray(a_matched), Image.fromarray(b_matched), info


def build_char_mask_latent(
    mask_a_px: "np.ndarray",
    mask_b_px: "np.ndarray",
    h_px: int,
    w_px: int,
    feather_cols: int,
):
    """Build the composite character mask on the merged LATENT grid.

    Geometry mirrors composite_latents_side_by_side: charA latent occupies latent
    cols [0:W_lat], charB occupies [W_lat−o:out_W_lat], unioned in the feather
    overlap. Takes pre-segmented pixel masks (see segment_char_pixel_masks).
    Returns (mx.array (1,1,H_lat,out_W_lat) bfloat16, locked_frac).
    """
    import mlx.core as mx

    h_lat, w_lat = h_px // 8, w_px // 8
    o = max(0, min(int(feather_cols), w_lat))
    out_w_lat = 2 * w_lat - o

    a_lat = _downsample_mask_to_latent(mask_a_px, h_lat, w_lat)
    b_lat = _downsample_mask_to_latent(mask_b_px, h_lat, w_lat)
    canvas = np.zeros((h_lat, out_w_lat), dtype=np.float32)
    canvas[:, 0:w_lat] = a_lat
    # Place charB over [w_lat-o:out_w_lat]; union with charA in the overlap band.
    canvas[:, w_lat - o:out_w_lat] = np.maximum(
        canvas[:, w_lat - o:out_w_lat], b_lat[:, 0:w_lat]
    )
    locked_frac = float(canvas.mean())
    print(f"[Char-Mask] merged mask {(1, 1, h_lat, out_w_lat)} "
          f"(locked {locked_frac*100:.1f}% of latent area)", flush=True)
    return mx.array(canvas)[None, None].astype(mx.bfloat16), locked_frac


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

    # --lock-chars (masked Repaint variant): SAM3 character masks pin the
    # characters so the background can be denoised hard with zero drift.
    lock_chars = bool(getattr(args, "lock_chars", False))
    # Sentinel denoise: respect an explicit --merge-denoise; else bump to the
    # hard-repaint value when locking, normal value otherwise (argparse-sentinel-
    # for-user-override — never magic-compare vs a concrete default).
    user_denoise = getattr(args, "merge_denoise", None)
    if user_denoise is not None:
        merge_denoise = user_denoise
    else:
        merge_denoise = _DEFAULT_MERGE_DENOISE_LOCKED if lock_chars else _DEFAULT_MERGE_DENOISE

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
    color_match = getattr(args, "color_match", True)
    sam_prompt = getattr(args, "sam_prompt", None) or _DEFAULT_SAM_PROMPT
    mask_dilate = getattr(args, "lock_dilate", _DEFAULT_MASK_DILATE)

    # SAM3 segmentation is shared by color-match (background region) and
    # lock-chars (the lock region). Run once; both features reuse the masks.
    mask_a_px = mask_b_px = None
    if color_match or lock_chars:
        mask_a_px, mask_b_px = segment_char_pixel_masks(
            res_a.image, res_b.image, sam_prompt, mask_dilate)

    # Source latents for the composite: the generated latents, UNLESS color-match
    # re-encodes temperature-unified versions (the actual fix for the cool/warm
    # background split -- which masking/Repaint provably could not solve).
    lat_a, lat_b = res_a.latent, res_b.latent
    color_info = None
    if color_match and mask_a_px is not None and mask_b_px is not None:
        print("\n=== Stage 2.5: color-temperature match (unify the two worlds) ===")
        m_a_img, m_b_img, color_info = color_match_to_shared_temperature(
            res_a.image, res_b.image, mask_a_px, mask_b_px)
        for name, img in ((f"multicouple_a-s{args.seed_a}_cm.png", m_a_img),
                          (f"multicouple_b-s{args.seed_b}_cm.png", m_b_img)):
            p = os.path.join(cfg.OUTPUT_DIR, name)
            img.save(p)
            print(f"Saved matched: {p}")
        # Re-encode the temperature-matched images to latents (pure VAE encode).
        lat_a = pipeline.vae_encode_image(m_a_img)
        lat_b = pipeline.vae_encode_image(m_b_img)
    elif color_match:
        print("[Color-Match] SAM3 unavailable -- skipping color match (raw latents).",
              file=sys.stderr)

    merged = composite_latents_side_by_side(lat_a, lat_b, args.merge_feather)
    _, _, m_h, m_w = merged.shape
    print(f"[Latent-Couple] merged latent {list(merged.shape)} → {m_w * 8}×{m_h * 8}px")

    # Optional character mask (Repaint): pin characters, repaint background hard.
    char_mask = None
    locked_frac = None
    effective_denoise = merge_denoise
    if lock_chars and mask_a_px is not None and mask_b_px is not None:
        char_mask, locked_frac = build_char_mask_latent(
            mask_a_px, mask_b_px, res_a.image.height, res_a.image.width,
            args.merge_feather)
    elif lock_chars:
        # SAM3 missed a character: cannot lock safely. If the user did NOT set
        # a denoise explicitly, drop back to the safe plain-resume value so we
        # don't run a hard 0.8 repaint with no lock (heavy drift).
        if user_denoise is None:
            effective_denoise = _DEFAULT_MERGE_DENOISE
            print(f"[Latent-Couple] mask fallback -> denoise reduced to "
                  f"{effective_denoise} (no lock).", flush=True)

    tag = ("_masked" if char_mask is not None else "") + ("_cm" if color_info else "")
    print(f"\n=== Stage 3/3: resume denoise {effective_denoise}"
          f"{' (Repaint lock, '+f'{locked_frac*100:.0f}% locked)' if char_mask is not None else ''} ===")
    res_f = pipeline.generate(
        prompt=merge_prompt, init_latent=merged,
        denoise_strength=effective_denoise, steps=steps,
        seed=args.merge_seed, cfg_scale=cfg_scale,
        mask=char_mask,
    )

    label = (f"multicouple{tag}_dn{effective_denoise}_f{args.merge_feather}_"
             f"{steps}st-s{args.merge_seed}")
    final_path = os.path.join(cfg.OUTPUT_DIR, f"{label}.png")
    res_f.image.save(final_path)
    print(f"Saved: {final_path}")

    # run.json meta (plain dict — mirrors image-i2i's run_config=None pattern).
    run_path = os.path.join(cfg.OUTPUT_DIR, f"{label}.run.json")
    with open(run_path, "w") as f:
        json.dump({
            "command": "image multicouple",
            "technique": ("latent-couple"
                          + (" + Repaint (masked character lock + hard bg repaint)" if char_mask is not None else "")
                          + (" + color-temperature match" if color_info else "")),
            "transformer": transformer_name or "moody-pro-mix",
            "width": m_w * 8, "height": m_h * 8, "steps": steps,
            "cfg_scale": cfg_scale,
            "charA": {"seed": args.seed_a, "prompt": prompt_a_full, "image": char_a_path},
            "charB": {"seed": args.seed_b, "prompt": prompt_b_full, "image": char_b_path},
            "merge": {
                "seed": args.merge_seed, "denoise": effective_denoise,
                "feather": args.merge_feather, "prompt": merge_prompt,
                "masked": char_mask is not None,
                "locked_frac": locked_frac,
                "sam_prompt": (getattr(args, "sam_prompt", None) if char_mask is not None else None),
                "lock_dilate": (getattr(args, "lock_dilate", None) if char_mask is not None else None),
                "color_match": bool(color_info),
                "color_match_info": color_info,
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
