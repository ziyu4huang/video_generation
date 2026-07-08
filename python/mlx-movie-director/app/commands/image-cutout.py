"""image-cutout — transparent-background cutout via SAM3 text segmentation (OM gap G + F).

OpenMontage demands a transparent-background / alpha-channel cutout ("bg-cut",
"transparent parts") as a must-have, but run.py had NO such primitive. This
fills the gap by reusing the SAM3 text-prompted segmentation we already ship
(``app/sam3_predictor.py``, the same machinery as ``image swap``) to isolate a
subject, then alpha-compositing the ORIGINAL pixels onto a transparent RGBA
canvas. The subject is preserved verbatim (no regeneration, no model in the
compositing loop); only the background becomes transparent.

MECHANISM (pure numpy/PIL, no T2I pipeline):
  1. Load source RGB.
  2. SAM3 text-prompted segmentation → best binary mask of ``--subject``.
  3. (optional) fill interior holes so the body isn't translucent.
  4. Feather the mask edge (Gaussian) for a smooth alpha boundary.
  5. ``alpha_cutout()``: stack [RGB, alpha] → RGBA PNG.
  6. (optional) ``--trim`` crop to the alpha bbox + padding (drop empty margins).

This is the LOCAL path (constraint 1: never cloud). It unlocks OM's transparent
parts (F), speaker cutouts, thumbnails, and compositing — the single highest-
leverage unmet must-have. Character-sheet (Step 3) composes this per view.

Imported by app.commands.image via importlib (hyphen in filename prevents a
regular import statement).

Public API:
  alpha_cutout(rgb, alpha_mask)  — pure RGBA-compositing core (pytest target)
  add_cutout_args(parser)        — register cutout-specific CLI arguments
  run_cutout(args)               — execute cutout
"""
import argparse
import os
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image

from app import config as cfg
from app.commands._shared import generate_base_name


# ---------------------------------------------------------------------------
# Pure core — alpha compositing (no SAM3, no GPU; the pytest target)
# ---------------------------------------------------------------------------

def alpha_cutout(
    rgb: Image.Image,
    alpha_mask: np.ndarray,
) -> Image.Image:
    """Composite ``rgb`` onto a transparent canvas using ``alpha_mask``.

    Args:
        rgb: Source PIL image (any mode; converted to RGB).
        alpha_mask: Float mask (H, W) in [0, 1] — 1 fully opaque, 0 fully
            transparent. Intermediate values give a feathered edge. Its shape
            must match the RGB image's (H, W).

    Returns:
        RGBA PIL image (same H×W as ``rgb``); background pixels carry alpha 0,
        subject-core pixels carry alpha 255.
    """
    rgb_arr = np.asarray(rgb.convert("RGB"), dtype=np.uint8)
    H, W = rgb_arr.shape[:2]
    if alpha_mask.shape != (H, W):
        raise ValueError(
            f"alpha_mask shape {alpha_mask.shape} != rgb (H,W) {(H, W)}"
        )
    a = np.clip(alpha_mask.astype(np.float32), 0.0, 1.0)
    alpha_u8 = np.round(a * 255.0).astype(np.uint8)
    rgba = np.dstack([rgb_arr, alpha_u8])
    return Image.fromarray(rgba, mode="RGBA")


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    """Fill interior holes in a binary mask (uint8 0/1) so the body is opaque.

    Uses scipy.ndimage.binary_fill_holes. A subject mask often has thin gaps
    (e.g. between arm and torso) that would render as transparent slits; filling
    them yields a clean solid cutout.
    """
    from scipy.ndimage import binary_fill_holes

    filled = binary_fill_holes(mask > 0)
    return filled.astype(np.uint8)


