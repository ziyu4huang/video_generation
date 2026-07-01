#!/usr/bin/env python3
"""
convert-esrgan.py — convert an ESRGAN/RealPLKSR `.pth` to the `.safetensors`
state_dict that flux2's native Swift loader expects.

WHY
---
flux2's `ESRGANLoader.loadRealPLKSR` (common-image-director/ESRGAN.swift) reads a
**safetensors** file whose keys are the raw torch state_dict keys
(`feats.0.weight`, `feats.<i>.channel_mixer.*`, … `feats.30.*`). The Python
upscale path loads the `.pth` directly via spandrel, but the Swift/flux2 path
does not — it needs a converted `.safetensors` next to the `.pth`.

Most community `.pth` files (e.g. 4xNomosWebPhoto_RealPLKSR) are already a flat
torch state_dict with `feats.*` keys, so this is essentially a format dump
(torch pickle → safetensors), with the tensor values unchanged. If the `.pth`
has a nested wrapper (`params_ema` / `params` / `state_dict`), the inner dict is
unwrapped first.

USAGE
-----
    # from repo root, using the mlx venv (has torch + safetensors).
    # Accepts either the .pth file OR the model instance directory.
    <venv>/python swift/flux2-image-director/scripts/convert-esrgan.py \
        mlx-models/upscale/4x-nomos-webphoto-realplksr

Writes `<name>.safetensors` into the model instance dir. flux2's UpscaleCommand
auto-picks the first `*.safetensors` in the model dir.

If the .pth is missing from the instance dir (fresh checkout, symlink not yet
restored), the script scans the external content store
(`$MLX_WEIGHTS_STORE` or `../video_generation__models`) for a RealPLKSR `.pth`
(state_dict with `feats.*` keys) and symlinks + converts it.

IDEMPOTENT: skips if the .safetensors is newer than the .pth.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import torch


def _is_realplksr(path: Path) -> bool:
    """Cheap check: does this .pth load to a state_dict with feats.* keys?"""
    try:
        sd = torch.load(path, map_location="cpu", weights_only=False)
    except Exception:
        return False
    return isinstance(sd, dict) and any(k.startswith("feats.") for k in sd)


def find_pth(instance_dir: Path) -> Path | None:
    """Locate the RealPLKSR .pth for an instance dir.

    Order: an existing *.pth in the dir (incl. a symlink into the store) →
    else scan the external content store for a RealPLKSR .pth.
    """
    instance_dir = instance_dir.resolve()
    existing = sorted(instance_dir.glob("*.pth"))
    for p in existing:
        if _is_realplksr(p):
            return p  # in-dir (incl. symlink) — keeps the human name for output

    store_env = os.environ.get("MLX_WEIGHTS_STORE", "").strip()
    store = Path(store_env).expanduser() if store_env else None
    if not store:
        # repo root / .. / video_generation__models  (instance is deep under repo)
        for parent in instance_dir.parents:
            cand = parent.parent / "video_generation__models"
            if cand.is_dir():
                store = cand
                break
    if store and store.is_dir():
        for p in sorted(store.glob("*.pth")):
            if _is_realplksr(p):
                return p  # store path; caller links it into the instance dir
    return None


def unwrap(state):
    """Return the flat state_dict if the .pth wraps it (params_ema/params/...)."""
    if isinstance(state, dict) and not any(k.startswith("feats.") for k in state):
        for cand in ("params_ema", "params", "state_dict"):
            inner = state.get(cand)
            if isinstance(inner, dict) and any(k.startswith("feats.") for k in inner):
                print(f"  unwrapped nested '{cand}' ({len(inner)} keys)")
                return inner
    return state


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    arg = Path(argv[1]).expanduser()
    # Accept either the .pth directly, or the model instance directory.
    if arg.is_dir():
        instance_dir = arg
        src_given = find_pth(instance_dir)
        if src_given is None:
            print(
                f"✕ no RealPLKSR .pth found in {instance_dir} or the external store.\n"
                "  Drop the .pth into the instance dir (or restore its symlink) and retry.",
                file=sys.stderr,
            )
            return 1
        # If the .pth was found in the external store (not yet in the instance
        # dir), link it in by its canonical name so flux2 + the python path both
        # resolve it. The converted .safetensors inherits this clean name.
        in_dir_pths = [p for p in instance_dir.glob("*.pth")]
        if src_given in in_dir_pths:
            out_stem = src_given.stem
        else:
            linked = instance_dir / "4xNomosWebPhoto_RealPLKSR.pth"
            try:
                linked.symlink_to(src_given.resolve())
                print(f"  linked {linked.name} → {src_given}")
                out_stem = linked.stem
            except OSError:
                out_stem = "4xNomosWebPhoto_RealPLKSR"
        dst = instance_dir / f"{out_stem}.safetensors"
    else:
        # given a .pth path — output beside it (as-given, not resolved target)
        src_given = arg
        dst = arg.with_suffix(".safetensors")

    src = src_given.resolve()
    if not src.exists():
        print(f"✕ not found: {src_given}", file=sys.stderr)
        return 1

    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        print(f"✓ up to date: {dst}")
        return 0

    try:
        from safetensors.torch import save_file
    except ImportError:
        print("✕ safetensors not installed in this venv", file=sys.stderr)
        return 1

    print(f"▶ loading {src.name} …")
    state = torch.load(src, map_location="cpu", weights_only=False)
    state = unwrap(state)
    if not isinstance(state, dict) or not any(k.startswith("feats.") for k in state):
        print(
            "✕ expected a RealPLKSR state_dict with 'feats.*' keys; "
            f"got type={type(state).__name__}, sample={list(state)[:4] if isinstance(state, dict) else state}",
            file=sys.stderr,
        )
        return 1

    # flux2 loads via MLX safetensors reader; float32 contiguous is the safe
    # canonical form (the arch casts as needed at load time).
    clean = {}
    for k, v in state.items():
        if not isinstance(v, torch.Tensor):
            continue
        t = v.detach().cpu().contiguous().float()
        clean[k] = t

    save_file(clean, str(dst), metadata={"format": "pt"})
    size_mb = dst.stat().st_size / 1e6
    print(f"✓ wrote {dst.name}  ({size_mb:.1f} MB, {len(clean)} tensors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
