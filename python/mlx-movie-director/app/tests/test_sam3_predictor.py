"""CPU-pure unit tests for app/sam3_predictor.py.

Covers the pure numpy/PIL helpers (feather_mask, _crop_masked_object,
composite_images), the segment_image() wrapper (via a fake predictor), and the
get_sam3_predictor() singleton cache (via sys.modules stubs for the lazy
mlx_vlm imports). No MLX/GPU/network required.
"""

import sys
import types

import numpy as np
import pytest
from PIL import Image

from app import sam3_predictor as s


def _solid(r, g, b, size=(20, 20)):
    arr = np.full((*size, 3), [r, g, b], dtype=np.uint8)
    return Image.fromarray(arr)


def _center_block_mask(h, w, top, bottom, left, right):
    """Build an (h,w) uint8 mask that is 1 only inside [top:bottom, left:right]."""
    m = np.zeros((h, w), dtype=np.uint8)
    m[top:bottom, left:right] = 1
    return m


# ---------------------------------------------------------------------------
# feather_mask
# ---------------------------------------------------------------------------


class TestFeatherMask:
    def test_radius_le_zero_returns_float_mask_unchanged_values(self):
        m = np.zeros((10, 10), dtype=np.uint8)
        m[2:4, 2:4] = 1
        out = s.feather_mask(m, radius=0)
        assert out.dtype == np.float32
        assert out.shape == m.shape
        # values preserved as 0.0/1.0 floats
        assert float(out.max()) == pytest.approx(1.0)
        assert float(out.min()) == pytest.approx(0.0)
        assert float(out[3, 3]) == pytest.approx(1.0)

    def test_positive_radius_blurs_into_intermediate_range(self):
        m = _center_block_mask(12, 12, 4, 8, 4, 8)
        out = s.feather_mask(m, radius=5)
        assert out.dtype == np.float32
        assert out.shape == m.shape
        # A Gaussian blur spreads the original 1.0 region into [0,1] floats,
        # so the global max must drop strictly below 1.0 and be > 0.
        assert 0.0 < float(out.max()) < 1.0


# ---------------------------------------------------------------------------
# _crop_masked_object
# ---------------------------------------------------------------------------


class TestCropMaskedObject:
    def test_empty_mask_returns_whole_image_and_zero_offset(self):
        img = _solid(5, 5, 5, size=(20, 20))
        mask = np.zeros((20, 20), dtype=np.uint8)
        cropped, offset = s._crop_masked_object(img, mask, padding=0.5)
        assert offset == (0, 0)
        assert cropped.size == img.size

    def test_padded_crop_fits_bbox_plus_padding(self):
        img = _solid(0, 0, 0, size=(20, 20))
        # single-pixel-ish mask at [3:5, 3:5]
        mask = _center_block_mask(20, 20, 3, 5, 3, 5)
        cropped, offset = s._crop_masked_object(img, mask, padding=1.0)
        x0, y0 = offset
        w, h = cropped.size
        # bbox is 2x2, padding=1.0 adds 2 each side -> up to 6x6 (clamped at edges)
        assert w >= 2 and h >= 2
        # offset must land at or before the mask's top-left corner
        assert x0 <= 3 and y0 <= 3
        # crop window must fully contain the original mask bbox
        assert x0 + w >= 5 and y0 + h >= 5


# ---------------------------------------------------------------------------
# composite_images
# ---------------------------------------------------------------------------


class TestCompositeImages:
    def test_empty_mask_returns_source_unchanged(self):
        src = _solid(10, 10, 10, size=(20, 20))
        ref = _solid(200, 200, 200, size=(10, 10))
        mask = np.zeros((20, 20), dtype=np.uint8)
        out = s.composite_images(src, ref, mask, feather_radius=0)
        assert np.array_equal(np.array(out), np.array(src))

    def test_mismatched_mask_shape_is_resized_then_applied(self):
        # source is 40x40, mask is 20x20 -> resize branch must upscale mask
        src = _solid(10, 10, 10, size=(40, 40))
        ref = _solid(200, 200, 200, size=(10, 10))
        small_mask = _center_block_mask(20, 20, 4, 8, 4, 8)  # 4x4 block
        out = s.composite_images(src, ref, small_mask, feather_radius=0)
        assert out.size == src.size
        arr = np.array(out)
        # upscaled 4x4 block (at 2x) lands roughly at rows 8:16 cols 8:16
        assert arr[10, 10].tolist() == [200, 200, 200]
        assert arr[0, 0].tolist() == [10, 10, 10]

    def test_legacy_stretch_path_pastes_reference_into_box(self):
        src = _solid(10, 10, 10, size=(20, 20))
        ref = _solid(200, 200, 200, size=(10, 10))
        mask = _center_block_mask(20, 20, 5, 10, 5, 10)  # 5x5 box
        out = s.composite_images(src, ref, mask, feather_radius=0)
        assert out.size == src.size
        arr = np.array(out)
        assert arr[7, 7].tolist() == [200, 200, 200]
        assert arr[0, 0].tolist() == [10, 10, 10]

    def test_ref_mask_crops_reference_before_composite(self):
        src = _solid(10, 10, 10, size=(30, 30))
        ref = _solid(200, 200, 200, size=(20, 20))
        ref_mask = _center_block_mask(20, 20, 5, 10, 5, 10)  # only inner 5x5
        mask = _center_block_mask(30, 30, 10, 20, 10, 20)
        out = s.composite_images(src, ref, mask, feather_radius=0, ref_mask=ref_mask)
        assert out.size == src.size
        arr = np.array(out)
        assert arr[15, 15].tolist() == [200, 200, 200]
        assert arr[0, 0].tolist() == [10, 10, 10]

    def test_preserve_aspect_ratio_centers_without_stretching(self):
        src = _solid(10, 10, 10, size=(20, 20))
        # tall reference (h=30, w=10) into a square 10x10 box must FIT, not stretch
        ref = _solid(250, 250, 250, size=(30, 10))
        mask = _center_block_mask(20, 20, 5, 15, 5, 15)  # 10x10 box
        out = s.composite_images(
            src, ref, mask, feather_radius=0, preserve_aspect_ratio=True
        )
        assert out.size == src.size
        arr = np.array(out)
        # scale = min(10/10, 10/30) = 1/3 -> new_w=3, new_h=10
        # centered: x_off=(10-3)//2=3, y_off=0 -> ref at rows5:15 cols8:11
        assert arr[10, 9].tolist() == [250, 250, 250]
        # left column of the box (col 5) should still be source (not stretched ref)
        assert arr[10, 6].tolist() == [10, 10, 10]
        # outside the box untouched
        assert arr[2, 2].tolist() == [10, 10, 10]


