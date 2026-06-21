"""import-checkpoint — download and convert a ZImage checkpoint into the MLX model registry.

Downloads a ZImage transformer checkpoint from CivitAI (bf16 safetensors),
applies the same ComfyUI key-remapping and 8-bit MLX quantization used by
convert.py, and registers it in models/transformer/<name>/ with manifest.json
and README.md.

Examples:
  # Import from CivitAI URL (auto-detects bf16 variant)
  run.py import-checkpoint \\
    'https://civitai.com/models/2229037/luciddreamer-z?modelVersionId=2980297'

  # Override the output name
  run.py import-checkpoint 'https://civitai.com/...' --name my-model

  # Skip conversion (already an MLX model directory)
  run.py import-checkpoint /path/to/already-converted/ --no-convert

  # Disable AI metadata enrichment
  run.py import-checkpoint 'https://civitai.com/...' --no-ai
"""

import argparse
import gc
import json
import math
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

import requests

from app import config as cfg

PARSER_META = {
    "help": "Download and convert a ZImage checkpoint into the MLX model registry",
    "description": (
        "Download a ZImage transformer checkpoint from CivitAI and convert it to\n"
        "8-bit MLX format, then register it in models/transformer/<name>/.\n\n"
        "The bf16 variant is automatically selected for download (needed for conversion).\n"
        "AI enrichment runs by default to extract description and metadata.\n"
        "Use --no-ai to disable.\n\n"
        "Examples:\n"
        "  run.py import-checkpoint 'https://civitai.com/models/2229037/...?modelVersionId=2980297'\n"
        "  run.py import-checkpoint 'https://civitai.com/...' --name my-model\n"
    ),
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_CIVITAI_URL_RE = re.compile(r"civitai\.(com|red)/models/(\d+)")
_CIVITAI_API_MODEL = "https://civitai.com/api/v1/models/{model_id}"
_CIVITAI_API_VERSION = "https://civitai.com/api/v1/model-versions/{version_id}"

_DEFAULT_API_URL = "http://localhost:1234/v1"
_DEFAULT_MODEL = "qwen/qwen3-vl-4b"

_MANIFEST_COMMENT = (
    "Private metadata for mlx-movie-director model registry. "
    "Created by convert.py or manually. Validated by `run.py check-manifests`. "
    "See docs/models.md for schema docs."
)

_ZIMAGE_TRANSFORMER_CONFIG = {
    "_class_name": "ZImageTransformer2DModel",
    "_diffusers_version": "0.36.0.dev0",
    "all_f_patch_size": [1],
    "all_patch_size": [2],
    "axes_dims": [32, 48, 48],
    "axes_lens": [1536, 512, 512],
    "cap_feat_dim": 2560,
    "dim": 3840,
    "in_channels": 16,
    "n_heads": 30,
    "n_kv_heads": 30,
    "n_layers": 30,
    "n_refiner_layers": 2,
    "norm_eps": 1e-05,
    "qk_norm": True,
    "rope_theta": 256.0,
    "t_scale": 1000.0,
    "nheads": 30,
}

# ComfyUI key prefix replacements (same as convert.py)
_REPLACE_KEYS = {
    "final_layer.": "all_final_layer.2-1.",
    "x_embedder.": "all_x_embedder.2-1.",
    ".attention.out.bias": ".attention.to_out.0.bias",
    ".attention.k_norm.weight": ".attention.norm_k.weight",
    ".attention.q_norm.weight": ".attention.norm_q.weight",
    ".attention.out.weight": ".attention.to_out.0.weight",
}

_civitai_token_cache: dict = {}

# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("source", metavar="URL_OR_PATH",
                        help="CivitAI URL or local path to a converted transformer directory")
    parser.add_argument("--name", type=str, default=None,
                        help="Output name (default: derived from model metadata or filename)")
    parser.add_argument("--description", type=str, default=None,
                        help="Human-readable description override")
    parser.add_argument("--no-convert", action="store_true", default=False,
                        help="Skip MLX conversion (source is already an MLX model directory)")
    parser.add_argument("--no-ai", action="store_true", default=False,
                        help="Disable AI metadata enrichment")
    parser.add_argument("--api-url", type=str, default=_DEFAULT_API_URL,
                        help=f"LLM API base URL (default: {_DEFAULT_API_URL})")
    parser.add_argument("--model", type=str, default=_DEFAULT_MODEL,
                        help=f"LLM model for AI enrichment (default: {_DEFAULT_MODEL})")
    parser.add_argument("--civitai-token", type=str, default=None,
                        help="CivitAI API token (or set CIVITAI_TOKEN env var)")
    parser.add_argument("--keep-source", action="store_true", default=False,
                        help="Keep the downloaded bf16 safetensors after conversion")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> None:
    token = (getattr(args, "civitai_token", None)
             or os.environ.get("CIVITAI_TOKEN")
             or os.environ.get("CIVITAI_API_TOKEN"))
    if token:
        _civitai_token_cache["token"] = token
        os.environ["CIVITAI_TOKEN"] = token

    src = args.source
    if _is_url(src):
        _run_url_import(src, args)
    else:
        _run_local_import(src, args)


