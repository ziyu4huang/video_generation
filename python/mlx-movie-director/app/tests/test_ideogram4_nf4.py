"""Correctness tests for the fork-free NF4 dequant (app.ideogram4_nf4).

These guard the single most error-prone part of the Ideogram 4 port: the
hand-rolled NF4 dequant that replaces the fork's `nn.QuantizedLinear(mode="nf4")`.
A nibble-order or codebook bug silently corrupts every weight and produces
garbage images with no runtime error, so the round-trip / exact-vs-numpy checks
here are the safety net. CPU + MLX only (no real model weights).
"""

import json

import mlx.core as mx
import mlx.nn as nn
import numpy as np
import pytest
from safetensors.numpy import save_file

from app.ideogram4_nf4 import (
    NF4_CODEBOOK,
    NF4Linear,
    _repack_bnb_nf4_to_mlx,
    load_nf4_weights,
)

# Matches NF4_CODEBOOK but as an independent numpy constant (so a bug in the
# module's codebook values is caught, not hidden by sharing the same array).
_NF4_CODEBOOK_NP = np.array(
    [
        -1.0, -0.6961928, -0.52507305, -0.3949175,
        -0.28444138, -0.18477343, -0.09105004, 0.0,
        0.0795803, 0.1609302, 0.2461123, 0.33791524,
        0.44070983, 0.562617, 0.72295684, 1.0,
    ],
    dtype=np.float32,
)

_SHIFTS = np.array([0, 4, 8, 12, 16, 20, 24, 28], dtype=np.uint32)


def _pack_indices_to_uint32(idx_2d: np.ndarray) -> np.ndarray:
    """[out, in] int indices -> [out, in//8] uint32 (index 0 in the LOW nibble).

    This is the inverse of `_repack_bnb_nf4_to_mlx`'s final pack step, written
    independently so the test is not circular.
    """
    out_d, in_d = idx_2d.shape
    grouped = idx_2d.reshape(out_d, -1, 8).astype(np.uint32)
    return np.sum(grouped << _SHIFTS, axis=2).astype(np.uint32)


def test_nf4_codebook_sanity():
    cb = np.array(NF4_CODEBOOK)
    assert cb.shape == (16,)
    assert cb.dtype == np.float32
    assert cb.min() == -1.0 and cb.max() == 1.0
    # Monotonic non-decreasing (NF4 levels are ordered).
    assert np.all(np.diff(cb) >= 0)


