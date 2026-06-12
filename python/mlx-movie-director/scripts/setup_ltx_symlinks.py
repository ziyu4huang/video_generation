#!/usr/bin/env python3
"""setup_ltx_symlinks — create pre-built flat symlink dirs for LTX-2.3.

Creates one directory per transformer variant under models/ltx-mlx/:
  - dev/        dev transformer (T2V, I2V, A2V, HQ, FLF2V)
  - distilled/  distilled transformer (fast 8-step generation)
  - dasiwa/     DaSiWa dev-architecture finetune (shares base VAE/text-encoder/
                audio/distilled-LoRA; only the transformer differs)

Each contains relative symlinks pointing to the real files in
models/{type}/{name}/.  ltx-2-mlx expects all files in a single flat
directory — these pre-built dirs avoid on-the-fly temp assembly.

The per-variant config (transformer dir/file, flat dir, shared components)
lives in app/ltx_variants.py — this script is now a thin loop over the
variant registry, so adding a variant needs no change here.

Usage:
    python scripts/setup_ltx_symlinks.py          # create all
    python scripts/setup_ltx_symlinks.py --check   # verify existing
    python scripts/setup_ltx_symlinks.py --force   # recreate from scratch
"""

import os
import sys
import argparse

# Add project root so we can import config / the variant registry
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

from app.ltx_variants import LTX_VARIANTS, get_variant


def _component_files(variant: str) -> dict[str, list[str]]:
    """{source_dir: [filenames]} to symlink for this variant."""
    return get_variant(variant).component_files()


def _required_list(variant: str) -> list[tuple[str, str]]:
    """Required source files (existence gate before symlinking)."""
    return get_variant(variant).required_files


def _target_dir(variant: str) -> str:
    """Pre-built flat dir for this variant."""
    return get_variant(variant).flat_dir


def _relative_symlink(src: str, dst: str) -> None:
    """Create a relative symlink from dst → src."""
    rel = os.path.relpath(src, os.path.dirname(dst))
    if os.path.islink(dst):
        os.remove(dst)
    elif os.path.exists(dst):
        os.remove(dst)
    os.symlink(rel, dst)


def setup_variant(variant: str, force: bool = False) -> bool:
    """Create symlinks for one variant."""
    target = _target_dir(variant)
    components = _component_files(variant)

    # Check required source files exist
    missing = [
        os.path.join(src_dir, fname)
        for src_dir, fname in _required_list(variant)
        if not os.path.exists(os.path.join(src_dir, fname))
    ]
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
    target = _target_dir(variant)
    if not os.path.isdir(target):
        print(f"  ❌ {variant}/ — directory does not exist")
        return False

    all_ok = True
    for src_dir, fname in _required_list(variant):
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

    from app import config as cfg
    print(f"Models dir: {cfg.MODELS_DIR}")
    print()

    variants = list(LTX_VARIANTS.keys())

    if args.check:
        print("Checking pre-built LTX symlink dirs:")
        for v in variants:
            check_variant(v)
        return

    print("Setting up pre-built LTX symlink dirs:")
    results = {v: setup_variant(v, force=args.force) for v in variants}

    if not all(results.values()):
        print()
        print("⚠️  Some variants skipped — run `python app/ltx_downloader.py` to download missing models")
        sys.exit(1)
    else:
        print()
        print("🎉 All done — run `run.py video generate` to use pre-built dirs")


if __name__ == "__main__":
    main()
