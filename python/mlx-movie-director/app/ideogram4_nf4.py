"""Pure-MLX NF4 dequantization for Ideogram 4 — fork-free.

Stock mlx has no NF4 quantization mode (`nn.QuantizedLinear(mode="nf4")` raises
`KeyError: 'nf4'`; `mx.quantize(mode="nf4")` raises `ValueError`). NF4 lives only
in the `lyonsno/mlx@nf4` fork. We cannot install that fork in the shared
`python/venv` (it would shadow stock mlx and break zimage/flux2/lens/ltx), so we
dequant NF4 ourselves with stock ops.

NF4 is simply a FIXED 16-value normal-float codebook (levels in [-1, 1]) scaled
per 64-element group by an `absmax`. Dequant = `codebook[index] * absmax_group`.
The fork only exists to fuse that dequant into a Metal matmul kernel; we do it
unfused (gather + scale) — correct, fork-free, and cheap relative to the matmul.

This module is the single fork-decoupling point. A Plan-agent audit confirmed
the reference's ENTIRE fork dependency is exactly two `nn.QuantizedLinear(...,
mode="nf4")` call sites (`load_weights.py:179` for the transformer,
`load_text_encoder.py:194` for the text encoder). Replacing them with `NF4Linear`
fully decouples the port — everything else (transformer.py / vae.py / scheduler.py
/ the bnb nibble repack / MRoPE / LATENT constants) is stock-movable.
"""

from __future__ import annotations

import json
import time

import mlx.core as mx
import mlx.nn as nn
import numpy as np
from safetensors import safe_open

# QLoRA NF4 codebook: the 16 normal-float levels in [-1, 1]. A weight group is
# absmax-normalized, quantized to these levels, and stored alongside its per-group
# absmax; dequant reconstructs `level * absmax`. These are the canonical bitsandbytes
# NF4 levels (the reference discards the stored `quant_map` and relies on the fork's
# hardcoded copy — which equals these). If a live generation ever looks corrupt,
# this codebook is the first thing to diff against the fork.
NF4_CODEBOOK = mx.array(
    [
        -1.0,
        -0.6961928,
        -0.52507305,
        -0.3949175,
        -0.28444138,
        -0.18477343,
        -0.09105004,
        0.0,
        0.0795803,
        0.1609302,
        0.2461123,
        0.33791524,
        0.44070983,
        0.562617,
        0.72295684,
        1.0,
    ],
    dtype=mx.float32,
)


