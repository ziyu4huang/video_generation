"""Tests for image-controlnet preprocessors: scribble (built-in) + the honest
missing-preprocessor path for depth/pose/hed.

Loads the hyphenated module via importlib (the same pattern image.py uses).
No GPU / model weights required — pure classical-CV preprocessor tests.
"""

import importlib

import numpy as np
import pytest
from PIL import Image

try:
    HAS_CV2 = importlib.util.find_spec("cv2") is not None
except Exception:
    HAS_CV2 = False

ic = importlib.import_module("app.commands.image-controlnet")


def _structured_image(size: int = 160) -> Image.Image:
    """A synthetic image with clear edges (dark disc + bright bar) for CV tests."""
    yy, xx = np.mgrid[0:size, 0:size]
    base = np.full((size, size), 180, np.int32)
    base[(xx - size // 2) ** 2 + (yy - size // 2) ** 2 < (size // 3) ** 2] -= 160
    base[(yy > size * 0.44) & (yy < size * 0.56)] += 40
    arr = np.stack([base] * 3, -1).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr)


# ==========================================================================
# scribble preprocessor (built-in, classical CV)
# ==========================================================================

@pytest.mark.skipif(not HAS_CV2, reason="cv2 not available")
class TestApplyScribble:
    def test_returns_3channel_uint8(self):
        out = ic._apply_scribble(_structured_image())
        assert out.mode == "RGB"
        arr = np.array(out)
        assert arr.dtype == np.uint8
        assert arr.ndim == 3 and arr.shape[2] == 3

    def test_preserves_spatial_size(self):
        img = _structured_image(96)
        out = ic._apply_scribble(img)
        assert out.size == img.size  # PIL (W, H)

    def test_is_anti_aliased(self):
        """scribble is NOT binary — it has many intensity levels (the XDoG gradient)."""
        arr = np.array(ic._apply_scribble(_structured_image()).convert("L"))
        assert len(np.unique(arr)) > 16, (
            f"scribble should be anti-aliased (many levels), got {len(np.unique(arr))}"
        )

    def test_distinct_from_canny(self):
        """scribble and canny are genuinely different control signals (low IoU)."""
        img = _structured_image()
        canny = np.array(ic._apply_canny(img).convert("L"))
        scribble = np.array(ic._apply_scribble(img).convert("L"))
        cb = (canny > 127).astype(np.uint8)
        sb = (scribble > 40).astype(np.uint8)
        union = int((cb | sb).sum())
        assert union > 0
        iou = int((cb & sb).sum()) / union
        assert iou < 0.5, f"scribble too similar to canny (IoU={iou:.3f})"

    def test_captures_structure(self):
        """scribble lights up along edges (non-trivial signal, not all-black/white)."""
        arr = np.array(ic._apply_scribble(_structured_image()).convert("L"))
        frac_active = float((arr > 10).mean())
        assert 0.01 < frac_active < 0.6, f"unexpected active fraction {frac_active}"


# ==========================================================================
# missing-preprocessor path (depth / pose / hed) — honest exit 2
# ==========================================================================

@pytest.mark.parametrize("ctrl_type", ["depth", "pose", "hed"])
def test_missing_preprocessor_exits_2(ctrl_type):
    """depth/pose/hed must exit(2) with an actionable message, never silently fall back."""
    with pytest.raises(SystemExit) as exc:
        ic._raise_missing_preprocessor(ctrl_type)
    assert exc.value.code == 2


def test_missing_preprocessor_table_covers_three_types():
    """All three learned-preprocessor types are registered."""
    assert set(ic._MISSING_PREPROCESSORS.keys()) == {"depth", "pose", "hed"}
