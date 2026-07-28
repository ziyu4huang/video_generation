"""import-musicgen — download facebook/musicgen-small and split it into this
repo's mlx-models/ external-store convention for the Swift port.

HF's facebook/musicgen-small is a merged checkpoint with three sub-models
(text_encoder/, decoder/, audio_encoder/), each with its own config.json and
safetensors. This splits them into flat files + config JSONs under
mlx-models/musicgen/musicgen-small/, externalizing each safetensors into the
shared video_generation__models/ store (same convention as import-checkpoint.py
and import-lora-image.py — each import-*.py file independently duplicates the
small md5/externalize/git-add-force helper set, per that established pattern,
rather than sharing a module).

This is dev-tooling only (same standing-rule carve-out as import-checkpoint.py/
import-lora-image.py) — not a production generation code path.

Usage:
  run.py import-musicgen
  run.py import-musicgen --model facebook/musicgen-small --name musicgen-small
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from app import config as cfg

PARSER_META = {
    "help": "Download + split facebook/musicgen-small for the Swift musicgen-director port",
    "description": (
        "Downloads a MusicGen checkpoint from HuggingFace and splits its three\n"
        "sub-models (text_encoder/decoder/audio_encoder) into flat safetensors +\n"
        "config JSON files under mlx-models/musicgen/<name>/, externalizing each\n"
        "weights file into the shared video_generation__models/ store.\n\n"
        "Examples:\n"
        "  run.py import-musicgen\n"
        "  run.py import-musicgen --model facebook/musicgen-small --name musicgen-small\n"
    ),
}


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", type=str, default="facebook/musicgen-small",
                        help="HF model id (default: facebook/musicgen-small)")
    parser.add_argument("--name", type=str, default=None,
                        help="Output dir name under mlx-models/musicgen/ (default: derived from --model)")


def run(args: argparse.Namespace) -> None:
    from huggingface_hub import snapshot_download
    import mlx.core as mx

    name = args.name or args.model.split("/")[-1]
    target_dir = Path(cfg.MODELS_DIR) / "musicgen" / name
    if target_dir.exists():
        print(f"ERROR: target already exists: {target_dir}", file=sys.stderr)
        sys.exit(1)
    target_dir.mkdir(parents=True, exist_ok=True)

    print(f"[import-musicgen] downloading {args.model}...")
    snap_dir = Path(snapshot_download(repo_id=args.model))

    top_config = json.loads((snap_dir / "config.json").read_text())

    # facebook/musicgen-small ships as a SINGLE merged model.safetensors at
    # the snapshot root (not split into per-submodel directories) — its keys
    # are prefixed by sub-model name ("text_encoder.", "decoder.",
    # "audio_encoder."), plus a top-level "enc_to_dec_proj." pair (the
    # T5-hidden(768) -> decoder-cross-attn(1024) projection, needed by the
    # decoder but not itself namespaced under any of the three sub-models).
    src_weights = snap_dir / "model.safetensors"
    if not src_weights.exists():
        print(f"ERROR: expected weights not found: {src_weights}", file=sys.stderr)
        sys.exit(1)
    all_weights = mx.load(str(src_weights))

    for sub in ("text_encoder", "decoder", "audio_encoder"):
        prefix = f"{sub}."
        weights = {k[len(prefix):]: v for k, v in all_weights.items() if k.startswith(prefix)}
        if not weights:
            print(f"ERROR: no keys found with prefix '{prefix}'", file=sys.stderr)
            sys.exit(1)

        if sub == "decoder":
            weights["enc_to_dec_proj.weight"] = all_weights["enc_to_dec_proj.weight"]
            weights["enc_to_dec_proj.bias"] = all_weights["enc_to_dec_proj.bias"]

        print(f"  [{sub}] {len(weights)} keys")

        out_weights = target_dir / f"{sub}.safetensors"
        mx.save_safetensors(str(out_weights), weights)
        _externalize_weights(str(out_weights))

        out_config = target_dir / f"{sub}_config.json"
        out_config.write_text(json.dumps(top_config[sub], indent=2) + "\n")
        print(f"  [{sub}] wrote {out_config.name}")

    manifest = {
        "name": name,
        "type": "musicgen",
        "arch": "musicgen-small",
        "source": f"https://huggingface.co/{args.model}",
        "components": ["text_encoder", "decoder", "audio_encoder"],
        "cli": {"binary": "musicgen", "action": "generate"},
    }
    (target_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"\n[import-musicgen] done -> {target_dir}")
    print("Validate: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py")


# ---------------------------------------------------------------------------
# External model store (duplicated from import-checkpoint.py's convention —
# see that file's matching section for the authoritative comments)
# ---------------------------------------------------------------------------

def _md5_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _external_store_dir() -> str:
    manifest_file = os.path.join(cfg.MODELS_DIR, "store-manifest.json")
    if os.path.exists(manifest_file):
        with open(manifest_file) as f:
            rel = json.load(f).get("store_relative_to_repo_root", "../video_generation__models")
    else:
        rel = "../video_generation__models"
    return os.path.normpath(os.path.join(cfg.REPO_DIR, rel))


def _externalize_weights(weights_path: str) -> None:
    store_dir = _external_store_dir()
    os.makedirs(store_dir, exist_ok=True)

    md5 = _md5_file(weights_path)
    store_path = os.path.join(store_dir, f"{md5}.safetensors")
    file_size = os.path.getsize(weights_path)

    if os.path.exists(store_path):
        os.remove(weights_path)
    else:
        shutil.move(weights_path, store_path)
        if _md5_file(store_path) != md5:
            raise RuntimeError(f"MD5 mismatch after move to external store: {store_path}")

    rel = os.path.relpath(store_path, os.path.dirname(weights_path))
    os.symlink(rel, weights_path)

    manifest_file = os.path.join(cfg.MODELS_DIR, "store-manifest.json")
    if os.path.exists(manifest_file):
        with open(manifest_file) as f:
            doc = json.load(f)
    else:
        doc = {"version": 1, "store_relative_to_repo_root": "../video_generation__models",
               "count": 0, "files": {}}
    key = os.path.relpath(weights_path, cfg.MODELS_DIR)
    doc["files"][key] = {"md5": md5, "size": file_size}
    doc["count"] = len(doc["files"])
    with open(manifest_file, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")

    _git_add_force(weights_path)


def _git_add_force(path: str) -> None:
    try:
        result = subprocess.run(["git", "add", "-f", "--", path],
                                capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as e:
        print(f"    WARNING: could not run git add -f ({e}) — stage the symlink manually")
        return
    if result.returncode != 0:
        print(f"    WARNING: git add -f failed (rc={result.returncode}): {result.stderr.strip()}")