# ---------------------------------------------------------------------------
# segment_image — fake predictor, no MLX
# ---------------------------------------------------------------------------


class _FakeDetectionResult:
    def __init__(self, scores):
        self.scores = scores


class _FakePredictor:
    def __init__(self, scores):
        self._scores = scores
        self.last_call = None

    def predict(self, image, text_prompt=None, score_threshold=None):
        self.last_call = (text_prompt, score_threshold)
        return _FakeDetectionResult(self._scores)


class TestSegmentImage:
    def test_segment_image_forwards_args_and_returns_result(self):
        pred = _FakePredictor([0.9, 0.5])
        img = _solid(0, 0, 0, size=(8, 8))
        res = s.segment_image(pred, img, text_prompt="cat", score_threshold=0.4)
        assert list(res.scores) == [0.9, 0.5]
        assert pred.last_call == ("cat", 0.4)

    def test_segment_image_accepts_numpy_array_input(self):
        pred = _FakePredictor([0.2])
        arr = np.zeros((8, 8, 3), dtype=np.uint8)
        res = s.segment_image(pred, arr, text_prompt="dog")
        assert list(res.scores) == [0.2]


# ---------------------------------------------------------------------------
# get_sam3_predictor — singleton cache via lazy-import stubs
# ---------------------------------------------------------------------------


def _install_mlx_vlm_stubs():
    """Install fake mlx_vlm modules so get_sam3_predictor's lazy imports resolve."""
    for mod in [
        "mlx_vlm",
        "mlx_vlm.utils",
        "mlx_vlm.models",
        "mlx_vlm.models.sam3",
        "mlx_vlm.models.sam3.generate",
        "mlx_vlm.models.sam3_1",
        "mlx_vlm.models.sam3_1.processing_sam3_1",
    ]:
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)

    gen = sys.modules["mlx_vlm.models.sam3.generate"]

    class _StubPredictor:
        instances = []

        def __init__(self, model, processor, score_threshold=0.3):
            self.model = model
            self.processor = processor
            self.score_threshold = score_threshold
            _StubPredictor.instances.append(self)

    gen.Sam3Predictor = _StubPredictor

    proc_mod = sys.modules["mlx_vlm.models.sam3_1.processing_sam3_1"]

    class _StubProcessor:
        @classmethod
        def from_pretrained(cls, path):
            return ("stub-processor", path)

    proc_mod.Sam31Processor = _StubProcessor

    utils = sys.modules["mlx_vlm.utils"]
    utils.get_model_path = lambda mid: "/fake/" + mid
    utils.load_model = lambda mp: ("stub-model", mp)
    return _StubPredictor


@pytest.fixture
def reset_singleton():
    """Ensure the module-level _predictor is cleared around each singleton test."""
    prev = s._predictor
    s._predictor = None
    yield
    s._predictor = prev


class TestGetSam3Predictor:
    def test_singleton_caches_first_instance_and_ignores_later_threshold(
        self, reset_singleton
    ):
        stub_cls = _install_mlx_vlm_stubs()
        p1 = s.get_sam3_predictor(threshold=0.3)
        # second call with a different threshold must reuse the cached instance
        p2 = s.get_sam3_predictor(threshold=0.9)
        assert p1 is p2
        # only ONE underlying predictor was constructed
        assert len(stub_cls.instances) == 1
        # first-call threshold wins on the cached instance
        assert p1.score_threshold == 0.3
        # the stubbed model id path was threaded through
        assert p1.model[0] == "stub-model"
