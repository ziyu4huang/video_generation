#!/usr/bin/env python3
"""Convert gpt_oss_20b_nvfp4.safetensors → MLX INT4 safetensors.

The source file uses ComfyUI's NVFP4 quantization:
    {layer}.weight          uint8 packed FP4 (2 values per byte)
    {layer}.weight_scale    float8_e4m3fn block scales (blocked layout)
    {layer}.weight_scale_2  float32 per-tensor scale
    {layer}.comfy_quant     JSON: {"format": "nvfp4", ...}

This script:
1. Loads the safetensors on CPU (comfy_kitchen eager backend is CUDA-free)
2. Dequantizes NVFP4 → BF16 layer-by-layer (avoids 40GB RAM peak)
3. Splits 3D MoE expert banks [E, O, I] → per-expert 2D arrays [O, I]
4. Applies MLX INT4 quantization (group_size=32, bits=4) → ~12GB output
5. Saves to <output_dir>/model.safetensors

Usage:
    python/venv/bin/python python/mlx-movie-director/scripts/convert_lens_te_mlx.py \\
        --src comfyui_data/models/text_encoders/gpt_oss_20b_nvfp4.safetensors \\
        --dst python/mlx-movie-director/models/text_encoder/gpt-oss-20b \\
        --bits 4
"""

import argparse
import gc
import json
import os
import sys

import torch
from safetensors.torch import load_file as load_pt_file
from tqdm import tqdm

# Add ComfyUI to path so comfy_kitchen is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../ComfyUI"))

import comfy_kitchen as ck
import mlx.core as mx
import mlx.nn as mnn


# ---------------------------------------------------------------------------
# NVFP4 dequantize helpers
# ---------------------------------------------------------------------------

def _dequant_nvfp4(weight_u8: torch.Tensor, block_scale: torch.Tensor,
                   per_tensor_scale: torch.Tensor, orig_shape: tuple) -> torch.Tensor:
    """Dequantize a single NVFP4 weight tensor to BF16 on CPU.

    Works via comfy_kitchen eager backend — no CUDA required.

    For 3D MoE weights [E, out, in//2]: processes each expert slice separately.
    For 2D standard weights [out, in//2]: dequantizes in one call.
    """
    if weight_u8.dim() == 3:
        E = weight_u8.shape[0]
        results = []
        for ei in range(E):
            w_slice = weight_u8[ei]          # [out, in//2]
            bs_slice = block_scale[ei]       # [out, in//16] fp8 block scales
            pts = per_tensor_scale[ei] if per_tensor_scale.dim() > 0 else per_tensor_scale
            pts = pts.reshape(1) if pts.dim() == 0 else pts
            dq = ck.dequantize_nvfp4(w_slice.cpu(), pts.cpu(), bs_slice.cpu(), torch.bfloat16)
            results.append(dq)
        return torch.stack(results, dim=0)   # [E, out, in]

    per_tensor_scale = per_tensor_scale.reshape(1) if per_tensor_scale.dim() == 0 else per_tensor_scale
    return ck.dequantize_nvfp4(
        weight_u8.cpu(), per_tensor_scale.cpu(), block_scale.cpu(), torch.bfloat16
    )


def _trim_to_orig(tensor: torch.Tensor, orig_shape: tuple) -> torch.Tensor:
    """Trim any alignment padding added by NVFP4 (pads to 16-element boundaries)."""
    if tensor.shape == tuple(orig_shape):
        return tensor
    slices = tuple(slice(0, s) for s in orig_shape)
    return tensor[slices]


# ---------------------------------------------------------------------------
# MoE bank split
# ---------------------------------------------------------------------------

def _split_moe_banks(mlx_weights: dict) -> dict:
    """Split 3D MoE expert banks → per-expert 2D arrays.

    Original key: layers.N.mlp.experts.gate_up_proj.weight  [E, O, I]
    Output keys:  layers.N.mlp.experts.gate_up_proj.{0..E-1}.weight  [O, I]

    Same for .bias, .down_proj.weight, .down_proj.bias.
    """
    result = {}
    for key, val in mlx_weights.items():
        parts = key.split(".")
        # layers.N.mlp.experts.{gate_up_proj,down_proj}.{weight,bias}
        if (
            len(parts) == 6
            and parts[0] == "layers"
            and parts[1].isdigit()
            and parts[2] == "mlp"
            and parts[3] == "experts"
            and parts[4] in ("gate_up_proj", "down_proj")
            and parts[5] in ("weight", "bias")
        ):
            E = val.shape[0]
            prefix = ".".join(parts[:5])
            suffix = parts[5]
            for ei in range(E):
                result[f"{prefix}.{ei}.{suffix}"] = val[ei]
        else:
            result[key] = val
    return result


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------

