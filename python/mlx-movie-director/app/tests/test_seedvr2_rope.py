"""Shape-contract tests for app/seedvr2/rope.py — RoPEModule.

Uses RL-sized rope_dim=60 with head_dim=64 to match RoPE dim requirements.
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.rope import RoPEModule


# With rope_dim=60: freq_dim=20, len(freqs)=10, freq_per_axis=20,
# total_freq=60 ≤ head_dim=64 → RoPE broadcast works.
_ROPE_DIM = 60
_HEAD_DIM = 64


class TestRoPEModuleVideoOnly:
    def test_output_shapes(self):
        B, L, heads = 1, 16, 4
        q = mx.ones((B, L, heads, _HEAD_DIM))
        k = mx.ones((B, L, heads, _HEAD_DIM))
        vid_shape = mx.array([[4, 2, 2]])
        rope = RoPEModule(dim=_ROPE_DIM)
        q_out, k_out = rope(q, k, vid_shape)
        assert q_out.shape == q.shape
        assert k_out.shape == k.shape

    def test_reproducible(self):
        q = mx.ones((1, 8, 2, _HEAD_DIM))
        k = mx.ones((1, 8, 2, _HEAD_DIM))
        vid_shape = mx.array([[2, 2, 2]])
        rope = RoPEModule(dim=_ROPE_DIM)
        q1, k1 = rope(q, k, vid_shape)
        q2, k2 = rope(q, k, vid_shape)
        assert mx.allclose(q1, q2)
        assert mx.allclose(k1, k2)

    def test_dtype_preserved(self):
        q = mx.ones((1, 8, 2, _HEAD_DIM)).astype(mx.bfloat16)
        k = mx.ones((1, 8, 2, _HEAD_DIM)).astype(mx.bfloat16)
        vid_shape = mx.array([[2, 2, 2]])
        rope = RoPEModule(dim=_ROPE_DIM)
        q_out, k_out = rope(q, k, vid_shape)
        assert q_out.dtype == mx.bfloat16
        assert k_out.dtype == mx.bfloat16

    def test_flat_batch(self):
        """Flattened tokens (B*L, heads, head_dim) from attention reshape."""
        N, heads = 16, 4
        q = mx.ones((N, heads, _HEAD_DIM))
        k = mx.ones((N, heads, _HEAD_DIM))
        vid_shape = mx.array([[4, 2, 2]])
        rope = RoPEModule(dim=_ROPE_DIM)
        q_out, k_out = rope(q, k, vid_shape)
        assert q_out.shape == q.shape


class TestRoPEModuleMultiModal:
    def test_output_shapes(self):
        Lv, Lt = 8, 4
        heads = 2
        qv = mx.ones((Lv, heads, _HEAD_DIM))
        kv = mx.ones((Lv, heads, _HEAD_DIM))
        qt = mx.ones((Lt, heads, _HEAD_DIM))
        kt = mx.ones((Lt, heads, _HEAD_DIM))
        vid_shape = mx.array([[2, 2, 2]])
        txt_shape = mx.array([[Lt]])
        rope = RoPEModule(dim=_ROPE_DIM)
        qv_o, kv_o, qt_o, kt_o = rope(qv, kv, vid_shape, qt, kt, txt_shape)
        assert qv_o.shape == qv.shape
        assert kv_o.shape == kv.shape
        assert qt_o.shape == qt.shape
        assert kt_o.shape == kt.shape

    def test_reproducible(self):
        Lv, Lt = 8, 4
        heads = 2
        qv = mx.ones((Lv, heads, _HEAD_DIM))
        kv = mx.ones((Lv, heads, _HEAD_DIM))
        qt = mx.ones((Lt, heads, _HEAD_DIM))
        kt = mx.ones((Lt, heads, _HEAD_DIM))
        vid_shape = mx.array([[2, 2, 2]])
        txt_shape = mx.array([[Lt]])
        rope = RoPEModule(dim=_ROPE_DIM)
        r1 = rope(qv, kv, vid_shape, qt, kt, txt_shape)
        r2 = rope(qv, kv, vid_shape, qt, kt, txt_shape)
        for a, b in zip(r1, r2):
            assert mx.allclose(a, b)


class TestRoPEModuleHelpers:
    def test_apply_rotary_emb_shape(self):
        freqs = mx.ones((L := 8, 1, 60))
        t = mx.ones((L, 4, _HEAD_DIM))
        result = RoPEModule._apply_rotary_emb(freqs, t)
        assert result.shape == t.shape

    def test_apply_rotary_emb_preserves_tail(self):
        """Dimensions beyond rot_dim are passed through unchanged."""
        freqs = mx.ones((2, 1, 60))  # rot_dim = 60
        t = mx.ones((2, 4, _HEAD_DIM))  # 60 rotated + 4 unrotated
        result = RoPEModule._apply_rotary_emb(freqs, t)
        assert mx.allclose(result[..., 60:], t[..., 60:])

    def test_get_axial_freqs_lang(self):
        rope = RoPEModule(dim=_ROPE_DIM)
        result = RoPEModule._get_axial_freqs(rope.freqs, 4, 3, 3, freqs_for="lang")
        freq_per_axis = len(rope.freqs) * 2  # 10*2 = 20
        total = freq_per_axis * 3  # 60
        assert result.shape == (4, 3, 3, total), (
            f"Expected (4,3,3,{total}), got {result.shape}"
        )

    def test_get_axial_freqs_1d(self):
        """1D case (text-only)."""
        rope = RoPEModule(dim=_ROPE_DIM)
        result = RoPEModule._get_axial_freqs(rope.freqs, 8, freqs_for="lang")
        freq_per_axis = len(rope.freqs) * 2
        total = freq_per_axis * 1  # 1 axis
        assert result.shape == (8, total), (
            f"Expected (8,{total}), got {result.shape}"
        )

    def test_rotate_half_shape(self):
        x = mx.ones((2, 8))
        result = RoPEModule._rotate_half(x)
        assert result.shape == x.shape
