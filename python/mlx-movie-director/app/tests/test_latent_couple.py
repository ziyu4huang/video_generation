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
