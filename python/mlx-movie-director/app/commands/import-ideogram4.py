"""import-ideogram4 — fetch Ideogram 4 NF4 weights from HuggingFace into the MLX registry.

Downloads the bitsandbytes-NF4 components of ``ideogram-ai/ideogram-4-nf4`` and
registers them under the MLX model tree, externalizing each large safetensors to
``../video_generation__models/<md5>.safetensors`` (symlink only is committed — the
content-addressed-store invariant). NF4 is loaded AS-IS (no re-quantization): the
fork-free ``app.ideogram4_nf4.NF4Linear`` dequantizes at load time on stock mlx.

Prerequisite: accept the ``ideogram-ai/ideogram-4-nf4`` license on HuggingFace and
``hf auth login`` (or set HF_TOKEN) — the repo is gated.

Components fetched:
  text_encoder/  → models/text_encoder/qwen3vl-ideogram4/   (config.json + model.safetensors)
  tokenizer/     → models/tokenizer/qwen3vl-ideogram4/      (tokenizer.json + config + chat_template)
  transformer/   → models/transformer/ideogram4-cond/       (diffusion_pytorch_model.safetensors)
  unconditional_transformer/ → models/transformer/ideogram4-uncond/
  vae/           → models/vae/ideogram4-vae/

Total ~16 GB. After this, generate with:
  run.py image t2i --pipeline ideogram4 --self-test
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

from app import config as cfg

PARSER_META = {
    "help": "Fetch Ideogram 4 NF4 weights from HuggingFace into the MLX model registry",
    "description": (
        "Download the gated ideogram-ai/ideogram-4-nf4 NF4 components and register them "
        "under models/ (text_encoder, tokenizer, cond + uncond transformers, vae). Each "
        "safetensors is externalized to ../video_generation__models/<md5>.safetensors "
        "(symlink committed). NF4 is loaded as-is — app.ideogram4_nf4 dequantizes at load "
        "on stock mlx (no custom fork).\n\n"
        "Prerequisite: accept the repo license on HuggingFace + `hf auth login` (or HF_TOKEN).\n\n"
        "After import: run.py image t2i --pipeline ideogram4 --self-test\n"
    ),
}

_DEFAULT_REPO = "ideogram-ai/ideogram-4-nf4"

# (label, hf_repo_path, target_dir, target_filename, externalize?)
_COMPONENTS = [
    ("text encoder", "text_encoder/model.safetensors", cfg.IDEOGRAM4_TEXT_ENCODER_DIR, "model.safetensors", True),
    ("text encoder config", "text_encoder/config.json", cfg.IDEOGRAM4_TEXT_ENCODER_DIR, "config.json", False),
    ("tokenizer", "tokenizer/tokenizer.json", cfg.IDEOGRAM4_TOKENIZER_DIR, "tokenizer.json", False),
    ("tokenizer config", "tokenizer/tokenizer_config.json", cfg.IDEOGRAM4_TOKENIZER_DIR, "tokenizer_config.json", False),
    ("chat template", "tokenizer/chat_template.jinja", cfg.IDEOGRAM4_TOKENIZER_DIR, "chat_template.jinja", False),
    ("cond transformer", "transformer/diffusion_pytorch_model.safetensors", cfg.IDEOGRAM4_COND_TRANSFORMER_DIR, "diffusion_pytorch_model.safetensors", True),
    ("uncond transformer", "unconditional_transformer/diffusion_pytorch_model.safetensors", cfg.IDEOGRAM4_UNCOND_TRANSFORMER_DIR, "diffusion_pytorch_model.safetensors", True),
    ("vae", "vae/diffusion_pytorch_model.safetensors", cfg.IDEOGRAM4_VAE_DIR, "diffusion_pytorch_model.safetensors", True),
]

# Per-component metadata for manifest.json (full check-model REQUIRED_FIELDS schema)
# + config.json stubs (transformer/vae require config.json; text_encoder ships its own).
_COMMON_COMPAT = [
    "text_encoder/qwen3vl-ideogram4",
    "tokenizer/qwen3vl-ideogram4-tok",
    "vae/ideogram4-vae",
]
_COMPONENT_META: dict[str, dict] = {
    cfg.IDEOGRAM4_TEXT_ENCODER_DIR: {
        "type": "text_encoder", "arch": "qwen3-vl", "format": "bnb-nf4",
        "description": ("Modified Qwen3-VL 8.8B text encoder for Ideogram4 — extracts 13-layer "
                        "deep hidden states concatenated to the 53248-dim llm_features the DiT "
                        "consumes. NF4 bnb; dequantized at load by app.ideogram4_nf4 (fork-free)."),
        "compatible_with": ["transformer/ideogram4-cond", "transformer/ideogram4-uncond"],
    },
    cfg.IDEOGRAM4_TOKENIZER_DIR: {
        "type": "tokenizer", "arch": "qwen3-vl", "format": "hf-tokenizer",
        "description": "Qwen3-VL tokenizer + chat template for the Ideogram4 text encoder.",
        "compatible_with": ["text_encoder/qwen3vl-ideogram4",
                            "transformer/ideogram4-cond", "transformer/ideogram4-uncond"],
    },
    cfg.IDEOGRAM4_COND_TRANSFORMER_DIR: {
        "type": "transformer", "arch": "ideogram4-dit", "format": "bnb-nf4",
        "description": ("Ideogram4 conditional 9.3B flow-matching DiT (poster/slide-optimized t2i, "
                        "legible rendered text). NF4 bnb; dequantized at load by app.ideogram4_nf4."),
        "compatible_with": _COMMON_COMPAT,
        "config": {"num_layers": 34, "emb_dim": 4608, "num_heads": 18,
                   "intermediate_size": 12288, "in_channels": 128, "head_dim": 256,
                   "rope_theta": 5_000_000, "mrope_section": [24, 20, 20]},
    },
    cfg.IDEOGRAM4_UNCOND_TRANSFORMER_DIR: {
        "type": "transformer", "arch": "ideogram4-dit", "format": "bnb-nf4",
        "description": ("Ideogram4 unconditional 9.3B flow-matching DiT (the CFG negative branch). "
                        "NF4 bnb; dequantized at load by app.ideogram4_nf4."),
        "compatible_with": _COMMON_COMPAT,
        "config": {"num_layers": 34, "emb_dim": 4608, "num_heads": 18,
                   "intermediate_size": 12288, "in_channels": 128, "head_dim": 256,
                   "rope_theta": 5_000_000, "mrope_section": [24, 20, 20]},
    },
    cfg.IDEOGRAM4_VAE_DIR: {
        "type": "vae", "arch": "flux2-kl", "format": "safetensors-bf16",
        "description": ("Flux2 KL-VAE decoder for Ideogram4 (latents → pixels) with the vendored "
                        "128-dim LATENT_SHIFT/LATENT_SCALE. bf16 safetensors, decoder-only."),
        "compatible_with": ["transformer/ideogram4-cond", "transformer/ideogram4-uncond"],
        "config": {"in_channels": 3, "out_channels": 3, "latent_channels": 16},
    },
}


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--repo", default=_DEFAULT_REPO,
        help=f"HuggingFace repo (default: {_DEFAULT_REPO})",
    )
    parser.add_argument(
        "--token", default=None,
        help="HuggingFace token (default: HF_TOKEN env / stored hf auth login). Required — the repo is gated.",
    )
    parser.add_argument(
        "--re-download", action="store_true", default=False,
        help="Re-download + re-externalize even if a component already exists",
    )


# ---------------------------------------------------------------------------
# External store helpers (same pattern as import-checkpoint / import-vae — the
# hyphen command filenames prevent cross-module import, so these are duplicated)
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
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(cfg.MODELS_DIR)))
    return os.path.normpath(os.path.join(repo_root, rel))


def _git_add_force(path: str) -> None:
    try:
        subprocess.run(["git", "add", "-f", "--", path], capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as e:
        print(f"    ⚠ could not run `git add -f` ({e}) — stage the symlink manually")


def _externalize_weights(weights_path: str) -> str:
    """Move a safetensors to the external store, replace with a relative symlink, update store-manifest."""
    store_dir = _external_store_dir()
    os.makedirs(store_dir, exist_ok=True)
    md5 = _md5_file(weights_path)
    store_path = os.path.join(store_dir, f"{md5}.safetensors")
    size_bytes = os.path.getsize(weights_path)
    if os.path.exists(store_path):
        os.remove(weights_path)  # dedup
    else:
        shutil.move(weights_path, store_path)
    os.symlink(os.path.relpath(store_path, os.path.dirname(weights_path)), weights_path)

    manifest_file = os.path.join(cfg.MODELS_DIR, "store-manifest.json")
    doc = (
        json.load(open(manifest_file)) if os.path.exists(manifest_file)
        else {"version": 1, "store_relative_to_repo_root": "../video_generation__models", "count": 0, "files": {}}
    )
    doc["files"][os.path.relpath(weights_path, cfg.MODELS_DIR)] = {"md5": md5, "size": size_bytes}
    doc["count"] = len(doc["files"])
    with open(manifest_file, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    _git_add_force(weights_path)
    return md5


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def _resolve_token(args) -> str | None:
    token = getattr(args, "token", None) or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        try:
            from huggingface_hub.utils import get_token
            token = get_token()
        except Exception:
            token = None
    if not token:
        print(
            "ERROR: no HuggingFace token. Accept the ideogram-ai/ideogram-4-nf4 license,\n"
            "then run `hf auth login` (or set HF_TOKEN). The repo is gated.",
            file=sys.stderr,
        )
        sys.exit(1)
    return token


def run(args: argparse.Namespace) -> None:
    from huggingface_hub import hf_hub_download

    repo = getattr(args, "repo", _DEFAULT_REPO) or _DEFAULT_REPO
    token = _resolve_token(args)
    force = getattr(args, "re_download", False)

    print(f"[import-ideogram4] repo: {repo}")
    sizes: dict[str, int] = {}
    for label, hf_path, target_dir, target_name, externalize in _COMPONENTS:
        dest = os.path.join(target_dir, target_name)
        if os.path.exists(dest) and not force:
            print(f"  [{label}] exists, skip ({'symlink→store' if os.path.islink(dest) else 'file'})")
            continue
        os.makedirs(target_dir, exist_ok=True)
        print(f"  [{label}] downloading {hf_path} ...")
        cached = hf_hub_download(repo, hf_path, token=token)
        shutil.copyfile(os.path.realpath(cached), dest)  # copy real blob (cached copy stays in HF cache)
        if externalize:
            md5 = _externalize_weights(dest)
            sizes[label] = os.path.getsize(os.path.realpath(dest))
            print(f"    externalized → {md5}.safetensors")
        else:
            sizes[label] = os.path.getsize(dest)
            print(f"    placed {target_name} ({sizes[label]} bytes)")

    # Per-component manifest.json (full check-model schema) + config.json stubs
    # (transformer/vae require config.json; text_encoder ships its own from HF).
    _write_manifest(cfg.IDEOGRAM4_TEXT_ENCODER_DIR, "qwen3vl-ideogram4-text-encoder", repo)
    _write_manifest(cfg.IDEOGRAM4_TOKENIZER_DIR, "qwen3vl-ideogram4-tokenizer", repo)
    _write_manifest(cfg.IDEOGRAM4_COND_TRANSFORMER_DIR, "ideogram4-cond-transformer", repo)
    _write_manifest(cfg.IDEOGRAM4_UNCOND_TRANSFORMER_DIR, "ideogram4-uncond-transformer", repo)
    _write_manifest(cfg.IDEOGRAM4_VAE_DIR, "ideogram4-vae", repo)
    # config.json stubs for categories that require it (transformer/vae),
    # + lift the text_encoder's nested text_config fields to top level for the schema check.
    # (tokenizer is CONFIG_OPTIONAL — skip it.)
    for model_dir, meta in _COMPONENT_META.items():
        if "config" in meta or meta.get("type") == "text_encoder":
            _write_config_stub(model_dir, meta.get("config", {}))

    total_gb = sum(sizes.values()) / 1e9
    print(f"\n[import-ideogram4] done. ~{total_gb:.1f} GB across {len(sizes)} files.")
    print("  Generate with: run.py image t2i --pipeline ideogram4 --self-test")


def _dir_size_bytes(model_dir: str) -> int:
    """Mirror check-model's size computation exactly:
    - sum *.safetensors (the weight files, following symlinks to the store), else
    - the single primary weight file for non-safetensors dirs (tokenizer.json).
    Excludes manifest.json/config.json/README.md (metadata, not weights).
    """
    import glob
    safetensors = glob.glob(os.path.join(model_dir, "*.safetensors"))
    if safetensors:
        total = 0
        for p in safetensors:
            try:
                total += os.path.getsize(p)  # getsize follows symlinks
            except OSError:
                pass
        return total
    # Non-safetensors dir (tokenizer): match check-model's single-weight-file path.
    for primary in ("tokenizer.json", "model.safetensors"):
        p = os.path.join(model_dir, primary)
        if os.path.exists(p):
            try:
                return os.path.getsize(p)
            except OSError:
                pass
    return 0


def _write_readme(model_dir: str, repo: str) -> None:
    """check-model requires a README.md per instance. Minimal provenance stub."""
    readme_path = os.path.join(model_dir, "README.md")
    if os.path.exists(readme_path):
        return
    name = os.path.basename(model_dir.rstrip("/"))
    body = (
        f"# {name}\n\n"
        f"Ideogram 4 component (poster/slide-optimized t2i). Source: "
        f"[{repo}](https://huggingface.co/{repo}).\n\n"
        "NF4 (bitsandbytes) weights are loaded as-is and dequantized at load by "
        "`app/ideogram4_nf4` (fork-free, stock mlx — no `lyonsno/mlx@nf4` dependency). "
        "Runtime architecture lives in `app/ideogram4_{transformer,vae,pipeline}.py`. "
        "See `manifest.json` for metadata and the project root `CLAUDE.md` / "
        "`docs/` for the full pipeline description.\n"
    )
    with open(readme_path, "w") as f:
        f.write(body)
    _git_add_force(readme_path)


def _write_manifest(model_dir: str, name: str, repo: str) -> None:
    """Emit a manifest.json satisfying check-model's REQUIRED_FIELDS schema.

    `name` MUST equal the directory basename (check-model enforces this) — so the
    passed name is overridden with basename. Pulls type/arch/format/description/
    compatible_with from _COMPONENT_META; computes size_bytes from the dir's files;
    stamps created_at (UTC ISO); writes the required README.md.
    """
    from datetime import datetime, timezone

    meta = _COMPONENT_META.get(model_dir, {})
    basename = os.path.basename(model_dir.rstrip("/"))
    doc = {
        "name": basename,
        "type": meta.get("type", "unknown"),
        "arch": meta.get("arch", "ideogram4"),
        "format": meta.get("format", "bnb-nf4"),
        "description": meta.get("description", "Ideogram4 model component."),
        "source": repo,
        "source_url": f"https://huggingface.co/{repo}",
        "hf_repo": repo,
        "pipeline": ["ideogram4"],
        "compatible_with": meta.get("compatible_with", []),
        "size_bytes": _dir_size_bytes(model_dir),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": ("NF4 bnb weights loaded as-is; app.ideogram4_nf4 dequantizes at load "
                 "(fork-free, stock mlx). See app/ideogram4_*.py."),
    }
    with open(os.path.join(model_dir, "manifest.json"), "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    _git_add_force(os.path.join(model_dir, "manifest.json"))
    _write_readme(model_dir, repo)


def _write_config_stub(model_dir: str, fields: dict) -> None:
    """Ensure config.json satisfies the category's CONFIG_SCHEMAS check
    (transformer: layer count + dim; vae: in/out/latent channels).

    For dirs with a real config (the HF text_encoder), MERGE only the missing
    schema fields to top level (its `text_config` sub-dict is read by the runtime,
    so adding top-level hidden_size/num_hidden_layers is harmless). For dirs
    without one (transformer/vae), write a minimal stub. Metadata only — the
    runtime reads architecture from the vendored app/ideogram4_*.py classes.
    """
    cfg_path = os.path.join(model_dir, "config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path) as f:
            existing = json.load(f)
    else:
        existing = {"_comment": "Minimal stub for check-model; runtime arch is in app/ideogram4_transformer.py / app/ideogram4_vae.py."}
    # If the config nests text_config (HF Qwen3-VL), lift hidden_size /
    # num_hidden_layers to top level so the text_encoder schema check passes.
    tc = existing.get("text_config") if isinstance(existing.get("text_config"), dict) else None
    if tc:
        for k in ("hidden_size", "num_hidden_layers", "num_attention_heads"):
            if k in tc and k not in existing:
                existing[k] = tc[k]
    for k, v in fields.items():
        existing.setdefault(k, v)
    with open(cfg_path, "w") as f:
        json.dump(existing, f, indent=2)
        f.write("\n")
    _git_add_force(cfg_path)
