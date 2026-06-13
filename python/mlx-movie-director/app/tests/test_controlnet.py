"""Shape-contract tests for app/controlnet.py — patchification, 33ch input assembly,
and module registration.

Requires MLX but no real model weights — uses small random arrays.
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.controlnet import (
    patchify_latent,
    build_control_input_33ch,
    ZImageControlnet,
    _CONTROL_IN_CH,
)


# ==========================================================================
# patchify_latent
# ==========================================================================

class TestPatchifyLatent:
    def test_output_shape_64x64_latent(self):
        """[1, 16, 64, 64] → [1, 1024, 64]."""
        latent = mx.ones((1, 16, 64, 64))
        patches = patchify_latent(latent)
        assert patches.shape == (1, 1024, 64), (
            f"Expected (1, 1024, 64), got {patches.shape}"
        )

    def test_output_shape_32x48_latent(self):
        """[1, 16, 32, 48] → [1, 384, 64]."""
        latent = mx.ones((1, 16, 32, 48))
        patches = patchify_latent(latent)
        H_tok, W_tok = 16, 24
        assert patches.shape == (1, H_tok * W_tok, 64), (
            f"Expected (1, {H_tok * W_tok}, 64), got {patches.shape}"
        )

    def test_output_dtype_matches_input(self):
        latent = mx.ones((1, 16, 64, 64)).astype(mx.bfloat16)
        patches = patchify_latent(latent)
        assert patches.dtype == mx.bfloat16

    def test_small_even_latent(self):
        """Minimum even-sized input [1, 16, 4, 4] → [1, 4, 64]."""
        latent = mx.ones((1, 16, 4, 4))
        patches = patchify_latent(latent)
        assert patches.shape == (1, 4, 64)

    def test_requires_even_dimensions(self):
        """patchify_latent resizes via reshape + transpose that requires even H/W."""
        with pytest.raises(ValueError, match="reshape"):
            latent = mx.ones((1, 16, 33, 47))
            patchify_latent(latent)

    def test_values_preserved(self):
        """Patchify should preserve values (just reshape+transpose)."""
        latent = mx.arange(1 * 16 * 8 * 8).reshape(1, 16, 8, 8).astype(mx.float32)
        patches = patchify_latent(latent)
        assert mx.abs(mx.sum(patches) - mx.sum(latent)) < 1.0


# ==========================================================================
# build_control_input_33ch
# ==========================================================================

class TestBuildControlInput33ch:
    def test_default_inpaint_mask_shape(self):
        """[1, 16, 8, 8] → [1, 33, 8, 8]."""
        ctrl = mx.ones((1, 16, 8, 8))

        def fake_vae(img):
            return mx.ones((1, 16, 8, 8))

        result = build_control_input_33ch(ctrl, vae_encode_fn=fake_vae)
        assert result.shape == (1, 33, 8, 8)
        assert result.dtype == ctrl.dtype

    def test_has_33_channels(self):
        ctrl = mx.ones((1, 16, 8, 8))

        def fake_vae(img):
            return mx.ones((1, 16, 8, 8))

        result = build_control_input_33ch(ctrl, vae_encode_fn=fake_vae)
        assert result.shape[1] == _CONTROL_IN_CH

    def test_with_explicit_inpaint_latent(self):
        ctrl = mx.ones((1, 16, 8, 8))
        inpaint = mx.zeros((1, 16, 8, 8))

        def fake_vae(img):
            raise RuntimeError("should not be called")

        result = build_control_input_33ch(ctrl, vae_encode_fn=fake_vae, inpaint_latent=inpaint)
        assert result.shape == (1, 33, 8, 8)
        assert mx.all(result[:, 16:32, :, :] == 0)

    def test_with_spatial_mask(self):
        ctrl = mx.ones((1, 16, 8, 8))
        mask = mx.ones((1, 1, 8, 8)) * 0.5

        def fake_vae(img):
            return mx.ones((1, 16, 8, 8))

        result = build_control_input_33ch(ctrl, vae_encode_fn=fake_vae, mask_spatial=mask)
        assert result.shape == (1, 33, 8, 8)
        assert mx.all(result[:, 16:17, :, :] == 0.5)

    def test_mask_value_zero(self):
        ctrl = mx.ones((1, 16, 8, 8))

        def fake_vae(img):
            return mx.ones((1, 16, 8, 8))

        result = build_control_input_33ch(ctrl, vae_encode_fn=fake_vae, mask_value=0.0)
        assert mx.all(result[:, 16:17, :, :] == 0.0)

    def test_mask_value_one(self):
        ctrl = mx.ones((1, 16, 8, 8))

        def fake_vae(img):
            return mx.ones((1, 16, 8, 8))

        result = build_control_input_33ch(ctrl, vae_encode_fn=fake_vae, mask_value=1.0)
        assert mx.all(result[:, 16:17, :, :] == 1.0)


# ==========================================================================
# ZImageControlnet module registration
# ==========================================================================

class TestZImageControlnetRegistration:
    """Verify that all sub-modules are discoverable via leaf_modules/parameters."""

    def test_has_expected_children(self):
        model = ZImageControlnet()
        assert hasattr(model, "control_all_x_embedder")
        assert hasattr(model, "control_noise_refiner")
        assert hasattr(model, "control_layers")

    def test_noise_refiner_count(self):
        model = ZImageControlnet()
        assert len(model.control_noise_refiner) == 2

    def test_control_layer_count(self):
        model = ZImageControlnet()
        assert len(model.control_layers) == 3

    def test_parameters_traversable(self):
        """parameters() call should not crash on fresh (unloaded) model."""
        model = ZImageControlnet()
        params = model.parameters()
        assert isinstance(params, dict)

    def test_leaf_modules_include_all_sections(self):
        model = ZImageControlnet()
        paths = [i[0] if isinstance(i, tuple) else str(i) for i in model.leaf_modules()]
        all_paths = " ".join(paths)
        assert "control_layers" in all_paths
        assert "control_noise_refiner" in all_paths
        assert "control_all_x_embedder" in all_paths
