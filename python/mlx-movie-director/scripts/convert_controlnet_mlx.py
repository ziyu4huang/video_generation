#!/usr/bin/env python3
"""Convert ControlNet from safetensors-bf16 to MLX 4-bit quantized.

Creates a separate instance at models/controlnet/zimage-turbo-fun-union-2.1-mlx/
while keeping the original untouched.
"""

import gc
import json
import os
from datetime import datetime
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mlx.core as mx
from mlx import nn

from app import config as cfg
from app.controlnet import ZImageControlnet


def _quantize_predicate(path: str, module) -> bool:
    """Quantize only Linear layers with dimensions divisible by 64."""
    if not hasattr(module, "to_quantized"):
        return False
    if isinstance(module, nn.Linear):
        if hasattr(module, "weight") and module.weight.shape[-1] % 64 != 0:
            return False
    return True


def main():
    src_dir = cfg.CONTROLNET_DIR
    dst_dir = os.path.join(cfg.MODELS_DIR, "controlnet",
                           "zimage-turbo-fun-union-2.1-mlx")
    src_weight = os.path.join(src_dir, "model.safetensors")

    if not os.path.exists(src_weight):
        print(f"[convert-cnet] ERROR: Source not found: {src_weight}")
        sys.exit(1)

    os.makedirs(dst_dir, exist_ok=True)

    # Copy non-weight files
    for f in ["config.json", "README.md"]:
        s = os.path.join(src_dir, f)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(dst_dir, f))

    # Load original weights into MLX model
    print(f"[convert-cnet] Loading BF16 ControlNet ({os.path.getsize(src_weight)//1_000_000} MB)...")
    weights = mx.load(src_weight)
    print(f"[convert-cnet] {len(weights)} tensors loaded.")

    model = ZImageControlnet()
    model.load_weights(list(weights.items()))
    mx.eval(model.parameters())
    del weights
    gc.collect()
    print("[convert-cnet] Model assembled.")

    # Quantize to 4-bit
    print("[convert-cnet] Quantizing to 4-bit (group_size=32)...")
    nn.quantize(model, bits=4, group_size=32, class_predicate=_quantize_predicate)
    mx.eval(model.parameters())
    print("[convert-cnet] Quantization complete.")

    # Save quantized weights
    dst_weight = os.path.join(dst_dir, "model.safetensors")
    print(f"[convert-cnet] Saving quantized weights to {dst_weight}...")
    model.save_weights(dst_weight)
    del model
    gc.collect()

    old_mb = os.path.getsize(src_weight) / (1024 * 1024)
    new_mb = os.path.getsize(dst_weight) / (1024 * 1024)
    print(f"[convert-cnet] Done: {old_mb:.0f} MB (BF16) -> {new_mb:.0f} MB (4-bit)")

    # Load original manifest to copy source records
    src_manifest_path = os.path.join(src_dir, "manifest.json")
    src_manifest = {}
    if os.path.exists(src_manifest_path):
        with open(src_manifest_path) as f:
            src_manifest = json.load(f)

    # Create manifest with provenance
    manifest = {
        "_comment": f"Private metadata. MLX 4-bit quantized from {src_dir}.",
        "name": "zimage-turbo-fun-union-2.1-mlx",
        "type": "controlnet",
        "arch": "zimage-turbo",
        "format": "mlx-4bit-gs32",
        "description": "Z-Image Turbo Fun ControlNet Union 2.1 Lite, MLX 4-bit quantized (group_size=32)",
        # Copy source records
        "source": src_manifest.get("source", ""),
        "source_url": src_manifest.get("source_url", ""),
        "hf_repo": src_manifest.get("hf_repo", ""),
        "hf_filename": src_manifest.get("hf_filename", ""),
        "pipeline": src_manifest.get("pipeline", ["zimage-turbo"]),
        "compatible_with": src_manifest.get("compatible_with", []),
        # New size
        "size_bytes": os.path.getsize(dst_weight),
        "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        # Conversion provenance
        "converted_from": {
            "model": f"controlnet/{src_manifest.get('name', 'unknown')}",
            "format": src_manifest.get("format", "unknown"),
            "size_bytes": src_manifest.get("size_bytes", 0),
        },
        "convert_method": {
            "tool": "MLX nn.quantize",
            "bits": 4,
            "group_size": 32,
            "class_predicate": "skip_linear_with_dim_not_divisible_by_64",
        },
        "convert_script": "scripts/convert_controlnet_mlx.py",
        "convert_command": "python/venv/bin/python scripts/convert_controlnet_mlx.py",
        "convert_timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(os.path.join(dst_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[convert-cnet] manifest.json written.")
    print(f"[convert-cnet] Original preserved at: {src_dir}")


if __name__ == "__main__":
    main()
