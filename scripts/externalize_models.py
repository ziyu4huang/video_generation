#!/usr/bin/env python3
"""Externalize MLX model weights into a shared, content-addressed store.

The big `.safetensors` blobs under `python/mlx-movie-director/models/` are
gitignored, so every git worktree has to re-acquire ~133GB. This script moves
each weight ONCE into a sibling content-addressed store
(`../video_generation__models/<md5>.safetensors`) and replaces the original
with a RELATIVE symlink. Because the store is a sibling of the repo, the same
relative symlink resolves identically from the main repo and from any SIBLING
worktree — so committing the symlinks lets a fresh worktree use the models with
zero copying. Loaders are symlink-transparent (mx.load / safetensors follow
links), and the repo already relies on this (ltx-mlx/ assembly links).

RECOVERY: a committed manifest (`<models-dir>/store-manifest.json`) maps every
weight path -> md5. If symlinks are ever lost (rm'd, a checkout that dropped
them, a fresh clone), `--relink` rebuilds every symlink FROM the manifest — no
need for the original link to still exist (as long as the store blobs are
present). So recovery works two ways: (a) the committed symlinks come back on
checkout, and (b) `--relink` regenerates them from the manifest.

Stdlib only — runs under any python3; use the project venv for consistency:

    python/venv/bin/python scripts/externalize_models.py --dry-run    # preview (hashes all)
    python/venv/bin/python scripts/externalize_models.py --apply      # move blobs + link + write manifest
    python/venv/bin/python scripts/externalize_models.py --relink     # rebuild links from manifest
    python/venv/bin/python scripts/externalize_models.py --restore    # links -> real files

Modes:
  --dry-run  (default) Read-only. Hash every target, report moves/dedup and the
              projected store size. Creates nothing.
  --apply    Move each regular weight to the store (atomic rename on the same
              volume; copy+verify+rm cross-volume), dedup by md5, create the
              relative symlink, and (re)write the manifest. Idempotent.
  --relink   RECOVERY: read the manifest and recreate every symlink -> store/<md5>
              for the current depth. Moves nothing. Skips (with a warning) any path
              that is currently a real file (won't clobber data).
  --restore  Reverse: replace each store-symlink with the real file (copied back
              from the store); rewrites the manifest to reflect the change.

Skips: non-.safetensors files (metadata stays), and symlinks that are NOT store
links (e.g. the ltx-mlx/ assembly links pointing within models/ — left untouched).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HASH_RE = re.compile(r"^[0-9a-f]{32}$")
SUFFIX = ".safetensors"
MANIFEST_NAME = "store-manifest.json"


def repo_root() -> Path:
    """Current worktree root (git toplevel), else the dir above this script."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], stderr=subprocess.DEVNULL
        ).decode().strip()
        if out:
            return Path(out).resolve()
    except Exception:
        pass
    return Path(__file__).resolve().parent.parent


def md5_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


def hash_from_link(readlink_str: str) -> str | None:
    """If a symlink's target basename is `<md5>.safetensors`, return the md5."""
    stem = Path(readlink_str).stem  # strips .safetensors
    return stem if HASH_RE.match(stem) else None


def discover(models_dir: Path, min_size: int):
    """Return (regular_files_to_externalize, existing store_symlinks)."""
    regulars, store_links = [], []
    for p in sorted(models_dir.rglob("*")):
        if not p.name.endswith(SUFFIX) or p.name == MANIFEST_NAME:
            continue
        if p.is_symlink():
            if hash_from_link(os.readlink(p)) is not None:
                store_links.append(p)
            # else: assembly link (points within models/) — leave alone
        elif p.is_file():
            if min_size <= 0 or p.stat().st_size >= min_size:
                regulars.append(p)
    return regulars, store_links


def manifest_path(models_dir: Path) -> Path:
    return models_dir / MANIFEST_NAME


