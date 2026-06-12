#!/usr/bin/env python3
"""setup_ltx_symlinks — create pre-built flat symlink dirs for LTX-2.3.

Creates directories under models/ltx-mlx/:
  - dev/        for the dev transformer (T2V, I2V, A2V, HQ, FLF2V)
  - distilled/  for the distilled transformer (fast 8-step generation)
  - dasiwa/     for a DaSiWa dev-architecture finetune (shares base VAE/
                text-encoder/audio/distilled-LoRA; only the transformer differs)

Each contains relative symlinks pointing to the real files in
models/{type}/{name}/.  ltx-2-mlx expects all files in a single flat
directory — these pre-built dirs avoid on-the-fly temp assembly.

Usage:
    python scripts/setup_ltx_symlinks.py          # create all
    python scripts/setup_ltx_symlinks.py --check   # verify existing
    python scripts/setup_ltx_symlinks.py --force   # recreate from scratch
"""

import os
import sys
import argparse

# Add project root so we can import config
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

from app import config as cfg

# Same mapping as ltx_pipeline.py — source_dir → filenames
_COMPONENT_FILES = {
    "dev": {
        cfg.LTX_TRANSFORMER_DIR: [
            "transformer-dev.safetensors",
            "split_model.json",
            "quantize_config.json",
        ],
        cfg.LTX_LORA_DIR: [
            "ltx-2.3-22b-distilled-lora-384.safetensors",
            "ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
        ],
        cfg.LTX_TEXT_ENCODER_DIR: [
            "connector.safetensors",
            "config.json",
            "embedded_config.json",
        ],
        cfg.LTX_VAE_DIR: [
            "vae_encoder.safetensors",
            "vae_decoder.safetensors",
            "spatial_upscaler_x2_v1_1.safetensors",
            "spatial_upscaler_x2_v1_1_config.json",
            "spatial_upscaler_x1_5_v1_0.safetensors",
            "spatial_upscaler_x1_5_v1_0_config.json",
            "temporal_upscaler_x2_v1_0.safetensors",
            "temporal_upscaler_x2_v1_0_config.json",
        ],
        cfg.LTX_AUDIO_DIR: [
            "audio_vae.safetensors",
            "vocoder.safetensors",
        ],
    },
    "distilled": {
        cfg.LTX_DISTILLED_TRANSFORMER_DIR: [
            "transformer-distilled-1.1.safetensors",
            "split_model.json",
            "quantize_config.json",
        ],
        cfg.LTX_LORA_DIR: [
            "ltx-2.3-22b-distilled-lora-384.safetensors",
            "ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
        ],
        cfg.LTX_TEXT_ENCODER_DIR: [
            "connector.safetensors",
            "config.json",
            "embedded_config.json",
        ],
        cfg.LTX_VAE_DIR: [
            "vae_encoder.safetensors",
            "vae_decoder.safetensors",
            "spatial_upscaler_x2_v1_1.safetensors",
            "spatial_upscaler_x2_v1_1_config.json",
            "spatial_upscaler_x1_5_v1_0.safetensors",
            "spatial_upscaler_x1_5_v1_0_config.json",
            "temporal_upscaler_x2_v1_0.safetensors",
            "temporal_upscaler_x2_v1_0_config.json",
        ],
        cfg.LTX_AUDIO_DIR: [
            "audio_vae.safetensors",
            "vocoder.safetensors",
        ],
    },
    "dasiwa": {
        # DaSiWa dev-architecture finetune: its transformer (saved as
        # transformer-dev.safetensors by convert.py --ltx-checkpoint) + the
        # SAME shared components as dev.
        cfg.LTX_DASIWA_TRANSFORMER_DIR: [
            "transformer-dev.safetensors",
            "split_model.json",
            "quantize_config.json",
        ],
        cfg.LTX_LORA_DIR: [
            "ltx-2.3-22b-distilled-lora-384.safetensors",
            "ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
        ],
        cfg.LTX_TEXT_ENCODER_DIR: [
            "connector.safetensors",
            "config.json",
            "embedded_config.json",
        ],
        cfg.LTX_VAE_DIR: [
            "vae_encoder.safetensors",
            "vae_decoder.safetensors",
            "spatial_upscaler_x2_v1_1.safetensors",
            "spatial_upscaler_x2_v1_1_config.json",
            "spatial_upscaler_x1_5_v1_0.safetensors",
            "spatial_upscaler_x1_5_v1_0_config.json",
            "temporal_upscaler_x2_v1_0.safetensors",
            "temporal_upscaler_x2_v1_0_config.json",
        ],
        cfg.LTX_AUDIO_DIR: [
            "audio_vae.safetensors",
            "vocoder.safetensors",
        ],
    },
}

# Required files that must exist (vs optional upscalers/configs)
_REQUIRED = {
    "dev": {
        cfg.LTX_TRANSFORMER_DIR: "transformer-dev.safetensors",
        cfg.LTX_LORA_DIR: "ltx-2.3-22b-distilled-lora-384.safetensors",
        cfg.LTX_TEXT_ENCODER_DIR: "connector.safetensors",
        cfg.LTX_VAE_DIR: "vae_encoder.safetensors",
        cfg.LTX_VAE_DIR: "vae_decoder.safetensors",
    },
    "distilled": {
        cfg.LTX_DISTILLED_TRANSFORMER_DIR: "transformer-distilled-1.1.safetensors",
        cfg.LTX_TEXT_ENCODER_DIR: "connector.safetensors",
        cfg.LTX_VAE_DIR: "vae_encoder.safetensors",
        cfg.LTX_VAE_DIR: "vae_decoder.safetensors",
    },
    "dasiwa": {
        cfg.LTX_DASIWA_TRANSFORMER_DIR: "transformer-dev.safetensors",
        cfg.LTX_LORA_DIR: "ltx-2.3-22b-distilled-lora-384.safetensors",
        cfg.LTX_TEXT_ENCODER_DIR: "connector.safetensors",
        cfg.LTX_VAE_DIR: "vae_encoder.safetensors",
        cfg.LTX_VAE_DIR: "vae_decoder.safetensors",
    },
}