# ---------------------------------------------------------------------------
# URL import flow
# ---------------------------------------------------------------------------

def _run_url_import(url: str, args) -> None:
    print(f"[import-checkpoint] URL: {url}")

    model_id = _parse_civitai_model_id(url)
    if not model_id:
        print("ERROR: only CivitAI URLs are supported for now.", file=sys.stderr)
        sys.exit(1)

    version_id = _parse_civitai_version_id(url)
    if not version_id:
        print(f"  No version ID in URL, fetching latest for model {model_id}...")
        data = _civitai_api_get(_CIVITAI_API_MODEL.format(model_id=model_id))
        versions = data.get("modelVersions", [])
        if not versions:
            print("ERROR: no versions found.", file=sys.stderr)
            sys.exit(1)
        version_id = str(versions[0]["id"])

    version_data = _civitai_api_get(_CIVITAI_API_VERSION.format(version_id=version_id))

    base_model = version_data.get("baseModel", "")
    if "ZImage" not in base_model:
        print(f"WARNING: baseModel is '{base_model}', expected ZImageTurbo. "
              f"Conversion may fail.", file=sys.stderr)

    model_info = version_data.get("model", {})
    model_name = model_info.get("name", f"civitai-{version_id}")
    version_name = version_data.get("name", "")
    name = args.name or _sanitize_name(model_name)

    target_dir = os.path.join(cfg.MODELS_DIR, "transformer", name)
    if os.path.exists(target_dir):
        print(f"ERROR: target already exists: {target_dir}", file=sys.stderr)
        print("  Use --name to choose a different name.", file=sys.stderr)
        sys.exit(1)

    # Choose bf16 file for conversion (preferred) or primary as fallback
    bf16_url, primary_url, bf16_name = _pick_download_file(version_data)
    download_url = bf16_url or primary_url
    if not download_url:
        print("ERROR: no downloadable file found.", file=sys.stderr)
        sys.exit(1)

    fmt_tag = "bf16" if bf16_url else "primary"
    print(f"  Model:    {model_name} — {version_name}")
    print(f"  Name:     {name}")
    print(f"  Variant:  {fmt_tag} ({bf16_name})")
    print(f"  Base:     {base_model}")

    # Description from CivitAI + optional AI enrichment
    description = args.description
    if not description:
        description = f"{model_name} {version_name} ZImage-Turbo transformer, converted to 8-bit MLX"
        if not args.no_ai:
            ai_desc = _try_ai_description(version_data, model_name, args)
            if ai_desc:
                description = ai_desc

    # Download to temp dir
    tmp_dir = tempfile.mkdtemp(prefix="import_ckpt_")
    tmp_file = os.path.join(tmp_dir, bf16_name or f"{name}.safetensors")
    try:
        print(f"\n  Downloading {fmt_tag} safetensors (~{_estimate_gb(version_data, bf16_url):.0f} GB)...")
        _download_file(download_url, tmp_file)

        # Convert
        os.makedirs(target_dir, exist_ok=True)
        _convert_zimage_checkpoint(tmp_file, target_dir)

        # Write manifest + README
        source_url = f"https://civitai.com/models/{version_data.get('modelId', model_id)}"
        size_bytes = _dir_size(target_dir)
        _write_manifest(
            target_dir=target_dir,
            name=name,
            description=description,
            source_url=source_url,
            size_bytes=size_bytes,
        )
        _write_readme(
            target_dir=target_dir,
            name=name,
            description=description,
            source_url=source_url,
        )

        _print_summary(name, target_dir, description, source_url)

    except Exception:
        # Clean up partial target on failure
        if os.path.exists(target_dir) and not os.listdir(target_dir):
            shutil.rmtree(target_dir, ignore_errors=True)
        raise
    finally:
        if not args.keep_source:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            print(f"  Source kept at: {tmp_file}")


