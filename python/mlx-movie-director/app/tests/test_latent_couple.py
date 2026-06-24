"""CPU-only tests for the latent-couple multi-character path.

Covers two things that the ``image multicouple`` command relies on:

1. ``app.pipeline.composite_latents_side_by_side`` — the pure latent-space merge
   (Latent-Couple) used to join two character latents before the resume-denoise
   pass. Shape, feather, even-dim (patchify) invariant, and that the left/right
   halves really come from A/B.
2. ``GenerationResult.latent`` — the optional pre-decode latent field the
   command reads off Stage 1/2 to feed Stage 3.

No model load, no GPU. ``composite_latents_side_by_side`` is pure mlx array ops.
"""

import numpy as np
import pytest

try:
    import mlx.core as mx  # noqa: F401
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.pipeline import composite_latents_side_by_side
from app.pipeline_types import GenerationResult


class TestCompositeLatentsSideBySide:
    """The latent merge that the Latent-Couple resume pass starts from."""

    def _pair(self, w=80, h=120, c=16):
        # Distinct values so we can assert left=A / right=B by mean.
        a = mx.zeros((1, c, h, w))
        b = mx.ones((1, c, h, w)) * 5.0
        return a, b

    def test_shape_feather8(self):
        a, b = self._pair()
        out = composite_latents_side_by_side(a, b, 8)
        # 2*80 - 8 = 152 (even)
        assert list(out.shape) == [1, 16, 120, 152]

    def test_shape_hard_join_feather0(self):
        a, b = self._pair()
        out = composite_latents_side_by_side(a, b, 0)
        # no feather → 2*80 = 160
        assert list(out.shape) == [1, 16, 120, 160]

    def test_output_width_always_even(self):
        """Patchify needs even latent spatial dims; an odd feather must be shaved."""
        a, b = self._pair()
        # feather=7 → 2*80-7 = 153 (odd) → shaved to 152
        assert composite_latents_side_by_side(a, b, 7).shape[3] % 2 == 0
        # feather=9 → 160-9 = 151 (odd) → shaved to 150
        assert composite_latents_side_by_side(a, b, 9).shape[3] % 2 == 0

    def test_left_is_a_right_is_b(self):
        a, b = self._pair()
        out = np.array(composite_latents_side_by_side(a, b, 8).astype(mx.float32))
        # Far-left column ≈ A (0), far-right column ≈ B (5).
        assert abs(float(out[:, :, :, 0].mean()) - 0.0) < 0.05
        assert abs(float(out[:, :, :, -1].mean()) - 5.0) < 0.05

    def test_feather_band_is_a_blend(self):
        """The join band is neither pure A nor pure B — it is a gradient."""
        a, b = self._pair()
        out = np.array(composite_latents_side_by_side(a, b, 8).astype(mx.float32))
        # Band sits at [W-8, W) = [72, 80). Its midpoint should be ~midway (2.5).
        mid = float(out[:, :, :, 76].mean())
        assert 1.0 < mid < 4.0, f"join midpoint {mid} not a blend"

    def test_feather_clamped_to_width(self):
        """A feather larger than W must not crash — it is clamped."""
        a, b = self._pair(w=10)
        out = composite_latents_side_by_side(a, b, 999)
        # clamped to W=10 → 2*10-10 = 10 (even). Just must not raise + stay even.
        assert out.shape[3] >= 2
        assert out.shape[3] % 2 == 0

    def test_shape_mismatch_raises(self):
        a, _ = self._pair(w=80)
        b = mx.ones((1, 16, 120, 40))
        with pytest.raises(ValueError):
            composite_latents_side_by_side(a, b, 8)

    def test_dtype_preserved_bfloat16(self):
        a, b = self._pair()
        out = composite_latents_side_by_side(a, b, 8)
        assert out.dtype == mx.bfloat16


class TestGenerationResultLatentField:
    """The optional latent field multicouple reads after Stage 1/2."""

    def test_field_defaults_none(self):
        # Construct with the required args only; latent must default to None.
        from PIL import Image
        r = GenerationResult(image=Image.new("RGB", (8, 8)), timings={})
        assert r.latent is None

    def test_field_accepts_array(self):
        # Smoke: a dummy mx.array round-trips through the field (multicouple reads
        # result.latent.shape after Stage 1/2).
        from PIL import Image
        lat = mx.zeros((1, 16, 120, 80))
        r = GenerationResult(image=Image.new("RGB", (8, 8)), timings={}, latent=lat)
        assert r.latent is lat
        assert list(r.latent.shape) == [1, 16, 120, 80]