class NF4Linear(nn.Module):
    """Drop-in pure-MLX NF4 layer; replaces `nn.QuantizedLinear(mode="nf4")`.

    Storage (mirrors the reference's mlx uint32 pack so we load bitsandbytes NF4
    safetensors directly, with no conversion):

      - ``weight``: ``uint32 [out, in // 8]`` — 8 nibble indices per uint32, packed
        at shifts 0, 4, ..., 28 (index 0 in the LOW nibble, matching
        `_repack_bnb_nf4_to_mlx`).
      - ``scales``: ``float32 [out, in // group_size]`` — one `absmax` per block of
        64 input elements.
      - ``bias``: optional ``bfloat16 [out]``.
    """

    def __init__(self, input_dims: int, output_dims: int, bias: bool = True,
                 group_size: int = 64):
        super().__init__()
        if input_dims % 8 != 0:
            raise ValueError(
                f"NF4Linear input_dims={input_dims} must be divisible by 8 "
                "(8 nibbles per uint32)."
            )
        if input_dims % group_size != 0:
            raise ValueError(
                f"NF4Linear input_dims={input_dims} must be divisible by "
                f"group_size={group_size}."
            )
        self.input_dims = input_dims
        self.output_dims = output_dims
        self.group_size = group_size
        self.weight = mx.zeros((output_dims, input_dims // 8), dtype=mx.uint32)
        self.scales = mx.zeros((output_dims, input_dims // group_size), dtype=mx.float32)
        self.bias = mx.zeros((output_dims,), dtype=mx.bfloat16) if bias else None

    def _dequant(self) -> mx.array:
        """Reconstruct the full ``float32 [out, in]`` weight: codebook[idx] * absmax."""
        shifts = mx.arange(0, 32, 4, dtype=mx.uint32)  # [8]
        # Unpack 8 nibbles per uint32 → [out, in] int32 indices in [0, 15].
        idx = (self.weight[..., None] >> shifts) & mx.array(0x0F, dtype=mx.uint32)
        idx = idx.reshape(self.output_dims, self.input_dims).astype(mx.int32)
        # Gather codebook values ([-1, 1]) then scale per 64-element group.
        wq = mx.take(NF4_CODEBOOK, idx)  # [out, in] float32
        scales = mx.repeat(self.scales, self.group_size, axis=1)  # [out, in]
        return wq * scales

    def __call__(self, x: mx.array) -> mx.array:
        # Blocksize-aligned input_dims (NF4 groups are 64-wide). bitsandbytes pads
        # non-aligned weights with zeros before quantizing, so a padded layer has
        # input_dims > the true feature count; zero-pad the input to match — the
        # padded weight cols dequant to ~0, so they contribute nothing and the
        # matmul equals the original unpadded one. Needed for Qwen3-VL visual blocks
        # (e.g. in_dim 4304) — dormant in the text-only ideogram flow, but correct
        # regardless.
        if x.shape[-1] != self.input_dims:
            pad = self.input_dims - x.shape[-1]
            x = mx.pad(x, [(0, 0)] * (x.ndim - 1) + [(0, pad)])
        w = self._dequant().astype(x.dtype)
        out = x @ w.T
        if self.bias is not None:
            out = out + self.bias
        return out


def _repack_bnb_nf4_to_mlx(packed_uint8: np.ndarray, orig_shape: list[int]) -> np.ndarray:
    """Convert bitsandbytes NF4 packed uint8 -> MLX uint32 (8 nibbles per uint32).

    bitsandbytes packs two 4-bit indices per byte: the HIGH nibble is the first
    element, the LOW nibble the second. We interleave [hi, lo] (preserving that
    order) then pack 8 indices into each uint32 at shifts 0, 4, ..., 28.

    NOTE: the reference's text-encoder col-padding branch (load_text_encoder.py:92)
    interleave is [lo, hi] — the OPPOSITE order, a latent bug. It never fires in
    practice (Qwen3-VL / Ideogram4 Linear in_dims are all 64-aligned, so the
    non-padding path is taken), but we use the correct [hi, lo] order here
    consistently and reject non-aligned dims rather than inherit that bug.
    """
    flat = packed_uint8.ravel()
    lo = flat & 0x0F
    hi = (flat >> 4) & 0x0F
    indices = np.stack([hi, lo], axis=-1).ravel().astype(np.uint32)
    rows, cols = orig_shape
    indices_grouped = indices.reshape(-1, 8)
    shifts = np.array([0, 4, 8, 12, 16, 20, 24, 28], dtype=np.uint32)
    packed_u32 = np.sum(indices_grouped << shifts, axis=1).astype(np.uint32)
    return packed_u32.reshape(rows, cols // 8)


def _sanitize_text_encoder_key(k: str) -> str:
    """Map a bitsandbytes safetensors key to the mlx-vlm Qwen3-VL module key.

    ``language_model.X``      -> ``language_model.model.X``
    ``visual.X``              -> ``vision_tower.X``
    """
    if k.startswith("language_model."):
        return f"language_model.model.{k[len('language_model.'):]}"
    if k.startswith("visual."):
        return k.replace("visual.", "vision_tower.", 1)
    return k


def _swap_to_nf4_linear(model: nn.Module, path: str, in_dims: int, out_dims: int,
                       group_size: int = 64) -> None:
    """Replace the ``nn.Linear`` at dotted ``path`` with an ``NF4Linear``."""
    parts = path.split(".")
    parent: nn.Module = model
    for p in parts[:-1]:
        parent = parent[int(p)] if p.isdigit() else getattr(parent, p)
    leaf = parts[-1]
    old = getattr(parent, leaf) if not leaf.isdigit() else parent[int(leaf)]
    has_bias = isinstance(old, nn.Linear) and getattr(old, "bias", None) is not None
    nl = NF4Linear(in_dims, out_dims, bias=has_bias, group_size=group_size)
    if leaf.isdigit():
        parent[int(leaf)] = nl
    else:
        setattr(parent, leaf, nl)


def load_nf4_weights(safetensors_path: str, model: nn.Module, *,
                     sanitize_key: bool = False, verbose: bool = True) -> None:
    """Load bitsandbytes-NF4 safetensors into ``model``, swapping Linears -> NF4Linear.

    Fork-free equivalent of the reference's ``load_nf4_transformer`` /
    ``load_nf4_text_encoder`` (the two singular fork-coupling sites). Set
    ``sanitize_key=True`` for the Qwen3-VL text encoder (applies the
    ``language_model.``/``visual.`` remap); leave False for the Ideogram4
    transformer (its keys are already correct).
    """
    t0 = time.perf_counter()
    sanitize = _sanitize_text_encoder_key if sanitize_key else (lambda k: k)

    quantized_layers: dict[str, tuple[mx.array, mx.array, int]] = {}
    regular_tensors: dict[str, mx.array] = {}

    with safe_open(safetensors_path, framework="numpy") as sf:
        keys = set(sf.keys())
        quantized_bases = {
            k.split(".quant_state.bitsandbytes__nf4")[0]
            for k in keys
            if ".quant_state.bitsandbytes__nf4" in k
        }

        for base in sorted(quantized_bases):
            meta_key = f"{base}.quant_state.bitsandbytes__nf4"
            absmax_key = f"{base}.absmax"
            if meta_key not in keys or absmax_key not in keys:
                continue
            meta = json.loads(sf.get_tensor(meta_key).tobytes().decode("utf-8"))
            if meta.get("nested", False):
                raise NotImplementedError(
                    f"Double quantization (nested absmax) unsupported for {base}. "
                    "Re-quantize with compress_statistics=False."
                )
            rows, cols = meta["shape"]
            blocksize = meta.get("blocksize", 64)
            packed = sf.get_tensor(base)
            absmax = sf.get_tensor(absmax_key)
            if cols % blocksize != 0:
                # bitsandbytes pads non-blocksize-aligned weights with zeros before
                # quantizing (e.g. Qwen3-VL visual blocks, in_dim 4304). Repack the
                # nibble indices to the padded width and pad absmax to match. The
                # NF4Linear zero-pads its input to input_dims, so the padded weight
                # cols (which dequant to ~0) contribute nothing — the result equals
                # the original unpadded matmul. (The reference's text-encoder padding
                # branch used [lo,hi] nibble order — a latent bug; we use [hi,lo].)
                cols_padded = ((cols + blocksize - 1) // blocksize) * blocksize
                flat = packed.ravel()
                lo = flat & 0x0F
                hi = (flat >> 4) & 0x0F
                indices = np.stack([hi, lo], axis=-1).ravel().astype(np.uint32)
                total = rows * cols_padded
                if len(indices) < total:
                    indices = np.pad(indices, (0, total - len(indices)))
                else:
                    indices = indices[:total]
                grouped = indices.reshape(-1, 8)
                shifts = np.array([0, 4, 8, 12, 16, 20, 24, 28], dtype=np.uint32)
                mlx_packed = (
                    np.sum(grouped << shifts, axis=1)
                    .astype(np.uint32)
                    .reshape(rows, cols_padded // 8)
                )
                n_groups = cols_padded // blocksize
                total_groups = rows * n_groups
                if absmax.size < total_groups:
                    absmax = np.pad(absmax, (0, total_groups - absmax.size))
                absmax_reshaped = absmax[:total_groups].reshape(rows, n_groups)
            else:
                mlx_packed = _repack_bnb_nf4_to_mlx(packed, [rows, cols])
                absmax_reshaped = absmax.reshape(rows, cols // blocksize)
            quantized_layers[base] = (mx.array(mlx_packed), mx.array(absmax_reshaped), blocksize)

        consumed = set()
        for base in quantized_bases:
            consumed.add(base)
            for suffix in (".absmax", ".quant_map", ".nested_absmax", ".nested_quant_map",
                           ".nested_scale_offset", ".quant_state.bitsandbytes__nf4"):
                consumed.add(base + suffix)

        # Non-quantized tensors (norms, embeddings, biases) — load via numpy first,
        # fall back to mlx.load for bf16 (numpy can't hold bf16).
        for k in sorted(keys - consumed):
            try:
                regular_tensors[k] = mx.array(sf.get_tensor(k))
            except (TypeError, ValueError):
                pass

    remaining = sorted((keys - consumed) - set(regular_tensors.keys()))
    if remaining:
        bf16_weights = mx.load(safetensors_path)
        for k in remaining:
            if k in bf16_weights:
                regular_tensors[k] = bf16_weights[k]

    if verbose:
        print(
            f"  [NF4] Parsed {len(quantized_layers)} quantized + "
            f"{len(regular_tensors)} regular tensors ({time.perf_counter() - t0:.1f}s)",
            flush=True,
        )

    weight_pairs: list[tuple[str, mx.array]] = []
    for base, (wq, scales, blocksize) in quantized_layers.items():
        module_path = sanitize(base[:-7] if base.endswith(".weight") else base)
        out_dims, in_dims_packed = wq.shape
        in_dims = in_dims_packed * 8
        _swap_to_nf4_linear(model, module_path, in_dims, out_dims, blocksize)
        weight_pairs.append((f"{module_path}.weight", wq))
        weight_pairs.append((f"{module_path}.scales", scales))
        bias_key = base.replace(".weight", ".bias") if base.endswith(".weight") else f"{base}.bias"
        if bias_key in regular_tensors:
            weight_pairs.append((sanitize(bias_key), regular_tensors.pop(bias_key)))

    for k, v in regular_tensors.items():
        weight_pairs.append((sanitize(k), v))

    model.load_weights(weight_pairs, strict=False)
    if verbose:
        print(
            f"  [NF4] Loaded {len(weight_pairs)} weight entries "
            f"({time.perf_counter() - t0:.1f}s)",
            flush=True,
        )