# ---------------------------------------------------------------------------
# Local import flow (already-converted MLX directory)
# ---------------------------------------------------------------------------

def _run_local_import(src: str, args) -> None:
    src = os.path.abspath(src)
    if not os.path.isdir(src):
        print(f"ERROR: path is not a directory: {src}", file=sys.stderr)
        print("  For local .safetensors conversion, pass the file URL or use --no-convert.",
              file=sys.stderr)
        sys.exit(1)

    name = args.name or _sanitize_name(os.path.basename(src))
    target_dir = os.path.join(cfg.MODELS_DIR, "transformer", name)

    if os.path.exists(target_dir):
        print(f"ERROR: target already exists: {target_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"[import-checkpoint] Copying local directory → {name}")
    shutil.copytree(src, target_dir)

    description = args.description or f"ZImage-Turbo transformer (imported from {os.path.basename(src)})"
    size_bytes = _dir_size(target_dir)
    _write_manifest(target_dir=target_dir, name=name, description=description,
                    source_url=None, size_bytes=size_bytes)
    _write_readme(target_dir=target_dir, name=name, description=description, source_url=None)
    _print_summary(name, target_dir, description, None)


# ---------------------------------------------------------------------------
# MLX conversion (ZImage / ComfyUI safetensors → 8-bit MLX)
# ---------------------------------------------------------------------------

def _convert_zimage_checkpoint(src_file: str, dst_dir: str) -> None:
    """Convert a ComfyUI-format ZImage safetensors to 8-bit MLX and save to dst_dir."""
    import gc
    import numpy as np
    import torch
    import mlx.core as mx
    import mlx.nn as nn
    from safetensors.torch import load_file as load_pt_file
    from tqdm import tqdm
    from app.transformer import ZImageTransformerMLX

    mb = os.path.getsize(src_file) / 1_048_576
    print(f"\n[convert] Loading {os.path.basename(src_file)} ({mb:.0f} MB)...")
    pt_weights = load_pt_file(src_file)

    # Drop unused key present in some ComfyUI exports
    pt_weights.pop("model.diffusion_model.norm_final.weight", None)

    print("[convert] Remapping ComfyUI keys...")
    keys = list(pt_weights.keys())
    for k in tqdm(keys):
        if ".qkv." in k:
            _remap_qkv(k, pt_weights)
        else:
            _remap_keys(k, pt_weights)

    print("[convert] Converting to MLX BF16...")
    mlx_weights = [_map_key_and_convert(k, v) for k, v in tqdm(pt_weights.items())]
    del pt_weights
    gc.collect()

    print("[convert] Initializing ZImageTransformerMLX and loading weights...")
    model = ZImageTransformerMLX(_ZIMAGE_TRANSFORMER_CONFIG)
    model.load_weights(mlx_weights)
    del mlx_weights
    mx.eval(model.parameters())

    print("[convert] Quantizing to 8-bit (group_size=64)...")
    nn.quantize(model, bits=8, group_size=64)

    out_weights = os.path.join(dst_dir, "model.safetensors")
    out_config = os.path.join(dst_dir, "config.json")

    print(f"[convert] Saving to {dst_dir}...")
    model.save_weights(out_weights)
    with open(out_config, "w") as f:
        json.dump(_ZIMAGE_TRANSFORMER_CONFIG, f, indent=2)

    print(f"[convert] Done.")


# ---------------------------------------------------------------------------
# Key remapping helpers (mirrors convert.py exactly)
# ---------------------------------------------------------------------------

def _remap_qkv(key: str, state_dict: dict) -> None:
    import torch
    weight = state_dict.pop(key)
    to_q, to_k, to_v = weight.chunk(3, dim=0)
    state_dict[key.replace(".qkv.", ".to_q.")] = to_q
    state_dict[key.replace(".qkv.", ".to_k.")] = to_k
    state_dict[key.replace(".qkv.", ".to_v.")] = to_v


def _remap_keys(key: str, state_dict: dict) -> None:
    new_key = key
    for r, rr in _REPLACE_KEYS.items():
        new_key = new_key.replace(r, rr)
    state_dict[new_key] = state_dict.pop(key)


def _map_key_and_convert(key: str, tensor) -> tuple:
    import torch
    import mlx.core as mx

    if isinstance(tensor, torch.Tensor):
        val = tensor.detach().cpu().float().numpy()
    else:
        val = tensor

    new_key = key

    if "t_embedder.mlp.0" in key:
        new_key = key.replace("t_embedder.mlp.0", "t_embedder.linear1")
    elif "t_embedder.mlp.2" in key:
        new_key = key.replace("t_embedder.mlp.2", "t_embedder.linear2")
    elif "all_x_embedder.2-1" in key:
        new_key = key.replace("all_x_embedder.2-1", "x_embedder")
    elif "cap_embedder.0" in key:
        new_key = key.replace("cap_embedder.0", "cap_embedder.layers.0")
    elif "cap_embedder.1" in key:
        new_key = key.replace("cap_embedder.1", "cap_embedder.layers.1")
    elif "all_final_layer.2-1" in key:
        new_key = key.replace("all_final_layer.2-1", "final_layer")

    if "adaLN_modulation.1" in new_key:
        new_key = new_key.replace("adaLN_modulation.1", "adaLN_modulation.layers.1")
    elif "attention.to_out.0" in key:
        new_key = key.replace("attention.to_out.0", "attention.to_out")
    elif "adaLN_modulation.0" in key and "final" not in key:
        new_key = key.replace("adaLN_modulation.0", "adaLN_modulation")
    elif "adaLN_modulation.1" in key and "final" not in key:
        new_key = key.replace("adaLN_modulation.1", "adaLN_modulation")

    return (
        new_key.replace("model.diffusion_model.", ""),
        mx.array(val).astype(mx.bfloat16),
    )


# ---------------------------------------------------------------------------
# CivitAI helpers
# ---------------------------------------------------------------------------

def _parse_civitai_model_id(url: str) -> str | None:
    m = _CIVITAI_URL_RE.search(url)
    return m.group(2) if m else None


def _parse_civitai_version_id(url: str) -> str | None:
    params = parse_qs(urlparse(url).query)
    vids = params.get("modelVersionId", [])
    return vids[0] if vids else None


def _civitai_api_get(url: str) -> dict:
    token = (os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN")
             or _civitai_token_cache.get("token"))
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, timeout=30, headers=headers)
    resp.raise_for_status()
    return resp.json()