def _trim_to_alpha(rgba: Image.Image, padding: float = 0.05) -> Image.Image:
    """Crop an RGBA image to the bounding box of its non-transparent pixels.

    Args:
        rgba: RGBA PIL image.
        padding: Fraction of the bbox side to retain as margin (0.05 = 5%).
    """
    alpha = np.asarray(rgba, dtype=np.uint8)
    if alpha.ndim != 3 or alpha.shape[2] < 4:
        return rgba
    a = alpha[:, :, 3]
    rows = np.any(a > 0, axis=1)
    cols = np.any(a > 0, axis=0)
    if not rows.any():
        return rgba
    H, W = a.shape
    y_min, y_max = np.where(rows)[0][[0, -1]]
    x_min, x_max = np.where(cols)[0][[0, -1]]
    bw = x_max - x_min + 1
    bh = y_max - y_min + 1
    px = int(max(bw, bh) * padding)
    x_min = max(0, x_min - px)
    y_min = max(0, y_min - px)
    x_max = min(W - 1, x_max + px)
    y_max = min(H - 1, y_max + px)
    return rgba.crop((x_min, y_min, x_max + 1, y_max + 1))


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Transparent-background cutout: SAM3 text segment → alpha PNG",
    "description": (
        "Cut a subject out of its background onto a transparent canvas.\n\n"
        "SAM3 text-prompted segmentation isolates --subject; the original pixels\n"
        "are alpha-composited (feathered) onto RGBA. No regeneration — the\n"
        "subject is preserved verbatim, only the background becomes transparent.\n\n"
        "Closes OpenMontage gap G (transparent-bg) + F (transparent parts).\n\n"
        "Examples:\n"
        "  run.py image cutout --input portrait.png --subject 'woman'\n"
        "  run.py image cutout --input char.png --subject 'the detective' --trim\n"
        "  run.py image cutout --input hero.png --subject 'person' --fill-holes --feather 6\n"
        "  run.py image cutout --input photo.png --subject 'bottle' --save-mask\n\n"
        "  # Self-test (synthetic source → real SAM3 segment → alpha cert)\n"
        "  run.py image cutout --self-test\n"
    ),
}


def _option_registered(parser: "argparse.ArgumentParser", option: str) -> bool:
    """True if `option` (e.g. '--subject') is already on the parser."""
    for act in parser._actions:  # noqa: SLF001 — argparse has no public registry API
        if option in act.option_strings:
            return True
    return False