def write_manifest(models_dir: Path, store: Path, root: Path) -> dict:
    """Build path->md5 from current store-links and write the manifest."""
    files = {}
    for p in sorted(models_dir.rglob("*")):
        if not p.is_symlink() or not p.name.endswith(SUFFIX):
            continue
        h = hash_from_link(os.readlink(p))
        if h:
            files[str(p.relative_to(models_dir))] = {"md5": h, "size": p.stat().st_size}
    doc = {
        "version": 1,
        "store_relative_to_repo_root": os.path.relpath(store, root),
        "count": len(files),
        "files": files,
    }
    manifest_path(models_dir).write_text(json.dumps(doc, indent=2) + "\n")
    return doc


def load_manifest(models_dir: Path) -> dict | None:
    mp = manifest_path(models_dir)
    if not mp.is_file():
        return None
    return json.loads(mp.read_text())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="read-only preview (default)")
    ap.add_argument("--apply", action="store_true", help="move blobs + link + write manifest")
    ap.add_argument("--relink", action="store_true", help="rebuild symlinks from the manifest")
    ap.add_argument("--restore", action="store_true", help="reverse: symlinks -> real files")
    ap.add_argument("--models-dir", default="python/mlx-movie-director/models")
    ap.add_argument("--store", default=None, help="store dir (default: <repo>/../video_generation__models)")
    ap.add_argument("--min-size", type=int, default=0, help="min bytes to externalize (0 = all)")
    args = ap.parse_args()

    root = repo_root()
    models_dir = Path(args.models_dir) if os.path.isabs(args.models_dir) else (root / args.models_dir)
    models_dir = models_dir.resolve()
    store = Path(args.store).resolve() if args.store else (root.parent / "video_generation__models").resolve()

    if not models_dir.is_dir():
        print(f"ERROR: models dir not found: {models_dir}", file=sys.stderr)
        return 1

    mode = "apply" if args.apply else "relink" if args.relink else "restore" if args.restore else "dry-run"

    # ── RELINK: rebuild every symlink from the manifest ──────────────────────
    if mode == "relink":
        mf = load_manifest(models_dir)
        if not mf:
            print(f"ERROR: no manifest at {manifest_path(models_dir)} — run --apply first.", file=sys.stderr)
            return 1
        files = mf.get("files", {})
        print(f"Relinking {len(files)} symlink(s) from manifest -> {store}")
        made, skipped, missing_blob = 0, 0, 0
        for rel, info in sorted(files.items()):
            p = models_dir / rel
            blob = store / f"{info['md5']}{SUFFIX}"
            if not blob.is_file():
                print(f"  ✗ {rel}: store blob missing ({blob.name})", file=sys.stderr)
                missing_blob += 1
                continue
            if p.is_file() and not p.is_symlink():
                print(f"  ⚠ {rel}: real file present — skipping (won't clobber; use --restore/--apply)")
                skipped += 1
                continue
            want = os.path.relpath(blob, p.parent)
            if p.is_symlink() and os.readlink(p) == want:
                continue  # already correct
            if p.is_symlink() or p.exists():
                p.unlink()
            os.symlink(want, p)
            made += 1
            print(f"  ✓ {rel} -> {blob.name}")
        print(f"\nRelinked {made}, up-to-date/skipped {skipped}, missing-blob {missing_blob}.")
        return 0 if missing_blob == 0 else 2

    # ── RESTORE: symlinks -> real files ──────────────────────────────────────
    if mode == "restore":
        regulars, store_links = discover(models_dir, args.min_size)
        if not store_links:
            print("No store symlinks to restore.")
            return 0
        print(f"Restoring {len(store_links)} store-symlink(s) -> real files from {store}")
        n = 0
        for p in store_links:
            resolved = (p.parent / os.readlink(p)).resolve()
            if not resolved.is_file():
                print(f"  ✗ {p.relative_to(root)}: store blob missing ({resolved})", file=sys.stderr)
                continue
            p.unlink()
            shutil.copy2(resolved, p)
            n += 1
        # Manifest now describes real files, not links — remove it (re-apply to regenerate).
        mp = manifest_path(models_dir)
        if mp.is_file():
            mp.unlink()
        print(f"Restored {n}/{len(store_links)}. Store left intact. Manifest removed (re-run --apply to rebuild).")
        return 0

    # ── DRY-RUN / APPLY ──────────────────────────────────────────────────────
    regulars, store_links = discover(models_dir, args.min_size)
    print(f"mode: {mode.upper()}")
    print(f"models: {models_dir}")
    print(f"store : {store}")
    if not regulars and not store_links:
        print("Nothing to do — no externalizable weights found.")
        return 0

    cross_volume = False
    if regulars:
        if mode == "apply":
            store.mkdir(parents=True, exist_ok=True)
        try:
            sdev = os.stat(store).st_dev if store.exists() else os.stat(store.parent).st_dev
            fdev = regulars[0].stat().st_dev
            cross_volume = sdev != fdev
        except OSError:
            pass
    if cross_volume:
        print("⚠ store is on a DIFFERENT volume — will copy+verify+rm (slower, needs free space).")

    total_size = sum(p.stat().st_size for p in regulars)
    print(f"\nregular weights to externalize: {len(regulars)} ({human(total_size)})")
    print(f"existing store-symlinks in tree: {len(store_links)}")

    # Hash + classify (read-only; same path for dry-run and apply).
    seen: dict[str, Path] = {}
    moves, dedups = [], []
    print("\nHashing (this reads every weight once)…")
    for i, p in enumerate(regulars, 1):
        h = md5_file(p)
        dst = store / f"{h}{SUFFIX}"
        rel = p.relative_to(root)
        if h in seen or dst.exists():
            dedups.append((p, dst))
            print(f"  [{i}/{len(regulars)}] DEDUP {rel}  ({human(p.stat().st_size)})")
        else:
            moves.append((p, dst, h))
            seen[h] = dst
            print(f"  [{i}/{len(regulars)}] move  {rel}  ({human(p.stat().st_size)}) -> {dst.name}")

    unique_bytes = sum(m[0].stat().st_size for m in moves)
    saved_bytes = total_size - unique_bytes
    print(f"\nprojected store size (unique content): {human(unique_bytes)} across {len(moves)} blob(s)")
    if saved_bytes > 0:
        print(f"dedup savings: {human(saved_bytes)} across {len(dedups)} duplicate(s)")

    # Existing store-links whose relative target is wrong for this depth.
    relinks = []
    for p in store_links:
        want = os.path.relpath((store / Path(os.readlink(p)).name).resolve(), p.parent)
        if want != os.readlink(p):
            relinks.append((p, want))
    if relinks:
        print(f"existing store-symlinks needing relink (wrong depth): {len(relinks)}")

    if mode == "dry-run":
        print("\nDRY-RUN: no changes made. Re-run with --apply to proceed.")
        return 0

    # ── APPLY ──
    store.mkdir(parents=True, exist_ok=True)
    print("\nApplying…")
    done = 0
    for p, dst, h in moves:
        if cross_volume:
            shutil.copy2(p, dst)
            if md5_file(dst) != h:
                dst.unlink(missing_ok=True)
                print(f"  ✗ VERIFY FAILED (copy): {p}", file=sys.stderr)
                continue
            p.unlink()
        else:
            os.rename(p, dst)  # atomic on same volume
        os.symlink(os.path.relpath(dst, p.parent), p)
        done += 1
    for p, dst in dedups:
        p.unlink()
        os.symlink(os.path.relpath(dst, p.parent), p)
    for p, want in relinks:
        p.unlink()
        os.symlink(want, p)

    mf = write_manifest(models_dir, store, root)
    print(f"\nDone. Externalized {done} new blob(s), deduped {len(dedups)}, relinked {len(relinks)}.")
    print(f"Manifest: {manifest_path(models_dir).relative_to(root)} ({mf['count']} entries)")
    print(f"Store:    {store}")
    print("\nRecovery: symlinks are committed; if lost, run `--relink` to rebuild from the manifest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