# Note: _REQUIRED has duplicate keys for VAE_DIR. Fix by using list of tuples.
_REQUIRED_LIST = {
    "dev": [
        (cfg.LTX_TRANSFORMER_DIR, "transformer-dev.safetensors"),
        (cfg.LTX_LORA_DIR, "ltx-2.3-22b-distilled-lora-384.safetensors"),
        (cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors"),
        (cfg.LTX_VAE_DIR, "vae_encoder.safetensors"),
        (cfg.LTX_VAE_DIR, "vae_decoder.safetensors"),
    ],
    "distilled": [
        (cfg.LTX_DISTILLED_TRANSFORMER_DIR, "transformer-distilled-1.1.safetensors"),
        (cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors"),
        (cfg.LTX_VAE_DIR, "vae_encoder.safetensors"),
        (cfg.LTX_VAE_DIR, "vae_decoder.safetensors"),
    ],
    "dasiwa": [
        (cfg.LTX_DASIWA_TRANSFORMER_DIR, "transformer-dev.safetensors"),
        (cfg.LTX_LORA_DIR, "ltx-2.3-22b-distilled-lora-384.safetensors"),
        (cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors"),
        (cfg.LTX_VAE_DIR, "vae_encoder.safetensors"),
        (cfg.LTX_VAE_DIR, "vae_decoder.safetensors"),
    ],
}

TARGET_DIRS = {
    "dev": cfg.LTX_MLX_DEV_DIR,
    "distilled": cfg.LTX_MLX_DISTILLED_DIR,
    "dasiwa": cfg.LTX_MLX_DASIWA_DIR,
}


def _relative_symlink(src: str, dst: str) -> None:
    """Create a relative symlink from dst → src."""
    rel = os.path.relpath(src, os.path.dirname(dst))
    if os.path.islink(dst):
        os.remove(dst)
    elif os.path.exists(dst):
        os.remove(dst)
    os.symlink(rel, dst)


def setup_variant(variant: str, force: bool = False) -> bool:
    """Create symlinks for one variant (dev or distilled)."""
    target = TARGET_DIRS[variant]
    components = _COMPONENT_FILES[variant]

    # Check required source files exist
    missing = []
    for src_dir, fname in _REQUIRED_LIST[variant]:
        if not os.path.exists(os.path.join(src_dir, fname)):
            missing.append(os.path.join(src_dir, fname))
    if missing:
        print(f"  ⚠️  Skipping {variant}/ — missing required files:")
        for m in missing:
            print(f"      {m}")
        return False

    # Create target dir
    os.makedirs(target, exist_ok=True)

    if force:
        # Remove existing symlinks
        for entry in os.listdir(target):
            p = os.path.join(target, entry)
            if os.path.islink(p):
                os.remove(p)

    # Create symlinks
    created, skipped = 0, 0
    for src_dir, filenames in components.items():
        for fname in filenames:
            src = os.path.join(src_dir, fname)
            dst = os.path.join(target, fname)
            if not os.path.exists(src):
                skipped += 1
                continue
            _relative_symlink(src, dst)
            created += 1

    print(f"  ✅ {variant}/ — {created} symlinks created, {skipped} optional files skipped")
    return True


def check_variant(variant: str) -> bool:
    """Verify existing symlinks for one variant."""
    target = TARGET_DIRS[variant]
    if not os.path.isdir(target):
        print(f"  ❌ {variant}/ — directory does not exist")
        return False

    all_ok = True
    for src_dir, fname in _REQUIRED_LIST[variant]:
        link = os.path.join(target, fname)
        if not os.path.islink(link):
            print(f"  ❌ {variant}/ — {fname} is not a symlink")
            all_ok = False
        elif not os.path.exists(link):
            print(f"  ❌ {variant}/ — {fname} → broken symlink (target missing)")
            all_ok = False

    total = sum(1 for e in os.listdir(target) if os.path.islink(os.path.join(target, e)))
    if all_ok:
        print(f"  ✅ {variant}/ — {total} symlinks, all required present")
    return all_ok


def main():
    parser = argparse.ArgumentParser(description="Create pre-built LTX flat symlink dirs")
    parser.add_argument("--check", action="store_true", help="Verify existing symlinks only")
    parser.add_argument("--force", action="store_true", help="Recreate symlinks from scratch")
    args = parser.parse_args()

    print(f"Models dir: {cfg.MODELS_DIR}")
    print()

    if args.check:
        print("Checking pre-built LTX symlink dirs:")
        for v in ("dev", "distilled", "dasiwa"):
            check_variant(v)
        return

    print("Setting up pre-built LTX symlink dirs:")
    results = {}
    for v in ("dev", "distilled", "dasiwa"):
        results[v] = setup_variant(v, force=args.force)

    if not all(results.values()):
        print()
        print("⚠️  Some variants skipped — run `python app/ltx_downloader.py` to download missing models")
        sys.exit(1)
    else:
        print()
        print("🎉 All done — run `run.py video generate` to use pre-built dirs")


if __name__ == "__main__":
    main()
