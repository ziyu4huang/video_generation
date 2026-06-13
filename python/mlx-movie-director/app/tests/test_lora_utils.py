"""Unit tests for app/lora_utils.py — key mapping, Kronecker product, weight injection.

Pure shape/logic tests — no real model weights needed.
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

from app.lora_utils import (
    _mx_kron,
    _convert_lokr_key,
    _apply_lokr_delta,
    convert_unet_key_to_mlx,
    get_module_by_name,
    set_module_by_name,
    LoRALinearWrapper,
)


# ===================================================================
# Kronecker product
# ===================================================================

class TestMxKron:
    def test_basic_shape(self):
        a = mx.ones((2, 3))
        b = mx.ones((4, 5))
        out = _mx_kron(a, b)
        assert out.shape == (2 * 4, 3 * 5), f"Expected (8,15), got {out.shape}"

    def test_identity(self):
        a = mx.array([[1, 0], [0, 1]])  # 2x2 identity
        b = mx.array([[1, 2], [3, 4]])
        out = _mx_kron(a, b)
        expected = mx.array([
            [1, 2, 0, 0],
            [3, 4, 0, 0],
            [0, 0, 1, 2],
            [0, 0, 3, 4],
        ])
        assert mx.allclose(out, expected), f"Kron(identity, M) mismatch"

    def test_scalar_factor(self):
        a = mx.array([[2]])
        b = mx.array([[3, 4], [5, 6]])
        out = _mx_kron(a, b)
        assert out.shape == (2, 4)
        assert mx.allclose(out, b * 2), "Kron with 1x1 factor M should be M * scalar"

    def test_dtype_preserved(self):
        a = mx.ones((2, 2)).astype(mx.bfloat16)
        b = mx.ones((2, 2)).astype(mx.bfloat16)
        out = _mx_kron(a, b)
        assert out.dtype == mx.bfloat16


# ===================================================================
# LoKR key conversion
# ===================================================================

class TestConvertLokrKey:
    def test_diffusion_model_stripped(self):
        assert _convert_lokr_key("diffusion_model.some.path") == "some.path"

    def test_to_out_mapped(self):
        result = _convert_lokr_key("attention.to_out.0.weight")
        assert "attention.to_out" in result
        assert ".0" not in result

    def test_adaLN_modulation_trailing_index_stripped(self):
        result = _convert_lokr_key("adaLN_modulation.3")
        assert result == "adaLN_modulation"

    def test_adaLN_modulation_mid_index(self):
        result = _convert_lokr_key("blocks.0.adaLN_modulation.1")
        assert result == "blocks.0.adaLN_modulation"

    def test_no_match_unchanged(self):
        key = "some_random.path"
        assert _convert_lokr_key(key) == key


# ===================================================================
# LoKR delta application (weight injection)
# ===================================================================

class TestApplyLokrDelta:
    def test_linear_weight_shape_update(self):
        layer = nn.Linear(32, 64, bias=False)
        delta = mx.ones((64, 32)).astype(layer.weight.dtype) * 0.01
        orig_shape = layer.weight.shape
        result = _apply_lokr_delta(layer, delta)
        assert result is True, "Expected successful application on nn.Linear"
        assert layer.weight.shape == orig_shape
        # Weight should have changed
        assert not mx.allclose(layer.weight, mx.zeros(orig_shape))

    def test_quantized_linear_accepts(self):
        """QuantizedLinear should also accept delta (dequant→add→requant)."""
        layer = nn.QuantizedLinear(32, 64, bias=False, bits=4, group_size=32)
        delta = mx.ones((64, 32)).astype(mx.float32) * 0.001
        result = _apply_lokr_delta(layer, delta)
        assert result is True

    def test_linear_delta_shape_transpose(self):
        """When delta shape mismatches weight shape, _apply_lokr_delta transposes."""
        layer = nn.Linear(64, 32, bias=True)  # weight shape (32, 64)
        delta = mx.ones((32, 64)).astype(layer.weight.dtype) * 0.01
        result = _apply_lokr_delta(layer, delta)
        assert result is True
        assert layer.weight.shape == (32, 64)

    def test_unknown_module_returns_false(self):
        from mlx.nn import Module  # base class
        layer = Module()
        assert not _apply_lokr_delta(layer, mx.zeros((1, 1)))


# ===================================================================
# UNet key mapping (LoRA → MLX)
# ===================================================================

class TestConvertUnetKeyToMlx:
    """Verify that convert_unet_key_to_mlx correctly remaps LoRA keys."""

    def test_lora_unet_prefix_stripped(self):
        assert convert_unet_key_to_mlx("lora_unet_attention.to_q.weight") == "attention.to_q.weight"

    def test_diffusion_model_stripped(self):
        assert convert_unet_key_to_mlx("diffusion_model.attention.to_q.weight") == "attention.to_q.weight"

    def test_layers_index_conversion(self):
        result = convert_unet_key_to_mlx("lora_unet_layers_0_attention.to_q.weight")
        assert "layers.0" in result, f"Expected layers.0 in result, got {result}"

    def test_attention_qkv_mapping(self):
        for suffix in ["to_q", "to_k", "to_v"]:
            key = f"lora_unet_attention_{suffix}.weight"
            result = convert_unet_key_to_mlx(key)
            assert f"attention.{suffix}" in result, f"Failed to map {key} → {result}"

    def test_attention_to_out_mapping(self):
        result = convert_unet_key_to_mlx("lora_unet_attention_to_out_0.weight")
        assert "attention.to_out" in result

    def test_feed_forward_mapping(self):
        for i, w in enumerate(["w1", "w2", "w3"], 1):
            key = f"lora_unet_feed_forward_{w}.weight"
            result = convert_unet_key_to_mlx(key)
            assert f"feed_forward.{w}" in result, f"Failed to map {key} → {result}"

    def test_adaLN_modulation_mapping(self):
        result = convert_unet_key_to_mlx("lora_unet_adaLN_modulation_0.weight")
        assert "adaLN_modulation" in result

    def test_adaLN_modulation_1_kept(self):
        """adaLN_modulation.1 (nn.Sequential index 1) should be preserved."""
        result = convert_unet_key_to_mlx("lora_unet_adaLN_modulation.1.weight")
        assert "adaLN_modulation.1" in result


# ===================================================================
# Module path resolution (get/set by dotted name)
# ===================================================================

class MockLayer(nn.Module):
    def __init__(self):
        super().__init__()
        self.linear = nn.Linear(8, 8)


class MockModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = [MockLayer() for _ in range(3)]
        self.final = nn.Linear(8, 8)


class TestGetModuleByName:
    def test_get_top_level(self):
        model = MockModel()
        assert get_module_by_name(model, "final") is model.final

    def test_get_nested_layer(self):
        model = MockModel()
        result = get_module_by_name(model, "layers.1")
        assert result is model.layers[1]

    def test_get_nested_linear(self):
        model = MockModel()
        result = get_module_by_name(model, "layers.0.linear")
        assert result is model.layers[0].linear

    def test_nonexistent_path_returns_none(self):
        model = MockModel()
        assert get_module_by_name(model, "nonexistent.path") is None
        assert get_module_by_name(model, "layers.99") is None


class TestSetModuleByName:
    def test_set_top_level(self):
        model = MockModel()
        new_layer = nn.Linear(8, 16)
        set_module_by_name(model, "final", new_layer)
        assert model.final is new_layer

    def test_set_nested(self):
        model = MockModel()
        old_linear = model.layers[0].linear
        new_linear = nn.Linear(8, 16)
        set_module_by_name(model, "layers.0.linear", new_linear)
        assert model.layers[0].linear is new_linear


# ===================================================================
# LoRALinearWrapper
# ===================================================================

class TestLoRALinearWrapper:
    def test_output_shape_matches_base(self):
        base = nn.Linear(16, 32, bias=False)
        lora_a = mx.ones((16, 4)).astype(mx.float32)
        lora_b = mx.ones((4, 32)).astype(mx.float32)
        wrapper = LoRALinearWrapper(base, lora_a, lora_b, scale=1.0)

        x = mx.ones((1, 8, 16))
        out = wrapper(x)
        assert out.shape == (1, 8, 32), f"Expected (1,8,32), got {out.shape}"

    def test_zero_scale_is_identity(self):
        base = nn.Linear(16, 32, bias=False)
        lora_a = mx.ones((16, 4)).astype(mx.float32)
        lora_b = mx.ones((4, 32)).astype(mx.float32)
        wrapper = LoRALinearWrapper(base, lora_a, lora_b, scale=0.0)

        x = mx.ones((1, 8, 16))
        base_out = base(x)
        wrapper_out = wrapper(x)
        assert mx.allclose(base_out, wrapper_out), "scale=0 should match base"

    def test_lora_a_auto_transpose(self):
        """When a.shape[0] != x.shape[-1], wrapper should transpose a."""
        base = nn.Linear(16, 32, bias=False)
        # a shape (4, 16) — needs transpose to (16, 4) for (x @ a @ b)
        lora_a = mx.ones((4, 16)).astype(mx.float32)
        lora_b = mx.ones((4, 32)).astype(mx.float32)
        wrapper = LoRALinearWrapper(base, lora_a, lora_b, scale=1.0)

        x = mx.ones((1, 8, 16))
        out = wrapper(x)
        assert out.shape == (1, 8, 32)

    def test_lora_b_auto_transpose(self):
        """When b.shape[0] != a.shape[-1], wrapper should transpose b."""
        base = nn.Linear(16, 32, bias=False)
        lora_a = mx.ones((16, 8)).astype(mx.float32)
        lora_b = mx.ones((32, 8)).astype(mx.float32)  # wrong dim order
        wrapper = LoRALinearWrapper(base, lora_a, lora_b, scale=1.0)

        x = mx.ones((1, 8, 16))
        out = wrapper(x)
        assert out.shape == (1, 8, 32)
