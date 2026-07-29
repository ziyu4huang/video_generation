"""import-kontext — copy FLUX.1-Kontext-dev's transformer/CLIP/T5 weights and
tokenizer files from the local HF cache into this repo's mlx-models/
external-store convention, for the Swift `flux2 kontext` production path.

Unlike import-musicgen.py, this is a COPY, not a conversion: the raw HF
safetensors for the transformer/CLIP/T5 use an identity key mapping already
(confirmed by KontextTransformerWeights.load / KontextCLIPWeights.load /
KontextT5Weights.load in swift/flux2-image-director, which read these
directories directly) — no mx.load/remap/mx.save round-trip needed. The VAE
is NOT handled here — it was already converted separately (convert.py
--kontext-vae-mlx) and lives at mlx-models/vae/flux-kontext-ae/.

FLUX.1-Kontext-dev is a GATED HF repo — the first `snapshot_download` on a
fresh machine requires `huggingface-cli login` / HF_TOKEN and accepting the
license at https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev. This
session's snapshot is already cached (used by `flux2 verify-kontext-*`), so
`snapshot_download` here is a cache hit, not a fresh download.

This is dev-tooling only (same standing-rule carve-out as import-checkpoint.py/
import-musicgen.py) — not a production generation code path.

Usage:
  run.py import-kontext
  run.py import-kontext --model black-forest-labs/FLUX.1-Kontext-dev --name kontext-dev
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from app import config as cfg

PARSER_META = {
    "help": "Copy FLUX.1-Kontext-dev transformer/CLIP/T5 weights for the Swift kontext port",
    "description": (
        "Copies the transformer/text_encoder/text_encoder_2 subdirectories of a\n"
        "locally-cached black-forest-labs/FLUX.1-Kontext-dev snapshot into\n"
        "mlx-models/{transformer,text_encoder,tokenizer}/, externalizing each\n"
        "weights/tokenizer file into the shared video_generation__models/ store.\n\n"
        "Examples:\n"
        "  run.py import-kontext\n"
        "  run.py import-kontext --model black-forest-labs/FLUX.1-Kontext-dev --name kontext-dev\n"
    ),
}


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", type=str, default="black-forest-labs/FLUX.1-Kontext-dev",
                        help="HF model id (default: black-forest-labs/FLUX.1-Kontext-dev)")
    parser.add_argument("--name", type=str, default="kontext-dev",
                        help="Base output name (default: kontext-dev)")


def run(args: argparse.Namespace) -> None:
    name = args.name
    transformer_dir = Path(cfg.MODELS_DIR) / "transformer" / name
    clip_dir = Path(cfg.MODELS_DIR) / "text_encoder" / f"{name}-clip"
    t5_dir = Path(cfg.MODELS_DIR) / "text_encoder" / f"{name}-t5"
    # "-tok" suffix (not just "-clip"/"-t5") because check-model.py enforces
    # 'name' uniqueness GLOBALLY across every category, not just within
    # tokenizer/ — reusing the text_encoder/ basenames here trips its
    # duplicate-name check even though the two live in different categories.
    clip_tok_dir = Path(cfg.MODELS_DIR) / "tokenizer" / f"{name}-clip-tok"
    t5_tok_dir = Path(cfg.MODELS_DIR) / "tokenizer" / f"{name}-t5-tok"

    for d in (transformer_dir, clip_dir, t5_dir, clip_tok_dir, t5_tok_dir):
        if d.exists():
            print(f"ERROR: target already exists: {d}", file=sys.stderr)
            sys.exit(1)

    made = []
    try:
        snap_dir = _resolve_snapshot(args.model)

        made.append(_copy_component(
            src=snap_dir / "transformer", dst=transformer_dir,
            category="transformer",
            description="FLUX.1-Kontext-dev transformer (19 joint + 38 single blocks, "
                        "unquantized bf16) for the swift/flux2-image-director kontext port.",
            cli={"binary": "flux2", "action": "kontext", "flag": "--transformer"},
        ))
        made.append(_copy_component(
            src=snap_dir / "text_encoder", dst=clip_dir,
            category="text_encoder",
            description="FLUX.1-Kontext-dev CLIP text encoder (pooled projection, 768-dim).",
            cli={"binary": "flux2", "action": "kontext", "flag": "--clip-encoder"},
        ))
        made.append(_copy_component(
            src=snap_dir / "text_encoder_2", dst=t5_dir,
            category="text_encoder",
            description="FLUX.1-Kontext-dev T5 text encoder (t5-v1_1-xxl-derived, 4096-dim).",
            cli={"binary": "flux2", "action": "kontext", "flag": "--t5-encoder"},
            # Real T5 HF configs use `d_model`, not `hidden_size` — check-model's
            # text_encoder schema requires one of hidden_size/cross_attention_dim.
            # Add a hidden_size alias (copy, not rename) so check-model passes
            # without touching check-model.py's shared schema.
            config_aliases={"hidden_size": "d_model"},
        ))
        made.append(_copy_tokenizer_clip(snap_dir / "tokenizer", clip_tok_dir))
        made.append(_copy_tokenizer_t5(snap_dir / "tokenizer_2", t5_tok_dir))
    except BaseException:
        for d in made:
            shutil.rmtree(d, ignore_errors=True)
        raise

    print(f"\n[import-kontext] done:")
    print(f"  transformer -> {transformer_dir}")
    print(f"  clip        -> {clip_dir}")
    print(f"  t5          -> {t5_dir}")
    print(f"  clip tok    -> {clip_tok_dir}")
    print(f"  t5 tok      -> {t5_tok_dir}")
    print("Validate: python/venv/bin/python python/mlx-movie-director/run.py check-model")


def _resolve_snapshot(model: str) -> Path:
    from huggingface_hub import snapshot_download
    try:
        return Path(snapshot_download(repo_id=model))
    except Exception as exc:
        msg = str(exc).lower()
        if "gated" in msg or "401" in msg or "unauthorized" in msg or "access" in msg:
            print(
                f"[import-kontext] {model} is a GATED HF repo. Accept the license at\n"
                f"          https://huggingface.co/{model}\n"
                "          and set HF_TOKEN (huggingface-cli login) before retrying.",
                file=sys.stderr,
            )
        raise


def _copy_component(*, src: Path, dst: Path, category: str, description: str,
                    cli: dict, config_aliases: dict | None = None) -> Path:
    if not src.exists():
        print(f"ERROR: expected source dir not found: {src}", file=sys.stderr)
        sys.exit(1)
    dst.mkdir(parents=True, exist_ok=True)

    shard_count = 0
    for f in sorted(src.glob("*.safetensors")):
        out = dst / f.name
        shutil.copy(f, out)
        _externalize_weights(str(out))
        shard_count += 1
    if shard_count == 0:
        print(f"ERROR: no .safetensors shards found in {src}", file=sys.stderr)
        sys.exit(1)
    print(f"  [{dst.name}] copied {shard_count} safetensors shard(s)")

    config_src = src / "config.json"
    if config_src.exists():
        config = json.loads(config_src.read_text())
        for alias_key, source_key in (config_aliases or {}).items():
            if alias_key not in config and source_key in config:
                config[alias_key] = config[source_key]
        (dst / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    else:
        print(f"  WARNING: no config.json at {config_src} — check-model's "
              f"{category} schema check will fail without one", file=sys.stderr)

    manifest = {
        "name": dst.name,
        "type": category,
        "arch": "flux1-kontext-dev",
        "format": "mlx-bf16",
        "description": description,
        "source": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev",
        "cli": cli,
        "compatible_with": [],
        "size_bytes": _dir_size(str(dst)),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (dst / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (dst / "README.md").write_text(
        f"# {dst.name}\n\n{description}\n\n"
        f"Source: [black-forest-labs/FLUX.1-Kontext-dev]"
        f"(https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)\n\n"
        f"Imported via `run.py import-kontext`.\n"
    )
    return dst


def _copy_tokenizer_clip(src: Path, dst: Path) -> Path:
    if not src.exists():
        print(f"ERROR: expected CLIP tokenizer dir not found: {src}", file=sys.stderr)
        sys.exit(1)
    dst.mkdir(parents=True, exist_ok=True)
    for fname in ("vocab.json", "merges.txt"):
        f = src / fname
        if not f.exists():
            print(f"ERROR: expected {fname} not found at {f}", file=sys.stderr)
            sys.exit(1)
        shutil.copy(f, dst / fname)
    (dst / "manifest.json").write_text(json.dumps({
        "name": dst.name, "type": "tokenizer", "arch": "clip-vit-l",
        "format": "hf-tokenizer", "description": "FLUX.1-Kontext-dev CLIP tokenizer (vocab.json + merges.txt).",
        "source": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev",
        "compatible_with": [], "size_bytes": _dir_size(str(dst)),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2) + "\n")
    (dst / "README.md").write_text(f"# {dst.name}\n\nCLIP tokenizer (vocab.json + merges.txt) "
                                   "for the Swift kontext port. Imported via `run.py import-kontext`.\n")
    print(f"  [{dst.name}] copied vocab.json + merges.txt")
    return dst


def _copy_tokenizer_t5(src: Path, dst: Path) -> Path:
    if not src.exists():
        print(f"ERROR: expected T5 tokenizer dir not found: {src}", file=sys.stderr)
        sys.exit(1)
    dst.mkdir(parents=True, exist_ok=True)
    f = src / "tokenizer.json"
    if not f.exists():
        print(f"ERROR: expected tokenizer.json not found at {f}", file=sys.stderr)
        sys.exit(1)
    out = dst / "tokenizer.json"
    shutil.copy(f, out)
    _externalize_weights(str(out))   # T5's tokenizer.json is typically >2MB
    (dst / "manifest.json").write_text(json.dumps({
        "name": dst.name, "type": "tokenizer", "arch": "t5-v1_1-xxl",
        "format": "hf-tokenizer", "description": "FLUX.1-Kontext-dev T5 tokenizer (SentencePiece Unigram, tokenizer.json).",
        "source": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev",
        "compatible_with": [], "size_bytes": _dir_size(str(dst)),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2) + "\n")
    (dst / "README.md").write_text(f"# {dst.name}\n\nT5 tokenizer (tokenizer.json) "
                                   "for the Swift kontext port. Imported via `run.py import-kontext`.\n")
    print(f"  [{dst.name}] copied + externalized tokenizer.json")
    return dst


# ---------------------------------------------------------------------------
# External model store (duplicated from import-musicgen.py's convention —
# see that file's matching section for the authoritative comments)
# ---------------------------------------------------------------------------

def _dir_size(path: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            real = os.path.realpath(fp)
            if os.path.isfile(real):
                total += os.path.getsize(real)
    return total


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
    ext = os.path.splitext(weights_path)[1] or ".safetensors"
    store_path = os.path.join(store_dir, f"{md5}{ext}")
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