def convert_lens_te(src: str, dst_dir: str, bits: int = 4, group_size: int = 32) -> bool:
    """Convert gpt_oss_20b_nvfp4.safetensors → MLX quantized safetensors.

    Returns True on success.
    """
    os.makedirs(dst_dir, exist_ok=True)
    out_path = os.path.join(dst_dir, "model.safetensors")

    if not os.path.exists(src):
        print(f"[lens-te] ERROR: source not found: {src}")
        return False

    print(f"[lens-te] Loading {src} (streaming header first)...")
    raw = load_pt_file(src, device="cpu")
    print(f"[lens-te] Loaded {len(raw)} tensors")

    # ── Step 1: Identify NVFP4 layers ─────────────────────────────────────────
    quant_layers: dict[str, dict] = {}
    for key in raw:
        if key.endswith(".comfy_quant"):
            prefix = key[: -len(".comfy_quant")]
            try:
                info = json.loads(bytes(raw[key].tolist()).decode("utf-8"))
                quant_layers[prefix] = info
            except Exception as e:
                print(f"[lens-te] Warning: bad comfy_quant for {prefix}: {e}")

    nvfp4_layers = {k: v for k, v in quant_layers.items() if v.get("format") == "nvfp4"}
    print(f"[lens-te] NVFP4 layers to dequantize: {len(nvfp4_layers)}")

    # ── Step 2: Keys to omit from output ──────────────────────────────────────
    skip_meta_suffixes = (".weight_scale", ".weight_scale_2", ".comfy_quant")
    skip_keys: set[str] = set()
    skip_keys.add("tokenizer_json")
    for prefix in nvfp4_layers:
        for suf in skip_meta_suffixes:
            skip_keys.add(prefix + suf)

    # ── Step 3: Dequantize layer by layer ─────────────────────────────────────
    mlx_weights: dict[str, mx.array] = {}
    all_keys = [k for k in raw if k not in skip_keys]
    print(f"[lens-te] Processing {len(all_keys)} tensors...")

    for key in tqdm(all_keys, unit="key"):
        tensor = raw[key]

        # Check if this is the .weight of an NVFP4 layer
        if key.endswith(".weight"):
            candidate = key[: -len(".weight")]
            if candidate in nvfp4_layers:
                bskey = candidate + ".weight_scale"
                ptskey = candidate + ".weight_scale_2"
                if bskey in raw and ptskey in raw:
                    info = nvfp4_layers[candidate]
                    orig_shape = info.get("orig_shape")
                    try:
                        arr = _dequant_nvfp4(tensor, raw[bskey], raw[ptskey], orig_shape)
                        if orig_shape is not None:
                            arr = _trim_to_orig(arr, tuple(orig_shape))
                    except Exception as e:
                        print(f"[lens-te] WARNING dequant failed for {candidate}: {e}")
                        arr = tensor.to(torch.bfloat16)
                else:
                    print(f"[lens-te] Warning: missing scales for {candidate}, skipping quant")
                    arr = tensor.to(torch.bfloat16)
                np_val = arr.detach().cpu().float().numpy()
                mlx_weights[key] = mx.array(np_val).astype(mx.bfloat16)
                del arr
                gc.collect()
                continue

        # Non-NVFP4 tensor
        if isinstance(tensor, torch.Tensor):
            if tensor.dtype in (torch.float8_e4m3fn, torch.float8_e5m2):
                arr = tensor.to(torch.bfloat16)
            elif not tensor.is_floating_point():
                # integer tensors (e.g. router weight int? unlikely — skip if not float)
                arr = tensor.float()
            else:
                arr = tensor.to(torch.bfloat16)
            np_val = arr.detach().cpu().float().numpy()
            mlx_weights[key] = mx.array(np_val).astype(mx.bfloat16)
            del arr

    del raw
    gc.collect()
    print(f"[lens-te] Dequantized → {len(mlx_weights)} BF16 tensors")

    # ── Step 4: Split 3D MoE banks into per-expert 2D arrays ──────────────────
    print(f"[lens-te] Splitting MoE expert banks...")
    mlx_weights = _split_moe_banks(mlx_weights)
    print(f"[lens-te] After split: {len(mlx_weights)} tensors")
    gc.collect()

    # ── Step 5: Load into MLX model and quantize ───────────────────────────────
    print(f"[lens-te] Applying MLX {bits}-bit quantization (group_size={group_size})...")
    te_dir = os.path.join(os.path.dirname(__file__), "..")
    sys.path.insert(0, te_dir)
    from app.lens_text_encoder import LensGptOssEncoder

    model = LensGptOssEncoder()
    # File keys are top-level (embed_tokens.*, layers.N.*, norm.*).
    # LensGptOssEncoder wraps GptOssModel as self.transformer → prefix all keys.
    prefixed = {f"transformer.{k}": v for k, v in mlx_weights.items()}
    del mlx_weights
    gc.collect()

    model.load_weights(list(prefixed.items()))
    del prefixed
    mx.eval(model.parameters())
    gc.collect()

    # Quantize all mnn.Linear modules (includes per-expert Linear in MoE banks)
    # MLX class_predicate signature is (name: str, module: Module) — name first
    def _quant_pred(name, module):
        if not isinstance(module, mnn.Linear):
            return False
        w = module.weight
        return w.ndim == 2 and w.shape[0] >= 64 and w.shape[1] >= 64

    mnn.quantize(model, bits=bits, group_size=group_size, class_predicate=_quant_pred)
    mx.eval(model.parameters())

    # ── Step 6: Save ───────────────────────────────────────────────────────────
    from mlx.utils import tree_flatten

    print(f"[lens-te] Saving to {out_path}...")
    weights_flat = dict(tree_flatten(model.parameters()))
    mx.save_safetensors(out_path, weights_flat)

    size_gb = os.path.getsize(out_path) / 1e9
    print(f"[lens-te] Done. {len(weights_flat)} tensors → {size_gb:.2f} GB")
    return True


def main():
    parser = argparse.ArgumentParser(description="Convert GPT-OSS-20B NVFP4 → MLX INT4")
    parser.add_argument("--src", required=True,
                        help="Path to gpt_oss_20b_nvfp4.safetensors")
    parser.add_argument("--dst", required=True,
                        help="Output directory")
    parser.add_argument("--bits", type=int, default=4, choices=[4, 8],
                        help="MLX quantization bits (default 4)")
    parser.add_argument("--group-size", type=int, default=32)
    args = parser.parse_args()

    ok = convert_lens_te(args.src, args.dst, args.bits, args.group_size)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