def _pick_download_file(version_data: dict) -> tuple[str | None, str | None, str]:
    """Return (bf16_url, primary_url, filename).

    Prefers the bf16 variant for conversion quality; falls back to the primary file.
    """
    files = version_data.get("files", [])
    bf16_url = None
    bf16_name = ""
    primary_url = None
    primary_name = ""

    for f in files:
        meta = f.get("metadata", {}) or {}
        fp = meta.get("fp", "")
        name = f.get("name", "")
        dl_url = f.get("downloadUrl", "")
        if fp == "bf16":
            bf16_url = dl_url
            bf16_name = name
        if f.get("primary") and not primary_url:
            primary_url = dl_url
            primary_name = name

    return bf16_url, primary_url, bf16_name or primary_name


def _estimate_gb(version_data: dict, target_url: str | None) -> float:
    """Estimate download size in GB by matching the target URL to a file entry."""
    for f in version_data.get("files", []):
        if f.get("downloadUrl") == target_url:
            return f.get("sizeKB", 0) / 1_048_576
    return 0.0


# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

def _download_file(url: str, dest_path: str, chunk_size: int = 65536) -> None:
    token = (os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN")
             or _civitai_token_cache.get("token"))
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, stream=True, timeout=600, allow_redirects=True, headers=headers)
    resp.raise_for_status()

    total = int(resp.headers.get("content-length", 0))
    downloaded = 0
    last_pct = -1

    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=chunk_size):
            f.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = math.floor(downloaded / total * 100)
                if pct != last_pct and pct % 10 == 0:
                    print(f"    {pct}% ({downloaded/1_048_576:.1f}/{total/1_048_576:.1f} MB)")
                    last_pct = pct

    print(f"    Done: {os.path.getsize(dest_path)/1_048_576:.1f} MB")


# ---------------------------------------------------------------------------
# AI metadata enrichment
# ---------------------------------------------------------------------------