def test_repack_preserves_element_order():
    """bnb packs 2 indices/byte (high nibble = first element). _repack must
    recover the original element order when unpacked."""
    out_d, in_d = 2, 16
    idx = (np.arange(out_d * in_d, dtype=np.int32).reshape(out_d, in_d)) % 16
    # Build bnb uint8 bytes independently: byte = (even << 4) | odd.
    flat = idx.reshape(out_d, in_d // 2, 2)
    packed_bytes = ((flat[:, :, 0].astype(np.uint32) << 4)
                    | flat[:, :, 1].astype(np.uint32)).astype(np.uint8)
    u32 = _repack_bnb_nf4_to_mlx(packed_bytes.reshape(-1), [out_d, in_d])
    # Unpack the uint32 the same way _dequant does and compare to the original.
    recovered = ((u32[..., None] >> _SHIFTS) & 0x0F).reshape(out_d, in_d)
    np.testing.assert_array_equal(recovered, idx)


def test_nf4_dequant_matches_numpy():
    """_dequant() must equal codebook[idx] * per-group absmax (independent numpy)."""
    out_d, in_d, gs = 8, 128, 64
    rng = np.random.default_rng(0)
    idx = rng.integers(0, 16, size=(out_d, in_d), dtype=np.int32)
    absmax = (rng.random((out_d, in_d // gs)) + 0.1).astype(np.float32)
    expected = _NF4_CODEBOOK_NP[idx] * np.repeat(absmax, gs, axis=1)  # [out, in]

    layer = NF4Linear(in_d, out_d, bias=False, group_size=gs)
    layer.weight = mx.array(_pack_indices_to_uint32(idx))
    layer.scales = mx.array(absmax)
    got = np.array(layer._dequant())
    assert got.shape == (out_d, in_d)
    # Tight tolerance: catches any indexing/packing/codebook bug (which give
    # |diff| >> 0.1) while tolerating last-bit mx-vs-numpy fp32 rounding.
    np.testing.assert_allclose(got, expected, rtol=1e-6, atol=1e-6)


def test_nf4_linear_forward_matches_numpy():
    """Full forward (dequant + matmul) matches an independent numpy reference."""
    out_d, in_d, gs = 6, 128, 64
    rng = np.random.default_rng(1)
    idx = rng.integers(0, 16, size=(out_d, in_d), dtype=np.int32)
    absmax = (rng.random((out_d, in_d // gs)) + 0.1).astype(np.float32)
    w_full = _NF4_CODEBOOK_NP[idx] * np.repeat(absmax, gs, axis=1)  # [out, in] fp32

    layer = NF4Linear(in_d, out_d, bias=False, group_size=gs)
    layer.weight = mx.array(_pack_indices_to_uint32(idx))
    layer.scales = mx.array(absmax)

    x_np = rng.standard_normal((2, 5, in_d)).astype(np.float32)  # [B, L, in]
    expected = x_np @ w_full.T  # [B, L, out]
    got = np.array(layer(mx.array(x_np)))
    assert got.shape == (2, 5, out_d)
    # The dequant weight is bit-exact (test_nf4_dequant_matches_numpy); the only
    # slack here is fp32 matmul-accumulation order differing between numpy (sgemm)
    # and mlx (~1% on a 128-dim dot product). Loose tolerance still catches any
    # wiring/codebook bug (which gives diffs >> 0.5).
    np.testing.assert_allclose(got, expected, rtol=5e-2, atol=5e-2)


def test_nf4_linear_bias_applied():
    """bias=True adds the bias vector to the output."""
    out_d, in_d, gs = 4, 64, 64
    layer = NF4Linear(in_d, out_d, bias=True, group_size=gs)
    layer.bias = mx.array(np.arange(out_d, dtype=np.float32))
    x = mx.zeros((1, 3, in_d), dtype=mx.float32)
    out = np.array(layer(x))  # zero input -> output is just the broadcast bias
    np.testing.assert_allclose(out, np.broadcast_to(np.arange(out_d, dtype=np.float32), (1, 3, out_d)),
                               rtol=1e-5, atol=1e-6)


class _TinyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.lin = nn.Linear(128, 16, bias=True)


def _write_bnb_nf4_safetensors(path, base="lin.weight", out_d=16, in_d=128, blocksize=64):
    """Write a minimal bitsandbytes-NF4 safetensors mirroring the ideogram-4 layout.

    Real bnb layout: the packed weight data, its absmax, and its quant_state all
    share the SAME base key (the full weight path incl. ``.weight``):
      ``<base>``                              -> packed uint8 data
      ``<base>.absmax``                       -> per-group absmax (flat)
      ``<base>.quant_state.bitsandbytes__nf4``-> json metadata (uint8 bytes)
    """
    rng = np.random.default_rng(42)
    idx = rng.integers(0, 16, size=(out_d, in_d), dtype=np.uint32)
    n_groups = in_d // blocksize
    absmax = (rng.random(out_d * n_groups) + 0.1).astype(np.float32)
    bias = rng.standard_normal(out_d).astype(np.float32)
    # bnb uint8: byte = (even_index << 4) | odd_index.
    flat = idx.reshape(out_d, in_d // 2, 2)
    packed_bytes = ((flat[:, :, 0].astype(np.uint32) << 4)
                    | flat[:, :, 1].astype(np.uint32)).astype(np.uint8)  # [out, in//2]
    meta = {"shape": [out_d, in_d], "blocksize": blocksize, "nested": False,
            "quantized": True, "quant_type": "nf4", "dtype": "float32"}
    meta_bytes = np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8)
    save_file(
        {
            base: packed_bytes,
            f"{base}.absmax": absmax,
            f"{base}.quant_state.bitsandbytes__nf4": meta_bytes,
            base.replace(".weight", ".bias"): bias,
        },
        path,
    )
    expected_w = _NF4_CODEBOOK_NP[idx.astype(np.int32)] * np.repeat(
        absmax.reshape(out_d, n_groups), blocksize, axis=1
    )
    return expected_w, bias


def test_load_nf4_weights_synthetic(tmp_path):
    """End-to-end load: bnb-NF4 safetensors -> NF4Linear swap -> correct dequant."""
    path = str(tmp_path / "tiny.safetensors")
    expected_w, bias = _write_bnb_nf4_safetensors(path)

    model = _TinyModel()
    load_nf4_weights(path, model, sanitize_key=False, verbose=False)

    assert isinstance(model.lin, NF4Linear), "nn.Linear was not swapped to NF4Linear"
    assert model.lin.input_dims == 128 and model.lin.output_dims == 16
    got_w = np.array(model.lin._dequant())
    np.testing.assert_allclose(got_w, expected_w, rtol=1e-6, atol=1e-6)
    np.testing.assert_allclose(np.array(model.lin.bias), bias, rtol=1e-5, atol=1e-6)