def add_cutout_args(parser: "argparse.ArgumentParser") -> None:
    """Register cutout-specific arguments.

    Common args (--input→input_image, --prompt, --seed, --self-test) are added
    by add_common_generation_args. ``--subject`` is the SAM3 text prompt; if
    omitted, ``--prompt`` is used as a fallback so a single --prompt suffices.
    """
    if not _option_registered(parser, "--subject"):
        parser.add_argument(
            "--subject", type=str, default=None,
            help="Text prompt for SAM3 segmentation (e.g. 'woman', 'the detective', "
                 "'coffee cup'). Required (except --self-test). Falls back to --prompt.",
        )
    if not _option_registered(parser, "--sam-threshold"):
        parser.add_argument(
            "--sam-threshold", type=float, default=0.3,
            help="SAM3 detection score threshold (default: 0.3).",
        )
    if not _option_registered(parser, "--feather"):
        parser.add_argument(
            "--feather", type=int, default=10,
            help="Mask edge feathering radius in pixels (default: 10, 0 = hard edge).",
        )
    if not _option_registered(parser, "--fill-holes"):
        parser.add_argument(
            "--fill-holes", action="store_true", default=False,
            help="Fill interior holes in the mask (scipy binary_fill_holes) so the "
                 "subject renders solid — closes gaps between arm/torso, etc.",
        )
    if not _option_registered(parser, "--trim"):
        parser.add_argument(
            "--trim", action="store_true", default=False,
            help="Crop the result to the alpha bbox + 5%% margin (drop empty margins).",
        )
    if not _option_registered(parser, "--save-mask"):
        parser.add_argument(
            "--save-mask", action="store_true", default=False,
            help="Save the SAM3 mask + overlay alongside the cutout for inspection.",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_cutout(args: "argparse.Namespace") -> dict[str, str] | None:
    """Execute cutout. Called by image.py dispatcher."""
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()

    # Self-test synthesizes its own source ---------------------------------
    if getattr(args, "self_test", None):
        src_path = _synth_source(cfg.OUTPUT_DIR, base)
        args.input_image = src_path
        args.subject = getattr(args, "subject", None) or "red balloon"
        if not getattr(args, "prompt", None):
            args.prompt = "red balloon"
        print(f"[cutout] self-test: src={src_path}", flush=True)

    # Resolve inputs -------------------------------------------------------
    input_path = getattr(args, "input_image", None)
    if not input_path:
        print("ERROR: --input (source image) is required for cutout.", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(input_path):
        print(f"ERROR: source image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    subject = getattr(args, "subject", None) or getattr(args, "prompt", None)
    if not subject:
        print("ERROR: --subject (SAM3 text prompt) is required for cutout.",
              file=sys.stderr)
        sys.exit(1)

    threshold = getattr(args, "sam_threshold", 0.3) or 0.3
    feather = max(0, getattr(args, "feather", 10) or 0)
    fill_holes = getattr(args, "fill_holes", False)
    do_trim = getattr(args, "trim", False)
    save_mask = getattr(args, "save_mask", False)

    with Image.open(input_path) as _im:
        source = _im.convert("RGB")
    W, H = source.size
    print(f"[cutout] Source: {input_path} ({W}x{H})", flush=True)
    print(f"[cutout] Subject: '{subject}'  threshold={threshold}  "
          f"feather={feather}  fill_holes={fill_holes}  trim={do_trim}", flush=True)

    # SAM3 segmentation ----------------------------------------------------
    from app.sam3_predictor import get_sam3_predictor, segment_image, feather_mask

    predictor = get_sam3_predictor(threshold=threshold)
    result = segment_image(predictor, source, subject, score_threshold=threshold)

    if len(result.scores) == 0:
        print(f"[cutout] No detections for '{subject}'. Try lowering --sam-threshold.",
              file=sys.stderr)
        sys.exit(2)

    best_idx = int(np.argmax(result.scores))
    mask = result.masks[best_idx]  # (H,W) uint8 0/1
    score = float(result.scores[best_idx])
    box = result.boxes[best_idx]
    print(f"[cutout] Best: score={score:.3f} "
          f"box=({box[0]:.0f},{box[1]:.0f},{box[2]:.0f},{box[3]:.0f})", flush=True)

    if save_mask:
        slug = subject.replace(" ", "_").replace("'", "")[:30]
        mask_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{slug}_mask.png")
        Image.fromarray(mask * 255).save(mask_path)
        overlay = np.array(source).copy()
        overlay[mask > 0] = (overlay[mask > 0] * 0.5 + np.array([0, 255, 0]) * 0.5).astype(np.uint8)
        ov_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{slug}_overlay.png")
        Image.fromarray(overlay).save(ov_path)
        print(f"[cutout] Saved mask: {mask_path}", flush=True)
        print(f"[cutout] Saved overlay: {ov_path}", flush=True)

    # Mask prep: optional hole fill + feather ------------------------------
    if fill_holes:
        mask = _fill_holes(mask)
        print(f"[cutout] Holes filled ({mask.sum()} px opaque)", flush=True)

    alpha = feather_mask(mask, radius=feather)  # float32 [0,1]

    rgba = alpha_cutout(source, alpha)
    if do_trim:
        rgba = _trim_to_alpha(rgba, padding=0.05)

    # Save -----------------------------------------------------------------
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_cutout_{ts}.png")
    rgba.save(out_path)  # PNG preserves the alpha channel
    print(f"\n[cutout] Saved: {out_path}", flush=True)

    # Self-test assertion: background corners alpha=0, subject core alpha=255.
    if getattr(args, "self_test", None):
        _assert_self_test(rgba, mask)

    # Manifest sentinel so adapters (mlx:runpy-image) can find the artifact.
    print(f"Manifest:   {out_path}")
    return {"cutout": out_path}


# ---------------------------------------------------------------------------
# Self-test (synthetic source; certifies the cutout contract end-to-end)
# ---------------------------------------------------------------------------

def _synth_source(out_dir: str, base: str) -> str:
    """A synthetic source (sky gradient + a red 'balloon') to segment.

    Deterministic. The cutout's SAM3 MODEL runs on it; the assertion checks the
    alpha channel (background transparent, balloon region opaque).
    """
    w, h = 640, 480
    grad = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        t = y / max(1, h - 1)
        grad[y, :, 0] = int(135 * (1 - t) + 200 * t)
        grad[y, :, 1] = int(206 * (1 - t) + 230 * t)
        grad[y, :, 2] = int(235 * (1 - t) + 255 * t)
    src = Image.fromarray(grad, mode="RGB")
    from PIL import ImageDraw
    draw = ImageDraw.Draw(src)
    cx, cy, r = int(w * 0.5), int(h * 0.5), 90
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 40, 40))
    path = os.path.join(out_dir, f"{base}_cutout_src.png")
    src.save(path)
    return path


def _assert_self_test(rgba: Image.Image, mask: np.ndarray) -> None:
    """Certify: corners alpha=0, mask-core region alpha high (>200)."""
    arr = np.asarray(rgba, dtype=np.uint8)
    H, W = arr.shape[:2]
    corners = [arr[0, 0, 3], arr[0, W - 1, 3], arr[H - 1, 0, 3], arr[H - 1, W - 1, 3]]
    print(f"[cutout] self-test: corner alphas = {corners} (expect ~0)", flush=True)
    if max(int(c) for c in corners) > 30:
        print("[cutout] self-test WARN: a background corner is not transparent.",
              file=sys.stderr)
    core = (mask > 0)
    if core.any():
        core_alpha = arr[core, 3]
        print(f"[cutout] self-test: subject-core mean alpha = "
              f"{float(core_alpha.mean()):.1f} (expect >200)", flush=True)
        if float(core_alpha.mean()) < 180.0:
            print("[cutout] self-test FAIL: subject core is not opaque.",
                  file=sys.stderr)
