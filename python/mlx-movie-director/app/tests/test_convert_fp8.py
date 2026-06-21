"""Unit tests for FP8 (8-bit float) → MLX conversion support.

Covers dequant_comfyui_fp8() — the shared helper used by both convert.py
--zit-checkpoint and import-checkpoint — plus the _remap_qkv guard that prevents
the `.qkv.weight_scale` scalar crash (the original import-checkpoint failure on
the dark-beast fp8 checkpoint).
"""

import torch

from convert import dequant_comfyui_fp8, _remap_qkv


def test_dequant_fp8_with_scale_drops_metadata():
    """ComfyUI FP8: weight (fp8) × per-tensor scale -> bf16; scale + comfy_quant dropped."""
    w = torch.randn(9, 4).to(torch.float8_e4m3fn)
    scale = torch.tensor(2.5)
    pt = {
        "blk.qkv.weight": w,
        "blk.qkv.weight_scale": scale,
        "blk.qkv.comfy_quant": torch.tensor([1, 2, 3], dtype=torch.uint8),
        "blk.linear.weight": torch.randn(4, 4, dtype=torch.bfloat16),
    }
    dequant_comfyui_fp8(pt, log_prefix="test")
    # metadata siblings must be gone (these are what crashed _remap_qkv before)
    assert "blk.qkv.weight_scale" not in pt
    assert "blk.qkv.comfy_quant" not in pt
    # fp8 dequantized up to bf16, shape preserved
    assert pt["blk.qkv.weight"].dtype == torch.bfloat16
    assert pt["blk.qkv.weight"].shape == (9, 4)
    # unrelated bf16 weight left in place
    assert pt["blk.linear.weight"].dtype == torch.bfloat16


def test_dequant_plain_fp8_no_scale_casts_to_bf16():
    """Plain FP8 source (no .weight_scale sibling) falls back to a raw fp8->bf16 cast."""
    pt = {"blk.w.weight": torch.randn(6, 6).to(torch.float8_e4m3fn)}
    dequant_comfyui_fp8(pt, log_prefix="test")
    assert pt["blk.w.weight"].dtype == torch.bfloat16


def test_dequant_fp16_fp32_upcast_to_bf16():
    """fp16/fp32 tensors are up-cast to bf16; bf16 is a passthrough."""
    pt = {
        "a.weight": torch.randn(3, 3, dtype=torch.float16),
        "b.weight": torch.randn(3, 3, dtype=torch.float32),
        "c.weight": torch.randn(3, 3, dtype=torch.bfloat16),
    }
    dequant_comfyui_fp8(pt, log_prefix="test")
    assert pt["a.weight"].dtype == torch.bfloat16
    assert pt["b.weight"].dtype == torch.bfloat16
    assert pt["c.weight"].dtype == torch.bfloat16


def test_dequant_no_fp8_is_noop():
    """A pure bf16 checkpoint passes through unchanged (no metadata keys)."""
    pt = {"x.weight": torch.randn(4, 4, dtype=torch.bfloat16)}
    keys_before = set(pt.keys())
    dequant_comfyui_fp8(pt, log_prefix="test")
    assert set(pt.keys()) == keys_before
    assert pt["x.weight"].dtype == torch.bfloat16


def test_remap_qkv_skips_non_chunkable_scalar():
    """A 0-dim / non-divisible tensor under a .qkv. key is dropped, not crashed on.

    This is the exact failure the dark-beast fp8 checkpoint hit before
    dequant_comfyui_fp8 existed: a stray `.qkv.weight_scale` scalar reached
    weight.chunk(3, dim=0) -> 'chunk expects at least a 1-dimensional tensor'.
    """
    sd = {"blk.qkv.weight_scale": torch.tensor(1.5)}  # 0-dim scalar
    _remap_qkv("blk.qkv.weight_scale", sd)  # must not raise
    assert sd == {}, "non-chunkable qkv tensor should be dropped, not split"

    # a real fused qkv weight still splits correctly
    sd2 = {"blk.qkv.weight": torch.randn(9, 4)}
    _remap_qkv("blk.qkv.weight", sd2)
    assert sorted(sd2.keys()) == ["blk.to_k.weight", "blk.to_q.weight", "blk.to_v.weight"]