def _try_ai_description(version_data: dict, model_name: str, args) -> str | None:
    if not _check_llm_available(args.api_url):
        return None

    model_desc = _truncate_html(version_data.get("description", ""), 1500)
    version_name = version_data.get("name", "")
    base_model = version_data.get("baseModel", "")

    prompt = (
        f"You are a model registry assistant. Generate a concise one-line description "
        f"(under 120 characters) for a {base_model} image generation checkpoint.\n\n"
        f"Model name: {model_name} {version_name}\n"
        f"Description: {model_desc}\n\n"
        f"Respond with ONLY the one-line description, no quotes, no markdown."
    )

    result = _call_llm(args.api_url, args.model, prompt)
    if result:
        result = result.strip().strip('"').strip("'")
        if len(result) < 150:
            return result
    return None


def _call_llm(api_url: str, model: str, prompt: str) -> str | None:
    url = f"{api_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 256,
        "temperature": 0.2,
        "stream": False,
    }
    try:
        resp = requests.post(url, json=payload, timeout=30)
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  [ai] LLM call failed: {e}", file=sys.stderr)
        return None
    return re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()


def _check_llm_available(api_url: str, timeout: float = 3.0) -> bool:
    try:
        resp = requests.get(f"{api_url}/models", timeout=timeout)
        return resp.status_code == 200
    except Exception:
        return False


def _truncate_html(html: str, max_chars: int = 1500) -> str:
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_chars] + "..." if len(text) > max_chars else text


# ---------------------------------------------------------------------------
# Manifest + README
# ---------------------------------------------------------------------------

def _write_manifest(*, target_dir: str, name: str, description: str,
                    source_url: str | None, size_bytes: int) -> None:
    manifest = {
        "_comment": _MANIFEST_COMMENT,
        "name": name,
        "type": "transformer",
        "arch": "zimage-turbo",
        "format": "mlx-8bit",
        "description": description,
        "source": source_url or "manual-import",
        "pipeline": ["zimage-turbo"],
        "cli": {
            "action": "image t2i",
            "pipeline": "zimage",
            "transformer": name,
            "note": f"use --transformer {name} to select this checkpoint",
        },
        "compatible_with": [
            "text_encoder/qwen3-4b",
            "tokenizer/qwen3",
            "vae/zimage-ae",
        ],
        "size_bytes": size_bytes,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if source_url:
        manifest["source_url"] = source_url

    path = os.path.join(target_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _write_readme(*, target_dir: str, name: str, description: str,
                  source_url: str | None) -> None:
    lines = [
        f"# {name} — ZImage-Turbo Transformer (8-bit MLX)",
        "",
        description + ".",
        "",
    ]
    if source_url:
        lines += [f"Source: [{source_url}]({source_url})", ""]

    lines += [
        "## Usage",
        "",
        "```bash",
        f"python/venv/bin/python python/mlx-movie-director/run.py \\",
        f"  image t2i --pipeline zimage --transformer {name} \\",
        f"  --prompt 'your prompt here'",
        "```",
        "",
        "## Notes",
        "",
        "- Format: 8-bit quantized MLX (group_size=64)",
        "- Converted from CivitAI bf16 safetensors via `import-checkpoint`",
        "- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae",
        "",
    ]

    with open(os.path.join(target_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def _sanitize_name(raw: str) -> str:
    name = raw.lower()
    name = re.sub(r"[^a-z0-9-]", "-", name)
    name = re.sub(r"-{2,}", "-", name)
    name = name.strip("-")
    if not name:
        print(f"ERROR: name '{raw}' produces empty slug", file=sys.stderr)
        sys.exit(1)
    return name


def _dir_size(path: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total


def _print_summary(name: str, target_dir: str, description: str,
                   source_url: str | None) -> None:
    size_mb = _dir_size(target_dir) / 1_048_576
    print(f"\n[import-checkpoint] Imported: {name}")
    print(f"  Directory:  {target_dir}")
    print(f"  Size:       {size_mb:.0f} MB (8-bit MLX)")
    print(f"  Arch:       zimage-turbo")
    print(f"  Format:     mlx-8bit")
    if source_url:
        print(f"  Source:     {source_url}")
    print()
    print(f"Validate: run.py check-model")
    print(f"Test:     run.py image t2i --pipeline zimage --transformer {name} \\")
    print(f"            --prompt 'a dreamlike portrait'")
