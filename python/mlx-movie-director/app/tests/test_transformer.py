"""Unit tests for app/transformer.py — module structure, shapes, QKV fusion.

Uses MLX with tiny dummy configs (no real weights needed for shape/integrity checks).
"""

import numpy as np
import pytest

try:
    import mlx.core as mx
    import mlx.nn as nn
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.transformer import (
    ZImageTransformerMLX,
    ZImageTransformerBlock,
    Attention,
    FeedForward,
    TimestepEmbedder,
    FinalLayer,
    RMSNorm,
)

# ---------------------------------------------------------------------------
# Tiny config for structural tests (no real inference)
# ---------------------------------------------------------------------------

_TINY_CONFIG = {
    "dim": 64,
    "nheads": 4,
    "n_layers": 2,
    "n_refiner_layers": 1,
    "in_channels": 16,
    "out_channels": 16,
    "cap_feat_dim": 32,
    "norm_eps": 1e-5,
    "qk_norm": True,
    "rope_theta": 256.0,
    "t_scale": 1000.0,
    "axes_dims": [4, 6, 6],
    "axes_lens": [64, 32, 32],
}


# ===================================================================
# Module structure — nn.ModuleList registration (CRITICAL)
# ===================================================================

class TestZImageTransformerMLXModuleRegistration:
    """Verify that all child modules are discoverable by MLX's nn.Module tree.

    Plain Python lists are used instead of nn.ModuleList (not available in
    MLX 0.31.2). MLX's tree_flatten / parameters() recursively traverse
    list and dict attributes to find sub-modules.
    """

    def test_layers_is_list(self):
        model = ZImageTransformerMLX(_TINY_CONFIG)
        assert isinstance(model.layers, list)
        assert isinstance(model.noise_refiner, list)
        assert isinstance(model.context_refiner, list)

    def test_layer_count(self):
        model = ZImageTransformerMLX(_TINY_CONFIG)
        assert len(model.layers) == _TINY_CONFIG["n_layers"]
        assert len(model.noise_refiner) == _TINY_CONFIG["n_refiner_layers"]
        assert len(model.context_refiner) == _TINY_CONFIG["n_refiner_layers"]

    def test_parameters_includes_layer_weights(self):
        """All leaf parameters from the three block lists must appear in model.parameters()."""
        model = ZImageTransformerMLX(_TINY_CONFIG)
        from mlx.utils import tree_flatten
        all_params = dict(tree_flatten(model.parameters()))

        # Check that a known weight exists inside each block list
        assert any("noise_refiner" in k for k in all_params), (
            f"noise_refiner weights missing from parameters(): keys={list(all_params.keys())}"
        )
        assert any("context_refiner" in k for k in all_params)
        assert any("layers" in k for k in all_params)

    def test_leaf_modules_includes_block_lists(self):
        model = ZImageTransformerMLX(_TINY_CONFIG)
        # MLX's leaf_modules() yields module-path strings in this version
        # (older MLX yielded (key, module) tuples). Normalize to a string key
        # and substring-match, so the test survives either keying flavor and
        # either top-level or dotted-path formatting.
        paths = [i[0] if isinstance(i, tuple) else i for i in model.leaf_modules()]
        assert any("noise_refiner" in p for p in paths), "noise_refiner missing from leaf_modules()"
        assert any("context_refiner" in p for p in paths)
        assert any("layers" in p for p in paths)


# ===================================================================
# Attention — QKV fusion
# ===================================================================

class TestAttentionQKVFusion:
    def test_pre_fusion_has_separate_proj(self):
        attn = Attention(dim=64, nheads=4)
        assert attn.to_q is not None
        assert attn.to_k is not None
        assert attn.to_v is not None
        assert attn.to_qkv is None

    def test_fuse_qkv_creates_fused_layer(self):
        attn = Attention(dim=64, nheads=4)
        attn.fuse_qkv()
        assert attn.to_qkv is not None
        assert not hasattr(attn, "to_q") or attn.to_q is None

    def test_fuse_qkv_output_shape(self):
        attn = Attention(dim=64, nheads=4)
        attn.fuse_qkv()
        B, L = 1, 8
        x = mx.ones((B, L, 64))

        pos = mx.zeros((B, L, 3))
        # RoPE cos/sin broadcast against q[..., 0::2] of shape
        # (B, L, nheads, head_dim // 2); here dim=64, nheads=4 -> head_dim=16.
        cos, sin = mx.ones((B, L, 4, 8)), mx.zeros((B, L, 4, 8))

        out = attn(x, positions=pos, cos=cos, sin=sin)
        assert out.shape == (B, L, 64), f"Expected (1,8,64), got {out.shape}"

    def test_fused_qkv_reduces_param_count(self):
        """Fused QKV should have fewer separate parameter entries."""
        attn = Attention(dim=64, nheads=4)
        params_before = len(list(attn.parameters()))
        attn.fuse_qkv()
        params_after = len(list(attn.parameters()))
        # After fusion: to_out, to_qkv (vs to_q, to_k, to_v, to_out)
        assert params_after < params_before


