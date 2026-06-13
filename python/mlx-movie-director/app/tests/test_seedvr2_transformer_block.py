"""Shape-contract tests for SeedVR2 transformer block and sub-modules.

Uses midsize configs: vid_dim=256, head_dim=64, rope_dim=60.
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.transformer_block import TransformerBlock
from app.seedvr2.swiglu_mlp import SwiGLUMLP, GELUMLP
from app.seedvr2.rms_norm import RMSNorm
from app.seedvr2.ada_modulation import AdaModulation
from app.seedvr2.mm_swiglu import MMSwiGLU


_VID_DIM = 256
_EMB_DIM = 256
_ROPE_DIM = 60
_HEADS = 4
_HEAD_DIM = 64


# ==========================================================================
# RMSNorm
# ==========================================================================

class TestRMSNorm:
    def test_output_shape(self):
        rms = RMSNorm(dim=_VID_DIM)
        x = mx.ones((2, 8, _VID_DIM))
        out = rms(x)
        assert out.shape == x.shape

    def test_custom_eps(self):
        rms = RMSNorm(dim=_VID_DIM, eps=1e-3)
        x = mx.ones((2, 8, _VID_DIM))
        out = rms(x)
        assert out is not None


# ==========================================================================
# SwiGLUMLP / GELUMLP
# ==========================================================================

class TestSwiGLUMLP:
    def test_output_shape(self):
        mlp = SwiGLUMLP(dim=_VID_DIM, expand_ratio=2)
        x = mx.ones((2, 8, _VID_DIM))
        out = mlp(x)
        assert out.shape == (2, 8, _VID_DIM)

    def test_3d_input(self):
        mlp = SwiGLUMLP(dim=_VID_DIM, expand_ratio=2)
        x = mx.ones((16, _VID_DIM))
        out = mlp(x)
        assert out.shape == (16, _VID_DIM)

    def test_gelu_mlp_shape(self):
        mlp = GELUMLP(dim=_VID_DIM, expand_ratio=2)
        x = mx.ones((2, 8, _VID_DIM))
        out = mlp(x)
        assert out.shape == (2, 8, _VID_DIM)


# ==========================================================================
# AdaModulation
# ==========================================================================

class TestAdaModulation:
    """AdaModulation expects emb of shape (B, vid_dim, 2, 3).

    This shape comes from the SeedVR2Transformer's emb.reshape(-1, vid_dim, 2, 3)
    where emb is the TimeEmbedding output.
    """

    def test_modulate_vid_shape(self):
        B, L = 2, 8
        ada = AdaModulation(dim=_VID_DIM, shared_weights=False)
        x = mx.ones((B, L, _VID_DIM))
        emb = mx.ones((B, _VID_DIM, 2, 3))  # from transformer's reshape
        out = ada.modulate_vid(x, emb, layer="attn", mode="in")
        assert out.shape == x.shape

    def test_modulate_vid_mlp_layer(self):
        B, L = 2, 8
        ada = AdaModulation(dim=_VID_DIM)
        x = mx.ones((B, L, _VID_DIM))
        emb = mx.ones((B, _VID_DIM, 2, 3))
        out = ada.modulate_vid(x, emb, layer="mlp", mode="in")
        assert out.shape == x.shape

    def test_modulate_txt_shape(self):
        B, L = 2, 8
        ada = AdaModulation(dim=_VID_DIM)
        x = mx.ones((B, L, _VID_DIM))
        emb = mx.ones((B, _VID_DIM, 2, 3))
        out = ada.modulate_txt(x, emb, layer="attn", mode="in")
        assert out.shape == x.shape

    def test_modulate_txt_last_layer_returns_input(self):
        """When is_last_layer=True, modulate_txt returns input unchanged."""
        B, L = 2, 8
        ada = AdaModulation(dim=_VID_DIM, is_last_layer=True)
        x = mx.ones((B, L, _VID_DIM))
        emb = mx.ones((B, _VID_DIM, 2, 3))
        out = ada.modulate_txt(x, emb, layer="attn", mode="in")
        assert mx.allclose(out, x)

    def test_shared_weights(self):
        B, L = 2, 8
        ada = AdaModulation(dim=_VID_DIM, shared_weights=True)
        x = mx.ones((B, L, _VID_DIM))
        emb = mx.ones((B, _VID_DIM, 2, 3))
        out = ada.modulate_vid(x, emb, layer="attn", mode="in")
        assert out.shape == x.shape


# ==========================================================================
# MMSwiGLU
# ==========================================================================

class TestMMSwiGLU:
    def test_output_shapes(self):
        B, Lv, Lt = 2, 8, 4
        mlp = MMSwiGLU(vid_dim=_VID_DIM, txt_dim=_VID_DIM, expand_ratio=2)
        vid = mx.ones((B, Lv, _VID_DIM))
        txt = mx.ones((B, Lt, _VID_DIM))
        out_vid, out_txt = mlp(vid, txt)
        assert out_vid.shape == vid.shape
        assert out_txt.shape == txt.shape

    def test_shared_weights(self):
        mlp = MMSwiGLU(vid_dim=_VID_DIM, txt_dim=_VID_DIM, expand_ratio=2, shared_weights=True)
        B, Lv, Lt = 2, 8, 4
        vid = mx.ones((B, Lv, _VID_DIM))
        txt = mx.ones((B, Lt, _VID_DIM))
        out_vid, out_txt = mlp(vid, txt)
        assert out_vid.shape == vid.shape
        assert out_txt.shape == txt.shape


# ==========================================================================
# TransformerBlock — full integration
# ==========================================================================

class TestTransformerBlockInstantiation:
    """TransformerBlock forward pass requires production-like spatial dims
    due to the window-partitioned attention. Sub-module forward tests are
    above; here we verify instantiation and parameter structure only."""

    def test_instantiate(self):
        block = TransformerBlock(
            vid_dim=_VID_DIM, txt_dim=_VID_DIM,
            heads=_HEADS, head_dim=_HEAD_DIM,
            expand_ratio=2, rope_dim=_ROPE_DIM,
        )
        assert hasattr(block, "attn")
        assert hasattr(block, "mlp")
        assert hasattr(block, "ada")

    def test_parameters_traversable(self):
        block = TransformerBlock(
            vid_dim=_VID_DIM, txt_dim=_VID_DIM,
            heads=_HEADS, head_dim=_HEAD_DIM,
            expand_ratio=2, rope_dim=_ROPE_DIM,
        )
        params = block.parameters()
        assert isinstance(params, dict)
        assert len(params) > 0

    def test_shared_weights_instantiate(self):
        block = TransformerBlock(
            vid_dim=_VID_DIM, txt_dim=_VID_DIM,
            heads=_HEADS, head_dim=_HEAD_DIM,
            expand_ratio=2, rope_dim=_ROPE_DIM,
            shared_weights=True,
        )
        assert hasattr(block, "attn")
        assert hasattr(block, "mlp")

    def test_last_layer_instantiate(self):
        block = TransformerBlock(
            vid_dim=_VID_DIM, txt_dim=_VID_DIM,
            heads=_HEADS, head_dim=_HEAD_DIM,
            expand_ratio=2, rope_dim=_ROPE_DIM,
            is_last_layer=True,
        )
        assert hasattr(block, "attn")
        assert hasattr(block, "mlp")
