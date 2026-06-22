#!/usr/bin/env python3
"""Pairwise A/B image diff: SSIM/PSNR/MAD metrics + an amplified diff heatmap.

Standalone one-shot spawned by the Bun gallery server's ``/api/gallery/ab-test``
endpoint::

    python app/ab_diff.py <imgA> <imgB> <out_heatmap_png>

Prints a JSON metrics object to stdout and writes a labeled 3-panel heatmap
(A | |A-B| x4 | B) to ``<out_heatmap_png>``.

Reuses :func:`app.quality_metrics.compute_frame_reference` for the canonical
PSNR+SSIM (the same full-reference metrics the video-quality path uses), so we
don't reinvent SSIM. MAD / pixel-divergence percentages are computed here.
"""
from __future__ import annotations

import json
import os
import sys

# Allow `python app/ab_diff.py …` (absolute path) to import the sibling app pkg.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont, ImageOps  # noqa: E402


def load_rgb(path: str) -> np.ndarray:
    """Load an image as an HxWx3 float32 RGB array in [0, 255]."""
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


def _to_bgr(rgb: np.ndarray) -> np.ndarray:
    return rgb[:, :, ::-1]


def compute_diff(img_a: np.ndarray, img_b: np.ndarray) -> dict:
    """Pairwise diff of two HxWx3 float32 RGB arrays.

    Returns ``{identical_size, ssim, psnr_db, mean_abs_diff_per255, pct_gt5,
    pct_gt20}``. When the images differ in size, only ``identical_size`` is
    meaningful and the rest are ``None``.
    """
    identical_size = img_a.shape == img_b.shape
    metrics: dict = {
        "identical_size": bool(identical_size),
        "ssim": None,
        "psnr_db": None,
        "mean_abs_diff_per255": None,
        "pct_gt5": None,
        "pct_gt20": None,
    }
    if not identical_size:
        return metrics

    diff = np.abs(img_a - img_b)
    per_pixel_max = diff.max(-1)  # 0..255, max over RGB channels
    metrics["mean_abs_diff_per255"] = round(float(diff.mean()), 4)
    metrics["pct_gt5"] = round(float((per_pixel_max > 5).mean() * 100), 2)
    metrics["pct_gt20"] = round(float((per_pixel_max > 20).mean() * 100), 2)

    # Canonical full-reference PSNR + SSIM (skimage structural_similarity +
    # cv2.PSNR) — same helper the video quality path uses.
    try:
        from app.quality_metrics import compute_frame_reference

        ref = compute_frame_reference(_to_bgr(img_a), _to_bgr(img_b))
        metrics["psnr_db"] = round(float(ref["psnr"]), 3)
        metrics["ssim"] = round(float(ref["ssim"]), 4)
    except Exception as exc:  # pragma: no cover - venv is expected to have cv2/skimage
        metrics["_ref_error"] = str(exc)
    return metrics


def _label_font() -> ImageFont.ImageFont:
    for cand in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(cand, 22)
        except OSError:
            continue
    return ImageFont.load_default()


def write_heatmap(img_a: np.ndarray, img_b: np.ndarray, out_path: str) -> None:
    """Write a 3-panel labeled heatmap (A | |A-B| x4 | B) to ``out_path``."""
    a = Image.fromarray(img_a.astype(np.uint8))
    b = Image.fromarray(img_b.astype(np.uint8))
    diff = np.abs(img_a - img_b).max(-1)
    amp = Image.fromarray(np.clip(diff * 4, 0, 255).astype(np.uint8))  # mode "L"
    heat = ImageOps.colorize(amp, black=(0, 0, 0), white=(255, 60, 60)).resize(a.size)

    w, h = a.size
    gap, bar = 16, 40
    canvas = Image.new("RGB", (w * 3 + gap * 2, h + bar), (20, 20, 22))
    canvas.paste(a, (0, bar))
    canvas.paste(heat, (w + gap, bar))
    canvas.paste(b, (w * 2 + gap * 2, bar))

    draw = ImageDraw.Draw(canvas)
    font = _label_font()
    draw.text((8, 8), "A", fill=(120, 200, 255), font=font)
    draw.text((w + gap + 8, 8), "|A - B| x4", fill=(255, 80, 80), font=font)
    draw.text((w * 2 + gap * 2 + 8, 8), "B", fill=(255, 180, 120), font=font)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    canvas.save(out_path)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        sys.stderr.write("usage: ab_diff.py <imgA> <imgB> <out_heatmap_png>\n")
        return 2
    _, path_a, path_b, out_heatmap = argv
    img_a = load_rgb(path_a)
    img_b = load_rgb(path_b)
    metrics = compute_diff(img_a, img_b)
    if metrics["identical_size"]:
        write_heatmap(img_a, img_b, out_heatmap)
    print(json.dumps(metrics))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