# ===================================================================
# Forward shape checks (tiny config, no real generation)
# ===================================================================

class TestZImageTransformerBlock:
    def test_output_shape(self):
        block = ZImageTransformerBlock(_TINY_CONFIG, layer_id=0, modulation=True)
        B, L, D = 1, 16, _TINY_CONFIG["dim"]
        nheads = _TINY_CONFIG["nheads"]
        head_dim = D // nheads
        x = mx.ones((B, L, D))
        pos = mx.zeros((B, L, 3))
        temb = mx.ones((B, 256))
        # RoPE cos/sin are 4D (B, L, nheads, head_dim // 2), broadcasting against
        # the interleaved q/k halves inside Attention.__call__.
        cos = mx.ones((B, L, nheads, head_dim // 2))
        sin = mx.zeros((B, L, nheads, head_dim // 2))

        out = block(x, mask=None, positions=pos, adaln_input=temb, cos=cos, sin=sin)
        assert out.shape == (B, L, D), f"Expected {(B, L, D)}, got {out.shape}"

    def test_no_modulation_output_shape(self):
        block = ZImageTransformerBlock(_TINY_CONFIG, layer_id=0, modulation=False)
        B, L, D = 1, 16, _TINY_CONFIG["dim"]
        nheads = _TINY_CONFIG["nheads"]
        head_dim = D // nheads
        x = mx.ones((B, L, D))
        pos = mx.zeros((B, L, 3))
        cos = mx.ones((B, L, nheads, head_dim // 2))
        sin = mx.zeros((B, L, nheads, head_dim // 2))

        out = block(x, mask=None, positions=pos, cos=cos, sin=sin)
        assert out.shape == (B, L, D)


class TestTimestepEmbedder:
    def test_output_shape(self):
        te = TimestepEmbedder(out_size=256, mid_size=512)
        t = mx.array([0.5]).reshape(1, 1)
        out = te(t)
        # Output mirrors the input t shape (1, 1) plus the 256-dim embedding;
        # the t[:, None] freq path keeps the leading dims.
        assert out.shape == (1, 1, 256), f"Expected (1, 1, 256), got {out.shape}"

    def test_output_dtype(self):
        te = TimestepEmbedder(out_size=256)
        t = mx.array([0.5]).reshape(1, 1)
        out = te(t)
        assert out.dtype == mx.float32


class TestFeedForward:
    def test_output_shape(self):
        ff = FeedForward(dim=64, hidden_dim=256)
        x = mx.ones((1, 16, 64))
        out = ff(x)
        assert out.shape == (1, 16, 64)

    def test_gated_activation(self):
        """FeedForward uses SiLU-gated linear (SwiGLU variant)."""
        ff = FeedForward(dim=64, hidden_dim=256)
        x = mx.ones((1, 16, 64))
        out = ff(x)
        assert mx.all(mx.isfinite(out)), "FeedForward output contains NaN/Inf"


class TestFinalLayer:
    def test_output_shape(self):
        fl = FinalLayer(dim=64, out_channels=64)
        B, L = 1, 16
        x = mx.ones((B, L, 64))
        c = mx.ones((B, 256))
        out = fl(x, c)
        assert out.shape == (B, L, 64)


# ===================================================================
# RMSNorm
# ===================================================================

class TestRMSNorm:
    def test_output_shape(self):
        rms = RMSNorm(dims=64)
        x = mx.ones((1, 16, 64))
        out = rms(x)
        assert out.shape == x.shape

    def test_output_dtype(self):
        rms = RMSNorm(dims=64)
        x = mx.ones((1, 16, 64)).astype(mx.bfloat16)
        out = rms(x)
        # mx.fast.rms_norm computes the variance reduction in float32 (the
        # RMSNorm weight is float32), so a bfloat16 input is upcast to float32.
        assert out.dtype == mx.float32


# ===================================================================
# prepare_rope — positional encoding cache
# ===================================================================

class TestPrepareRope:
    def test_output_shapes(self):
        model = ZImageTransformerMLX(_TINY_CONFIG)
        positions = mx.zeros((1, 32, 3))
        cos, sin = model.prepare_rope(positions)
        assert cos.shape == sin.shape
        assert cos.shape[1] == positions.shape[1]
        # prepare_rope concatenates per-axis freqs into a 4D (B, L, 1, sum_half)
        # tensor; the singleton axis broadcasts over heads inside Attention.
        assert cos.ndim == 4, f"Expected 4D (B, L, 1, sum_half), got {cos.ndim}D"

    def test_reproducible(self):
        model = ZImageTransformerMLX(_TINY_CONFIG)
        pos = mx.ones((1, 8, 3))
        c1, s1 = model.prepare_rope(pos)
        c2, s2 = model.prepare_rope(pos)
        assert mx.allclose(c1, c2)
        assert mx.allclose(s1, s2)
