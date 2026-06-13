#!/usr/bin/env python3
"""Convert LoRA safetensors from bf16/fp16/fp32 to int8 quantized format.

Saves ~44% disk space via per-tensor int8 quantization with per-tensor
scale (max-abs quantization). Output is standard safetensors — the int8
tensors and float32 scales are stored as separate keys so any safetensors
loader can read them.

Usage:
    python/venv/bin/python scripts/convert_lora_mlx.py \\
        --name ltx-2.3-distilled

    # Convert all pending LoRA candidates
    python/venv/bin/python scripts/convert_lora_mlx.py --all
"""

import argparse
import gc
import json
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mlx.core as mx

from app import config as cfg


def _quantize_tensor(arr: mx.array) -> tuple[mx.array, mx.array]:
    """Quantize a float array to int8 with per-tensor max-abs scaling.

    Returns:
        (tensor_int8, scale) where:
            tensor_int8 is an mx.int8 array.
            scale is an mx.float32 scalar (use tensor_float = int8 * scale).
    """
    arr_f32 = arr.astype(mx.float32)
    max_val = mx.max(mx.abs(arr_f32))
    # Guard against zero tensors
    max_val = mx.clip(max_val, 1e-12, float("inf"))
    scale = max_val / 127.0
    q = mx.clip(mx.round(arr_f32 / scale), -128, 127).astype(mx.int8)
    return q, scale.astype(mx.float32)


def _lora_instance_dir(name: str) -> str:
    """Return the full path to a LoRA instance directory."""
    return os.path.join(cfg.MODELS_DIR, "lora", name)


def _find_weight_files(instance_dir: str) -> list[str]:
    """Find .safetensors weight files in a LoRA instance dir (excluding .int8 copies)."""
    files = []
    for f in sorted(os.listdir(instance_dir)):
        if f.endswith(".safetensors") and not f.endswith(".int8.safetensors"):
            path = os.path.join(instance_dir, f)
            if os.path.isfile(path):
                files.append(path)
    return files


def _needs_conversion(path: str) -> bool:
    """Check if a safetensors file contains quantized int8 weights already.

    Reads the first few keys from the file header (no full load) and returns
    True if they need conversion (i.e. are float types, not int8).
    """
    import struct

    try:
        with open(path, "rb") as f:
            # Read header length (8 bytes, little-endian 64-bit)
            header_len = struct.unpack("<Q", f.read(8))[0]
            header_bytes = f.read(header_len)
            header = json.loads(header_bytes)
            # Check first few keys for dtype
            for i, (key, meta) in enumerate(header.items()):
                if i >= 5:  # sample first 5 keys
                    break
                dtype = meta.get("dtype", "")
                if dtype == "I8":  # Already int8 quantized format
                    return False
            return True
    except Exception:
        # If we can't read the header, assume conversion needed
        return True


def _get_or_create_manifest(instance_dir: str, name: str) -> dict:
    """Load existing manifest or create a minimal one."""
    manifest_path = os.path.join(instance_dir, "manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            return json.load(f)
    return {
        "name": name,
        "type": "lora",
        "format": "unknown",
        "size_bytes": 0,
        "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def convert_lora_instance(name: str, verbose: bool = True) -> None:
    """Convert all .safetensors files in a LoRA instance to int8 quantized.

    Creates new files alongside the originals (e.g. ``model.int8.safetensors``)
    and updates manifest.json.
    """
    instance_dir = _lora_instance_dir(name)
    if not os.path.isdir(instance_dir):
        print(f"[convert-lora] ERROR: Instance not found: {instance_dir}")
        return

    weight_files = _find_weight_files(instance_dir)
    if not weight_files:
        print(f"[convert-lora] No weight files found in {instance_dir}")
        return

    manifest = _get_or_create_manifest(instance_dir, name)
    total_src = 0
    total_dst = 0

    for src_path in weight_files:
        src_size = os.path.getsize(src_path)
        dst_path = src_path.replace(".safetensors", ".int8.safetensors")

        if os.path.exists(dst_path) and not _needs_conversion(dst_path):
            if verbose:
                print(f"  [SKIP] {os.path.basename(src_path)} — already converted")
            total_src += src_size
            total_dst += os.path.getsize(dst_path)
            continue

        if not _needs_conversion(src_path):
            if verbose:
                print(f"  [SKIP] {os.path.basename(src_path)} — already int8")
            total_src += src_size
            total_dst += os.path.getsize(dst_path) if os.path.exists(dst_path) else src_size
            continue

        if verbose:
            print(f"  Converting {os.path.basename(src_path)} ({src_size / 1024**3:.1f} GB)...")

        # Load weights with MLX
        weights = mx.load(src_path)
        n_tensors = len(weights)
        if verbose:
            print(f"    Loaded {n_tensors} tensors")

        # Quantize each tensor
        quantized = {}
        for key, arr in weights.items():
            q, scale = _quantize_tensor(arr)
            quantized[key] = q
            quantized[f"{key}.scale"] = scale

        # Save quantized weights
        mx.save_safetensors(dst_path, quantized)
        dst_size = os.path.getsize(dst_path)

        # Cleanup
        del weights, quantized
        gc.collect()

        saving = (1 - dst_size / src_size) * 100 if src_size > 0 else 0
        if verbose:
            print(f"    Saved: {dst_size / 1024**3:.1f} GB ({saving:.0f}% savings)")

        total_src += src_size
        total_dst += dst_size

    # Update manifest
    manifest["format"] = "mlx-int8"
    manifest["size_bytes"] = total_dst
    manifest["created_at"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    if "converted_from" not in manifest:
        manifest["converted_from"] = {
            "format": "safetensors-bf16",
            "size_bytes": total_src,
        }
    manifest["convert_method"] = {
        "tool": "MLX per-tensor int8 quantization",
        "bits": 8,
        "type": "max-abs per-tensor scale",
    }
    manifest["convert_script"] = "scripts/convert_lora_mlx.py"

    manifest_path = os.path.join(instance_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    total_saving_gb = (total_src - total_dst) / 1024**3
    print(f"[convert-lora] {name}: {total_src/1024**3:.1f} GB → "
          f"{total_dst/1024**3:.1f} GB (saved {total_saving_gb:.1f} GB)")


def convert_all() -> None:
    """Convert all LoRA instances that are still in safetensors float format."""
    lora_dir = os.path.join(cfg.MODELS_DIR, "lora")
    if not os.path.isdir(lora_dir):
        print(f"[convert-lora] No lora directory: {lora_dir}")
        return

    names = sorted(os.listdir(lora_dir))
    converted = 0
    for name in names:
        instance_dir = os.path.join(lora_dir, name)
        if not os.path.isdir(instance_dir):
            continue
        manifest_path = os.path.join(instance_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            continue
        with open(manifest_path) as f:
            m = json.load(f)
        fmt = m.get("format", "")
        if fmt in ("mlx-int8", "mlx-8bit"):
            print(f"[SKIP] {name} — already {fmt}")
            continue
        print(f"\n{'='*60}")
        convert_lora_instance(name)
        converted += 1

    print(f"\n[convert-lora] Done: {converted} LoRA(s) converted.")


def main():
    parser = argparse.ArgumentParser(
        description="Convert LoRA safetensors to int8 quantized format"
    )
    parser.add_argument("--name", type=str, default=None,
                        help="LoRA instance name (e.g. ltx-2.3-distilled)")
    parser.add_argument("--all", action="store_true",
                        help="Convert all LoRA instances still in float format")
    args = parser.parse_args()

    if args.all:
        convert_all()
    elif args.name:
        convert_lora_instance(args.name)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
