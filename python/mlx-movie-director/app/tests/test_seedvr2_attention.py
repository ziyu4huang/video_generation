"""Shape-contract tests for app/seedvr2/attention.py — MMAttention forward.

Uses midsize configs (rope_dim tuned to match head_dim for RoPE compat).
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.attention import MMAttention


# Config: rope_dim must produce total_freq ≤ head_dim for RoPE broadcast.
# With rope_dim=60: freq_dim=20, len(freqs)=10, freq_per_axis=20, total=60 ≤ head_dim=64 ✓
_VID_DIM = 256
_TXT_DIM = 256
_HEADS = 4
_HEAD_DIM = 64
_ROPE_DIM = 60


class TestMMAttentionForward:
    def test_output_shapes(self):
        B, Lv, Lt = 1, 16, 8
        attn = MMAttention(
            vid_dim=_VID_DIM, txt_dim=_TXT_DIM,
            heads=_HEADS, head_dim=_HEAD_DIM,
            rope_dim=_ROPE_DIM,
        )
        vid = mx.ones((B, Lv, _VID_DIM))
        txt = mx.ones((B, Lt, _TXT_DIM))
        vid_shape = mx.array([[4, 2, 2]])  # T*H*W = 16 = Lv
        txt_shape = mx.array([[Lt]])
        out_vid, out_txt = attn(vid, txt, vid_shape, txt_shape)
        assert out_vid.shape == (B, Lv, _VID_DIM)
        assert out_txt.shape == (B, Lt, _TXT_DIM)

    def test_output_bf16_preserves_shape(self):
        """Even if dtype changes internally, output shape is correct."""
        B, Lv, Lt = 1, 8, 4
        attn = MMAttention(
            vid_dim=128, txt_dim=128, heads=2, head_dim=64, rope_dim=60,
        )
        vid = mx.ones((B, Lv, 128)).astype(mx.bfloat16)
        txt = mx.ones((B, Lt, 128)).astype(mx.bfloat16)
        vid_shape = mx.array([[2, 2, 2]])
        txt_shape = mx.array([[Lt]])
        out_vid, out_txt = attn(vid, txt, vid_shape, txt_shape)
        assert out_vid.shape == (B, Lv, 128)
        assert out_txt.shape == (B, Lt, 128)

    def test_shared_weights(self):
        B, Lv, Lt = 1, 8, 4
        attn = MMAttention(
            vid_dim=128, txt_dim=128, heads=2, head_dim=64,
            rope_dim=60, shared_weights=True,
        )
        vid = mx.ones((B, Lv, 128))
        txt = mx.ones((B, Lt, 128))
        vid_shape = mx.array([[2, 2, 2]])
        txt_shape = mx.array([[Lt]])
        out_vid, out_txt = attn(vid, txt, vid_shape, txt_shape)
        assert out_vid.shape == (B, Lv, 128)
        assert out_txt.shape == (B, Lt, 128)

    def test_custom_qk_norm_eps(self):
        attn = MMAttention(
            vid_dim=128, txt_dim=128, heads=2, head_dim=64,
            rope_dim=60, qk_norm_eps=1e-3,
        )
        B, Lv, Lt = 1, 8, 4
        vid = mx.ones((B, Lv, 128))
        txt = mx.ones((B, Lt, 128))
        vid_shape = mx.array([[2, 2, 2]])
        txt_shape = mx.array([[Lt]])
        out_vid, out_txt = attn(vid, txt, vid_shape, txt_shape)
        assert out_vid.shape == (B, Lv, 128)


class TestMMAttentionWindowed:
    def test_windowed_forward_shape(self):
        B, Lv, Lt = 1, 32, 8
        attn = MMAttention(
            vid_dim=256, txt_dim=256, heads=4, head_dim=64,
            rope_dim=60, window=(4, 3, 3), shift=False,
        )
        vid = mx.ones((B, Lv, 256))
        txt = mx.ones((B, Lt, 256))
        vid_shape = mx.array([[4, 2, 4]])  # 4*2*4 = 32
        txt_shape = mx.array([[Lt]])
        out_vid, out_txt = attn(vid, txt, vid_shape, txt_shape)
        assert out_vid.shape == (B, Lv, 256)
        assert out_txt.shape == (B, Lt, 256)
