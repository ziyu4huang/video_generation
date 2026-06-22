"""Tests for app/ab_diff.py — pairwise SSIM/PSNR/MAD metrics + heatmap writer.

All tests use synthetic arrays (no real image files), matching the
quality_metrics test style.
"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

# compute_diff's reference path needs cv2 + skimage; skip the SSIM/PSNR
# assertions if the venv lacks them (MAD/%pix still hold).
pytest.importorskip("cv2")
pytest.importorskip("skimage.metrics")

from app.ab_diff import compute_diff, write_heatmap, load_rgb  # noqa: E402


def _rgb(arr: np.ndarray) -> np.ndarray:
    """HxWx3 float32 RGB copy."""
    return np.asarray(arr, dtype=np.float32)


def test_identical_images_score_perfectly():
    a = _rgb(np.full((64, 64, 3), 128.0))
    m = compute_diff(a, a)
    assert m["identical_size"] is True
    assert m["mean_abs_diff_per255"] == 0.0
    assert m["pct_gt5"] == 0.0
    assert m["pct_gt20"] == 0.0
    assert m["ssim"] == pytest.approx(1.0, abs=1e-6)
    assert m["psnr_db"] >= 99.0  # cv2.PSNR caps identical at 100


def test_different_images_diverge():
    rng = np.random.default_rng(42)
    a = _rgb((rng.random((64, 64, 3)) * 255))
    b = _rgb((np.random.default_rng(7).random((64, 64, 3)) * 255))
    m = compute_diff(a, b)
    assert m["identical_size"] is True
    assert m["mean_abs_diff_per255"] > 50.0
    assert m["pct_gt20"] > 80.0
    assert m["ssim"] < 0.9
    assert m["psnr_db"] < 15.0


def test_near_identical_pair_is_close():
    rng = np.random.default_rng(1)
    base = (rng.random((48, 48, 3)) * 255).astype(np.float32)
    a = _rgb(base)
    b = _rgb(np.clip(base + rng.normal(0, 2, base.shape), 0, 255))  # tiny perturbation
    m = compute_diff(a, b)
    assert m["mean_abs_diff_per255"] < 3.0
    assert m["ssim"] > 0.95


def test_mismatched_sizes_return_nones():
    a = _rgb(np.full((32, 32, 3), 100.0))
    b = _rgb(np.full((64, 64, 3), 100.0))
    m = compute_diff(a, b)
    assert m["identical_size"] is False
    assert m["ssim"] is None
    assert m["mean_abs_diff_per255"] is None


def test_write_heatmap_creates_labeled_three_panel(tmp_path):
    a = (np.random.default_rng(2).random((40, 30, 3)) * 255).astype(np.float32)
    b = (np.random.default_rng(3).random((40, 30, 3)) * 255).astype(np.float32)
    out = tmp_path / "heat.png"
    write_heatmap(a, b, str(out))
    assert out.exists()
    img = Image.open(out)
    # width = 3 panels + 2 gaps; height = panel height + 40px label bar
    assert img.size == (30 * 3 + 16 * 2, 40 + 40)


def test_load_rgb_roundtrip(tmp_path):
    arr = (np.random.default_rng(5).random((20, 20, 3)) * 255).astype(np.uint8)
    p = tmp_path / "x.png"
    Image.fromarray(arr).save(p)
    loaded = load_rgb(str(p))
    assert loaded.shape == (20, 20, 3)
    assert loaded.dtype == np.float32
