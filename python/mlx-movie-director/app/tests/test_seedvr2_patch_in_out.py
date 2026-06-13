"""Shape-contract tests for seedvr2/patch_in.py and patch_out.py.

Verifies patching/unpatching round-trips preserve spatial structure.
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.patch_in import PatchIn
from app.seedvr2.patch_out import PatchOut


# Tiny configs for fast shape tests
_IN_CHANNELS = 33
_DIM = 64


class TestPatchIn:
    def test_output_shape(self):
        """[B, C, T, H, W] → [B, N, D] + vid_shape [B, 3]."""
        B, C, T, H, W = 1, _IN_CHANNELS, 2, 8, 8
        patch_in = PatchIn(in_channels=C, patch_size=(1, 2, 2), dim=_DIM)
        vid = mx.ones((B, C, T, H, W))
        out, shape = patch_in(vid)
        T_patches = T // 1
        H_patches = H // 2
        W_patches = W // 2
        expected_n = T_patches * H_patches * W_patches
        assert out.shape == (B, expected_n, _DIM), (
            f"Expected ({B},{expected_n},{_DIM}), got {out.shape}"
        )
        assert shape.shape == (B, 3)

    def test_vid_shape_values(self):
        """vid_shape should reflect the patch grid dimensions."""
        B, C, T, H, W = 1, _IN_CHANNELS, 4, 16, 16
        patch_in = PatchIn(in_channels=C, patch_size=(2, 4, 4), dim=_DIM)
        vid = mx.ones((B, C, T, H, W))
        _, shape = patch_in(vid)
        expected = mx.array([[T // 2, H // 4, W // 4]], dtype=mx.int32)
        assert mx.allclose(shape, expected), f"Expected {expected}, got {shape}"

    def test_batch_independent(self):
        """Two batches produce separate shapes."""
        B, C, T, H, W = 2, _IN_CHANNELS, 2, 8, 8
        patch_in = PatchIn(in_channels=C, patch_size=(1, 2, 2), dim=_DIM)
        vid = mx.ones((B, C, T, H, W))
        _, shape = patch_in(vid)
        assert shape.shape == (B, 3)

    def test_bf16_correct_shape(self):
        """bfloat16 input — shape preserved even if internal dtype changes."""
        patch_in = PatchIn(in_channels=_IN_CHANNELS, patch_size=(1, 2, 2), dim=_DIM)
        vid = mx.ones((1, _IN_CHANNELS, 2, 8, 8)).astype(mx.bfloat16)
        out, _ = patch_in(vid)
        # T_patches=2//1=2, H_patches=8//2=4, W_patches=8//2=4 → N=32
        assert out.shape == (1, 32, _DIM)

    def test_single_frame(self):
        """T=1 should still work with proper patch dims."""
        B, C, T, H, W = 1, _IN_CHANNELS, 1, 8, 8
        patch_in = PatchIn(in_channels=C, patch_size=(1, 2, 2), dim=_DIM)
        vid = mx.ones((B, C, T, H, W))
        out, shape = patch_in(vid)
        T_patches = T // 1
        H_patches = H // 2
        W_patches = W // 2
        assert out.shape == (B, T_patches * H_patches * W_patches, _DIM)


class TestPatchOut:
    def test_output_shape(self):
        """[B, N, D] + vid_shape → [B, C, T, H, W]."""
        B, C_out, T, H, W = 1, 16, 2, 8, 8
        T_patches, H_patches, W_patches = 2, 4, 4
        N = T_patches * H_patches * W_patches
        patch_out = PatchOut(out_channels=C_out, patch_size=(1, 2, 2), dim=_DIM)
        x = mx.ones((B, N, _DIM))
        vid_shape = mx.array([[T_patches, H_patches, W_patches]], dtype=mx.int32)
        out, shape = patch_out(x, vid_shape)
        assert out.shape == (B, C_out, T, H, W), (
            f"Expected ({B},{C_out},{T},{H},{W}), got {out.shape}"
        )

    def test_vid_shape_preserved(self):
        """vid_shape output matches input."""
        B, C_out = 1, 4
        patch_out = PatchOut(out_channels=C_out, patch_size=(1, 2, 2), dim=_DIM)
        x = mx.ones((1, 16, _DIM))
        vid_shape = mx.array([[2, 2, 4]], dtype=mx.int32)
        _, shape = patch_out(x, vid_shape)
        assert mx.allclose(shape, vid_shape)


class TestPatchRoundTrip:
    """PatchIn followed by PatchOut should reconstruct spatial dims."""

    def test_round_trip_channels(self):
        B, C, T, H, W = 1, 8, 2, 8, 8
        dim = 32
        patch_in = PatchIn(in_channels=C, patch_size=(1, 2, 2), dim=dim)
        patch_out = PatchOut(out_channels=C, patch_size=(1, 2, 2), dim=dim)

        vid = mx.ones((B, C, T, H, W)).astype(mx.float32)
        tokens, shape = patch_in(vid)
        reconstructed, _ = patch_out(tokens, shape)
        assert reconstructed.shape == vid.shape, (
            f"Round-trip shape mismatch: {reconstructed.shape} vs {vid.shape}"
        )
