"""CPU-pure unit tests for app/commands/image-cutout.py.

Covers the pure numpy/PIL compositing core (alpha_cutout, _trim_to_alpha,
_fill_holes) with deterministic fixture masks — no SAM3, no MLX, no GPU.
The end-to-end SAM3 path is exercised by `run.py image cutout --self-test`
under --run-gpu, not here.
"""
import importlib

import numpy as np
import pytest
from PIL import Image

# Hyphen in the module filename prevents a normal import; mirror image.py's
# importlib.import_module path used for every app/commands/image-* module.
c = importlib.import_module("app.commands.image-cutout")


def _rgb(r, g, b, size=(20, 20)):
    arr = np.full((*size, 3), [r, g, b], dtype=np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _block_alpha(h, w, top, bottom, left, right, value=1.0):
    """Float alpha mask (h,w) that is `value` inside the box, 0 elsewhere."""
    a = np.zeros((h, w), dtype=np.float32)
    a[top:bottom, left:right] = value
    return a


# ---------------------------------------------------------------------------
# alpha_cutout
# ---------------------------------------------------------------------------


class TestAlphaCutout:
    def test_output_is_rgba_same_shape_as_input(self):
        rgb = _rgb(10, 20, 30, size=(24, 16))
        alpha = _block_alpha(24, 16, 4, 20, 4, 12)
        out = c.alpha_cutout(rgb, alpha)
        assert out.mode == "RGBA"
        assert out.size == rgb.size  # (W, H)
        arr = np.asarray(out)
        assert arr.shape == (24, 16, 4)

    def test_background_pixels_are_fully_transparent(self):
        rgb = _rgb(10, 20, 30, size=(20, 20))
        alpha = _block_alpha(20, 20, 5, 15, 5, 15)  # inner 10x10 opaque
        out = c.alpha_cutout(rgb, alpha)
        arr = np.asarray(out)
        # the four corners are background → alpha 0
        for (y, x) in [(0, 0), (0, 19), (19, 0), (19, 19)]:
            assert int(arr[y, x, 3]) == 0
        # but RGB still preserved in the transparent pixels
        assert arr[0, 0, 0] == 10 and arr[0, 0, 1] == 20 and arr[0, 0, 2] == 30

    def test_subject_core_is_fully_opaque_and_preserves_rgb(self):
        rgb = _rgb(200, 100, 50, size=(20, 20))
        alpha = _block_alpha(20, 20, 5, 15, 5, 15)
        out = c.alpha_cutout(rgb, alpha)
        arr = np.asarray(out)
        # deep interior (away from the feathered boundary)
        assert int(arr[10, 10, 3]) == 255
        assert arr[10, 10, 0] == 200 and arr[10, 10, 1] == 100 and arr[10, 10, 2] == 50

    def test_intermediate_alpha_feathers_smoothly(self):
        rgb = _rgb(0, 0, 0, size=(20, 20))
        # a ramp alpha 0..255 across the width
        ramp = np.tile(np.linspace(0, 1, 20, dtype=np.float32), (20, 1))
        out = c.alpha_cutout(rgb, ramp)
        arr = np.asarray(out)
        # left edge transparent, right edge opaque, monotonic-ish increase
        assert int(arr[10, 0, 3]) == 0
        assert int(arr[10, 19, 3]) == 255
        assert int(arr[10, 10, 3]) > int(arr[10, 5, 3])

    def test_alpha_clamped_outside_unit_range(self):
        rgb = _rgb(0, 0, 0, size=(8, 8))
        over = np.full((8, 8), 5.0, dtype=np.float32)
        under = np.full((8, 8), -2.0, dtype=np.float32)
        assert int(np.asarray(c.alpha_cutout(rgb, over))[0, 0, 3]) == 255
        assert int(np.asarray(c.alpha_cutout(rgb, under))[0, 0, 3]) == 0

    def test_shape_mismatch_raises(self):
        rgb = _rgb(0, 0, 0, size=(10, 10))
        bad = np.zeros((8, 8), dtype=np.float32)
        with pytest.raises(ValueError):
            c.alpha_cutout(rgb, bad)


# ---------------------------------------------------------------------------
# _trim_to_alpha
# ---------------------------------------------------------------------------


class TestTrimToAlpha:
    def test_trims_to_opaque_bbox_plus_margin(self):
        rgba_arr = np.zeros((40, 40, 4), dtype=np.uint8)
        # opaque 10x10 block centered-ish at rows 10:20, cols 12:22
        rgba_arr[10:20, 12:22, :] = [255, 0, 0, 255]
        rgba = Image.fromarray(rgba_arr, mode="RGBA")
        out = c._trim_to_alpha(rgba, padding=0.0)
        ow, oh = out.size
        # result must be no larger than the source and contain the opaque block
        assert ow <= 40 and oh <= 40
        out_arr = np.asarray(out)
        # every output pixel in the trimmed frame that is opaque is red
        opaque = out_arr[:, :, 3] > 0
        assert opaque.any()
        assert np.all(out_arr[opaque, 0] == 255)

    def test_empty_alpha_returns_image_unchanged(self):
        rgba_arr = np.zeros((20, 20, 4), dtype=np.uint8)
        rgba = Image.fromarray(rgba_arr, mode="RGBA")
        out = c._trim_to_alpha(rgba)
        assert out.size == rgba.size


# ---------------------------------------------------------------------------
# _fill_holes
# ---------------------------------------------------------------------------


class TestFillHoles:
    def test_fills_an_interior_hole(self):
        # a ring mask: 1 everywhere in a 9x9 block except the 3x3 center
        m = np.ones((9, 9), dtype=np.uint8)
        m[3:6, 3:6] = 0
        filled = c._fill_holes(m)
        # the previously-empty center is now 1
        assert filled[4, 4] == 1
        assert filled.sum() == 81  # fully solid now

    def test_does_not_touch_solid_mask(self):
        m = np.ones((6, 6), dtype=np.uint8)
        filled = c._fill_holes(m)
        assert np.array_equal(filled, m)
