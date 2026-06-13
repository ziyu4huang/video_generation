#!/usr/bin/env python3
"""Quantize SeedVR2 VAE from BF16 to INT8, saving as a separate instance.

Keeps the original BF16 model untouched at models/vae/seedvr2-vae/.
Creates a quantized copy at models/vae/seedvr2-vae-int8/.
"""

import gc
import json
import os
from datetime import datetime
import shutil
import sys

# Ensure local app package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mlx.core as mx
from mlx import nn

from app import config as cfg
from app.seedvr2.vae import SeedVR2VAE


def _quantize_predicate(path: str, module) -> bool:
    """Skip quantization for Conv layers and small Linear layers."""
    if isinstance(module, (nn.Conv2d, nn.Conv3d)):
        return False
    if not hasattr(module, "to_quantized"):
        return False
    if isinstance(module, nn.Linear):
        if hasattr(module, "weight") and module.weight.shape[-1] % 64 != 0:
            return False
    return True


def main():
    src_dir = cfg.SEEDVR2_VAE_DIR
    dst_dir = os.path.join(cfg.MODELS_DIR, "vae", "seedvr2-vae-int8")
    src_weight = os.path.join(src_dir, "model.safetensors")

    if not os.path.exists(src_weight):
        print(f"[quantize] ERROR: Source model not found: {src_weight}")
        sys.exit(1)

    # 1. Create destination directory (copy non-weight files)
    os.makedirs(dst_dir, exist_ok=True)
    for f in ["config.json", "README.md"]:
        s = os.path.join(src_dir, f)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(dst_dir, f))

    # 2. Load original BF16 model
    print(f"[quantize] Loading BF16 VAE from {src_weight}...")
    model = SeedVR2VAE()
    model.load_weights(src_weight)
    mx.eval(model.parameters())
    print(f"[quantize] Loaded. Parameters loaded.")

    # 3. Quantize to INT8
    print("[quantize] Quantizing to INT8 (group_size=64)...")
    nn.quantize(model, bits=8, group_size=64, class_predicate=_quantize_predicate)
    mx.eval(model.parameters())
    print("[quantize] Quantization complete.")

    # 4. Save to new directory
    dst_weight = os.path.join(dst_dir, "model.safetensors")
    print(f"[quantize] Saving INT8 weights to {dst_weight}...")
    model.save_weights(dst_weight)
    del model
    gc.collect()

    old_mb = os.path.getsize(src_weight) / (1024 * 1024)
    new_mb = os.path.getsize(dst_weight) / (1024 * 1024)
    print(f"[quantize] Done. {old_mb:.0f} MB (BF16) → {new_mb:.0f} MB (INT8)")

    # 5. Load source manifest to copy provenance records
    src_manifest_path = os.path.join(src_dir, "manifest.json")
    src_manifest = {}
    if os.path.exists(src_manifest_path):
        with open(src_manifest_path) as f:
            src_manifest = json.load(f)

    # 6. Create manifest.json with full provenance
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {
        "_comment": "Private metadata. INT8 quantized copy of seedvr2-vae.",
        "name": "seedvr2-vae-int8",
        "type": "vae",
        "arch": "seedvr2-vae",
        "format": "mlx-int8",
        "description": "SeedVR2 3D VAE, MLX INT8 quantized (group_size=64). Quantized from seedvr2-vae BF16.",
        # Copy source records
        "source": src_manifest.get("source", ""),
        "source_url": src_manifest.get("source_url", ""),
        "hf_repo": src_manifest.get("hf_repo", ""),
        "pipeline": src_manifest.get("pipeline", ["seedvr2-upscale"]),
        "compatible_with": src_manifest.get("compatible_with", []),
        # New size
        "size_bytes": os.path.getsize(dst_weight),
        "created_at": now,
        # Conversion provenance
        "converted_from": {
            "model": f"vae/{src_manifest.get('name', 'unknown')}",
            "format": src_manifest.get("format", "unknown"),
            "size_bytes": src_manifest.get("size_bytes", 0),
        },
        "convert_method": {
            "tool": "MLX nn.quantize",
            "bits": 8,
            "group_size": 64,
            "class_predicate": "skip_conv3d_and_small_linear",
        },
        "convert_script": "scripts/quantize_seedvr2_vae.py",
        "convert_command": "python/venv/bin/python scripts/quantize_seedvr2_vae.py",
        "convert_timestamp": now,
    }
    with open(os.path.join(dst_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[quantize] manifest.json written to {dst_dir}/")


if __name__ == "__main__":
    main()