class TestCharMaskHelpers:
    """The masked (Repaint) variant's mask-building helpers — pure CPU/numpy.

    These build the latent character mask that locks characters while the
    background re-denoises hard. No SAM3 model, no GPU: SAM3 is mocked.
    """

    def _mc(self):
        # image-multicouple.py has a hyphen → must import via importlib (like image.py).
        import importlib
        return importlib.import_module("app.commands.image-multicouple")

    def test_union_sam3_masks_unions_via_max(self):
        mc = self._mc()

        class Res:
            masks = np.stack([
                np.pad(np.ones((4, 4)), ((0, 0), (0, 4))),       # 4x8, left block
                np.pad(np.ones((4, 4)), ((0, 0), (4, 0))),       # 4x8, right block
            ]).astype(np.uint8)
            scores = [0.9, 0.8]
        out = mc._union_sam3_masks(Res())
        assert out.shape == (4, 8)
        assert abs(float(out.mean()) - 1.0) < 1e-6  # left+right block = all ones

    def test_union_sam3_masks_none_when_empty(self):
        mc = self._mc()

        class Res:
            masks = np.zeros((0, 4, 4), dtype=np.uint8)
            scores = []
        assert mc._union_sam3_masks(Res()) is None

    def test_dilate_mask_expands_region(self):
        mc = self._mc()
        m = np.zeros((21, 21), dtype=np.float32)
        m[10, 10] = 1.0  # single point
        out = mc._dilate_mask(m, dilate_px=3)
        assert float(out.sum()) > float(m.sum())  # strictly larger locked area
        assert out[10, 10] >= 1.0 - 1e-6          # original pixel still locked

    def test_dilate_mask_zero_is_identity(self):
        mc = self._mc()
        m = np.zeros((8, 8), dtype=np.float32)
        m[2:5, 2:5] = 1.0
        out = mc._dilate_mask(m, dilate_px=0)
        assert np.array_equal(out, m)

    def test_downsample_mask_meanpools(self):
        mc = self._mc()
        # 8x8 pixel block → 1x1 latent; left-half ones, right-half zeros.
        m = np.zeros((8, 8), dtype=np.float32)
        m[:, 0:4] = 1.0
        out = mc._downsample_mask_to_latent(m, 1, 1)
        assert abs(float(out[0, 0]) - 0.5) < 1e-6  # mean of half-ones block

    def test_build_char_mask_geometry(self, monkeypatch):
        """Left subject → left latent cols locked; right subject → right cols locked.

        Mocks SAM3 so no model loads. Subjects occupy opposite pixel halves, so
        the merged mask locks the far-left and far-right, leaving the middle free
        (the background seam that gets hard-repainted).
        """
        from PIL import Image
        import app.sam3_predictor as sam3
        mc = self._mc()

        H_px, W_px = 960, 640
        calls = []

        def fake_segment(predictor, image, text_prompt, score_threshold=None):
            class Res:
                pass
            mask = np.zeros((H_px, W_px), dtype=np.uint8)
            if not calls:           # character A → left half
                mask[:, 0:W_px // 2] = 1
            else:                   # character B → right half
                mask[:, W_px // 2:] = 1
            calls.append(1)
            r = Res()
            r.masks = mask[None]
            r.scores = [0.95]
            return r

        monkeypatch.setattr(sam3, "get_sam3_predictor", lambda threshold=0.3: object())
        monkeypatch.setattr(sam3, "segment_image", fake_segment)

        img = Image.new("RGB", (W_px, H_px))
        mask_a_px, mask_b_px = mc.segment_char_pixel_masks(img, img, "x", 0)
        assert mask_a_px is not None and mask_b_px is not None
        mask_arr, locked_frac = mc.build_char_mask_latent(
            mask_a_px, mask_b_px, H_px, W_px, 8)
        # 2*80 - 8 = 152 latent cols; 960/8 = 120 rows.
        assert list(mask_arr.shape) == [1, 1, 120, 152]
        mlat = np.array(mask_arr.astype(mx.float32))[0, 0]
        assert abs(float(mlat[:, 0].mean()) - 1.0) < 1e-3    # far-left = char A locked
        assert abs(float(mlat[:, -1].mean()) - 1.0) < 1e-3   # far-right = char B locked
        # Middle of the canvas (~col 76) is background -> unlocked.
        assert float(mlat[:, 76].mean()) < 1e-3

    def test_build_char_mask_full_frame_all_locked(self, monkeypatch):
        """Two full-frame subjects → entire latent locked (frac ≈ 1)."""
        from PIL import Image
        import app.sam3_predictor as sam3
        mc = self._mc()

        def fake_segment(predictor, image, text_prompt, score_threshold=None):
            class Res:
                pass
            r = Res()
            r.masks = np.ones((960, 640), dtype=np.uint8)[None]
            r.scores = [0.95]
            return r

        monkeypatch.setattr(sam3, "get_sam3_predictor", lambda threshold=0.3: object())
        monkeypatch.setattr(sam3, "segment_image", fake_segment)

        img = Image.new("RGB", (640, 960))
        mask_a_px, mask_b_px = mc.segment_char_pixel_masks(img, img, "x", 0)
        mask_arr, locked_frac = mc.build_char_mask_latent(mask_a_px, mask_b_px, 960, 640, 8)
        assert locked_frac > 0.999
        assert mask_arr.dtype == mx.bfloat16

    def test_segment_returns_none_on_empty(self, monkeypatch):
        """SAM3 finding no subject → (None, None) so callers fall back gracefully."""
        from PIL import Image
        import app.sam3_predictor as sam3
        mc = self._mc()

        def fake_segment(predictor, image, text_prompt, score_threshold=None):
            class Res:
                masks = np.zeros((0, 8, 8), dtype=np.uint8)
                scores = []
            return Res

        monkeypatch.setattr(sam3, "get_sam3_predictor", lambda threshold=0.3: object())
        monkeypatch.setattr(sam3, "segment_image", fake_segment)
        img = Image.new("RGB", (640, 960))
        assert mc.segment_char_pixel_masks(img, img, "x", 0) == (None, None)

    def test_color_match_equalizes_bg_means(self):
        """Shifting to the shared midpoint makes both backgrounds the same mean."""
        from PIL import Image
        mc = self._mc()
        # charA image: cool bg (blue), small warm subject; charB: warm bg (yellow).
        a = np.full((40, 40, 3), [180, 190, 220], dtype=np.uint8)   # cool bg
        a[16:24, 16:24] = [200, 120, 80]                            # warm subject
        b = np.full((40, 40, 3), [230, 220, 170], dtype=np.uint8)   # warm bg
        b[16:24, 16:24] = [80, 120, 200]                            # cool subject
        # subject masks = the 8x8 center block (so bg = everything else).
        mask = np.zeros((40, 40), dtype=np.float32)
        mask[16:24, 16:24] = 1.0
        ma_img, mb_img, info = mc.color_match_to_shared_temperature(
            Image.fromarray(a), Image.fromarray(b), mask, mask)
        # After matching, the two backgrounds' per-channel means must coincide
        # at the midpoint of the ORIGINAL bg means.
        a_bg = (1.0 - mask) > 0.5
        b_bg = (1.0 - mask) > 0.5
        orig_a_bg = a.astype(np.float32)[a_bg].mean(axis=0)
        orig_b_bg = b.astype(np.float32)[b_bg].mean(axis=0)
        expected_target = (orig_a_bg + orig_b_bg) / 2.0
        new_a_bg = np.array(ma_img).astype(np.float32)[a_bg].mean(axis=0)
        new_b_bg = np.array(mb_img).astype(np.float32)[b_bg].mean(axis=0)
        assert np.allclose(new_a_bg, expected_target, atol=1.5)
        assert np.allclose(new_b_bg, expected_target, atol=1.5)
        assert np.allclose(new_a_bg, new_b_bg, atol=1.0)   # unified background


class TestRepaintMath:
    """The per-step Repaint re-injection formula (verified in isolation).

    The pipeline loop runs `latents = mask*locked + (1-mask)*latents` after each
    sampler step. We can't run the compiled loop on CPU, but the formula is pure
    array math — test its extremes directly to lock in the contract.
    """

    def test_full_lock_returns_locked(self):
        mask = mx.ones((1, 1, 4, 4))
        latents = mx.ones((1, 16, 4, 4)) * 7.0
        locked = mx.zeros((1, 16, 4, 4))             # (1-t)*clean + t*noise at t=1
        out = mask * locked + (1.0 - mask) * latents
        assert abs(float(mx.sum(out))) < 1e-3        # fully locked → == locked (0)

    def test_zero_lock_returns_latents(self):
        mask = mx.zeros((1, 1, 4, 4))
        latents = mx.ones((1, 16, 4, 4)) * 7.0
        locked = mx.zeros((1, 16, 4, 4))
        out = mask * locked + (1.0 - mask) * latents
        assert abs(float(mx.sum(out)) - 7.0 * 16 * 16) < 1e-2  # == latents

    def test_soft_mask_is_a_blend(self):
        mask = mx.full((1, 1, 4, 4), 0.5)
        latents = mx.ones((1, 16, 4, 4)) * 4.0
        locked = mx.zeros((1, 16, 4, 4))
        out = mask * locked + (1.0 - mask) * latents
        # 0.5*0 + 0.5*4 = 2.0 everywhere
        assert abs(float(mx.mean(out)) - 2.0) < 1e-3
