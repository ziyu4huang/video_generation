"""import-vae — download and convert a ZImage VAE from CivitAI into the MLX model registry.

Downloads a ZImage-Turbo VAE safetensors from CivitAI, converts to MLX BF16 using the
same mflux ZImageWeightMapping used by convert.py --vae-mlx, externalizes the binary to
../video_generation__models/<md5>.safetensors (symlink only committed to git), and writes
manifest.json + README.md.

Examples:
  run.py import-vae 'https://civitai.com/models/2191617/z-imageclearvae?modelVersionId=2493436'
  run.py import-vae 'https://civitai.com/...' --name my-vae
"""

import argparse
import gc
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

import requests

from app import config as cfg

PARSER_META = {
    "help": "Download and convert a ZImage VAE checkpoint into the MLX model registry",
    "description": (
        "Download a ZImage VAE from CivitAI and convert it to MLX BF16 format,\n"
        "then register it in models/vae/<name>/ with manifest.json and README.md.\n\n"
        "The large binary is externalized to ../video_generation__models/ — only the\n"
        "symlink is committed to git. Same pattern as import-checkpoint.\n\n"
        "Examples:\n"
        "  run.py import-vae 'https://civitai.com/models/2191617/...?modelVersionId=2493436'\n"
        "  run.py import-vae 'https://civitai.com/...' --name my-vae\n"
    ),
}

# ---------------------------------------------------------------------------
# CivitAI API endpoints
# ---------------------------------------------------------------------------

_CIVITAI_API_MODEL   = "https://civitai.com/api/v1/models/{model_id}"
_CIVITAI_API_VERSION = "https://civitai.com/api/v1/model-versions/{version_id}"
_CIVITAI_URL_RE      = re.compile(r"civitai\.com/models/(\d+)")
_civitai_token_cache: dict = {}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("source", nargs="?", default=None,
                        help="CivitAI URL for the VAE (omit with --self-test to run post-import check)")
    parser.add_argument("--name", default="", help="Override the registry name (default: sanitized model name)")
    parser.add_argument("--description", default="", help="Override the description")
    parser.add_argument("--no-ai", action="store_true", help="Skip AI metadata enrichment")
    parser.add_argument("--keep-source", action="store_true", help="Keep the downloaded safetensors after conversion")
    parser.add_argument("--self-test", nargs="?", const=True, metavar="VAE_NAME",
                        help="Run post-import check on the named VAE (or 'z-imageclearvae' by default). "
                             "Verifies the symlink, manifest, and encode/decode shapes.")
    parser.add_argument(
        "--api-url", default="http://127.0.0.1:1234",
        help="LM Studio endpoint for AI metadata enrichment (default: http://127.0.0.1:1234)"
    )


def run(args: argparse.Namespace) -> None:
    self_test = getattr(args, "self_test", None)
    source = getattr(args, "source", None)

    if self_test and not source:
        vae_name = self_test if isinstance(self_test, str) else "z-imageclearvae"
        _run_self_test(vae_name)
        return

    if not source:
        print("ERROR: source URL required (or use --self-test <name> to check an installed VAE)",
              file=sys.stderr)
        sys.exit(1)

    token = (getattr(args, "civitai_token", None)
             or os.environ.get("CIVITAI_TOKEN")
             or os.environ.get("CIVITAI_API_TOKEN"))
    if token:
        _civitai_token_cache["token"] = token
        os.environ["CIVITAI_TOKEN"] = token

    _run_url_import(source, args)

    if self_test:
        vae_name = args.name or "z-imageclearvae"
        _run_self_test(vae_name)


# ---------------------------------------------------------------------------
# Self-test: post-import structural + functional check
# ---------------------------------------------------------------------------

def _run_self_test(vae_name: str) -> None:
    """Verify a just-imported (or existing) VAE passes all invariants.

    Checks:
    1. model.safetensors exists and is a symlink
    2. Symlink target is inside video_generation__models/
    3. manifest.json has type=vae and correct format
    4. (GPU) encode/decode shapes are correct for ZImage 16-ch VAE
    """
    vae_dir = os.path.join(cfg.MODELS_DIR, "vae", vae_name)
    print(f"\n[self-test] Checking {vae_name}...")
    passed = 0
    failed = 0

    def ok(msg):
        nonlocal passed
        print(f"  PASS  {msg}")
        passed += 1

    def fail(msg):
        nonlocal failed
        print(f"  FAIL  {msg}", file=sys.stderr)
        failed += 1

    # 1. Directory exists
    if not os.path.isdir(vae_dir):
        fail(f"models/vae/{vae_name}/ not found")
        sys.exit(1)
    ok(f"models/vae/{vae_name}/ exists")

    # 2. model.safetensors is a symlink
    sf = os.path.join(vae_dir, "model.safetensors")
    if not os.path.exists(sf):
        fail("model.safetensors not found")
    elif not os.path.islink(sf):
        size = os.path.getsize(sf)
        fail(f"model.safetensors is a regular file ({size // 1_048_576} MB) — not a symlink")
    else:
        ok("model.safetensors is a symlink")
        real = os.path.realpath(sf)
        if "video_generation__models" in real:
            ok(f"symlink target is in external store: {os.path.basename(real)}")
        else:
            fail(f"symlink target not in video_generation__models/: {real}")

    # 3. manifest.json
    mf = os.path.join(vae_dir, "manifest.json")
    if not os.path.exists(mf):
        fail("manifest.json missing")
    else:
        with open(mf) as f:
            doc = json.load(f)
        if doc.get("type") == "vae":
            ok("manifest.json: type=vae")
        else:
            fail(f"manifest.json: type={doc.get('type')!r}, expected 'vae'")
        if doc.get("format") in ("mlx-bf16", "mlx-fp16", "mlx-fp32"):
            ok(f"manifest.json: format={doc['format']}")
        else:
            fail(f"manifest.json: format={doc.get('format')!r} is not an MLX format")

    # 4. GPU encode/decode test
    try:
        import mlx.core as mx
        _mflux_src = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)))), "vendor", "mflux", "src")
        if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
            sys.path.insert(0, _mflux_src)
        from mflux.models.z_image.model.z_image_vae.vae import VAE as ZImageVAE

        print("  INFO  Loading VAE weights for encode/decode test...")
        vae = ZImageVAE()
        vae.load_weights(sf)
        mx.eval(vae.parameters())

        img = mx.random.normal((1, 3, 128, 128)).astype(mx.bfloat16)
        enc = vae.encode(img)
        mx.eval(enc)
        dec = vae.decode(enc)
        mx.eval(dec)

        if enc.shape[1] == 16:
            ok(f"encode output: {list(enc.shape)} (16 latent channels)")
        else:
            fail(f"encode output has {enc.shape[1]} latent channels, expected 16")

        if dec.shape[1] == 3:
            ok(f"decode output: {list(dec.shape)} (3 RGB channels)")
        else:
            fail(f"decode output has {dec.shape[1]} channels, expected 3")

        import numpy as np
        arr = np.array(dec.astype(mx.float32))
        if not (np.any(np.isnan(arr)) or np.any(np.isinf(arr))):
            ok("no NaN/Inf in decoded output")
        else:
            fail("decoded output contains NaN or Inf")

    except ImportError as e:
        print(f"  SKIP  GPU test skipped ({e})")

    print(f"\n[self-test] {passed} passed, {failed} failed")
    if failed:
        sys.exit(1)


# ---------------------------------------------------------------------------
# URL import flow
# ---------------------------------------------------------------------------

def _run_url_import(url: str, args) -> None:
    print(f"[import-vae] URL: {url}")

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
    model_type = version_data.get("model", {}).get("type", "")
    if model_type != "VAE":
        print(f"WARNING: model type is '{model_type}', expected VAE.", file=sys.stderr)

    model_info = version_data.get("model", {})
    model_name = model_info.get("name", f"civitai-{version_id}")
    version_name = version_data.get("name", "")
    name = args.name or _sanitize_name(model_name)

    target_dir = os.path.join(cfg.MODELS_DIR, "vae", name)
    if os.path.exists(target_dir):
        print(f"ERROR: target already exists: {target_dir}", file=sys.stderr)
        print("  Use --name to choose a different name.", file=sys.stderr)
        sys.exit(1)

    # Pick download file
    primary_url, primary_name = _pick_primary_file(version_data)
    if not primary_url:
        print("ERROR: no downloadable file found.", file=sys.stderr)
        sys.exit(1)

    print(f"  Model:    {model_name} — {version_name}")
    print(f"  Name:     {name}")
    print(f"  File:     {primary_name}")
    print(f"  Base:     {base_model}")

    description = args.description
    if not description:
        description = f"{model_name} {version_name} ZImage-Turbo VAE, converted to MLX BF16"
        if not args.no_ai:
            ai_desc = _try_ai_description(version_data, model_name, args)
            if ai_desc:
                description = ai_desc

    tmp_dir = tempfile.mkdtemp(prefix="import_vae_")
    tmp_file = os.path.join(tmp_dir, primary_name or f"{name}.safetensors")
    try:
        size_gb = _estimate_gb(version_data, primary_url)
        print(f"\n  Downloading safetensors (~{size_gb:.0f} GB)...")
        _download_file(primary_url, tmp_file)

        os.makedirs(target_dir, exist_ok=True)
        _convert_vae(tmp_file, target_dir)

        # Externalize
        weights_path = os.path.join(target_dir, "model.safetensors")
        if os.path.isfile(weights_path) and not os.path.islink(weights_path):
            print("\n  Externalizing weights to model store...")
            _externalize_weights(weights_path)

        source_url = f"https://civitai.com/models/{version_data.get('modelId', model_id)}"
        size_bytes = _dir_size(target_dir)
        _write_manifest(
            target_dir=target_dir,
            name=name,
            description=description,
            source_url=source_url,
            size_bytes=size_bytes,
        )
        _write_readme(target_dir=target_dir, name=name, description=description, source_url=source_url)
        _print_summary(name, target_dir, description, source_url)

    except Exception:
        if os.path.exists(target_dir) and not os.listdir(target_dir):
            shutil.rmtree(target_dir, ignore_errors=True)
        raise
    finally:
        if not args.keep_source:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            print(f"  Source kept at: {tmp_file}")


# ---------------------------------------------------------------------------
# VAE conversion (PyTorch safetensors → MLX BF16)
# ---------------------------------------------------------------------------

def _convert_vae(src_file: str, dst_dir: str) -> None:
    """Convert a ZImage VAE safetensors (SD-native or diffusers format) to MLX BF16.

    For SD-native format (keys like decoder.mid.attn_1.k.*): uses diffusers'
    convert_ldm_vae_checkpoint to normalize to diffusers format, then applies
    mflux ZImageWeightMapping to produce MLX BF16 weights.

    For diffusers format (keys like decoder.mid_block.attentions.0.*): applies
    the mflux mapping directly.
    """
    import torch
    import mlx.core as mx
    from safetensors.torch import load_file as load_pt_file
    from tqdm import tqdm

    # Ensure mflux is importable
    _mflux_src = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    from mflux.models.z_image.weights.z_image_weight_mapping import ZImageWeightMapping
    from mlx.utils import tree_flatten

    mb = os.path.getsize(src_file) / 1_048_576
    print(f"\n[convert-vae] Loading {os.path.basename(src_file)} ({mb:.0f} MB)...")
    raw_weights = load_pt_file(src_file)

    # Detect format: SD-native vs diffusers
    sample_keys = list(raw_weights.keys())[:5]
    is_sd_native = any("decoder.mid.attn" in k or "decoder.up." in k or "encoder.down." in k
                        for k in sample_keys) or any(
                        "decoder.mid." in k for k in raw_weights.keys())

    if is_sd_native:
        print("[convert-vae] Detected SD-native format — converting to diffusers format...")
        _ZIMAGE_VAE_CONFIG = {
            "down_block_types": ["DownEncoderBlock2D"] * 4,
            "up_block_types": ["UpDecoderBlock2D"] * 4,
            "in_channels": 3,
            "out_channels": 3,
            "latent_channels": 16,
            "layers_per_block": 2,
            "block_out_channels": [128, 256, 512, 512],
            "norm_num_groups": 32,
            "mid_block_add_attention": True,
        }
        try:
            from diffusers.loaders.single_file_utils import convert_ldm_vae_checkpoint
            pt_weights = convert_ldm_vae_checkpoint(raw_weights, config=_ZIMAGE_VAE_CONFIG)
            print(f"[convert-vae] Remapped {len(raw_weights)} → {len(pt_weights)} keys")
        except Exception as e:
            print(f"[convert-vae] convert_ldm_vae_checkpoint failed ({e}), using direct mapping...")
            pt_weights = _sd_to_diffusers_vae(raw_weights)
    else:
        print("[convert-vae] Detected diffusers format — using directly")
        pt_weights = raw_weights

    del raw_weights
    gc.collect()

    # Build mflux key mapping (diffusers → MLX)
    mappings = ZImageWeightMapping.get_vae_mapping()

    def _expand_pattern(pattern, expansion_ranges):
        placeholders = re.findall(r'\{(\w+)\}', pattern)
        if not placeholders:
            return [pattern]
        results = [pattern]
        for ph in placeholders:
            new_results = []
            for r in results:
                for val in expansion_ranges.get(ph, [0]):
                    new_results.append(r.replace(f'{{{ph}}}', str(val)))
            results = new_results
        return results

    expansion_ranges = {'block': [0, 1, 2, 3], 'res': [0, 1], 'i': [0, 1]}
    decoder_expansion = dict(expansion_ranges, res=[0, 1, 2])

    key_map = {}
    for m in mappings:
        to_pat = m.to_pattern
        for from_pat in m.from_pattern:
            is_decoder_upblock = 'decoder.up_blocks.{block}' in from_pat
            exp = decoder_expansion if is_decoder_upblock else expansion_ranges
            from_keys = _expand_pattern(from_pat, exp)
            to_keys = _expand_pattern(to_pat, exp)
            for fk, tk in zip(from_keys, to_keys):
                key_map[fk] = (tk, m.transform)

    print("[convert-vae] Converting weights to MLX BF16...")
    mlx_weights = {}
    unmapped = []
    for k, v in tqdm(pt_weights.items()):
        if k in key_map:
            new_key, transform = key_map[k]
            val_np = v.detach().cpu().float().numpy() if isinstance(v, torch.Tensor) else v
            arr = mx.array(val_np).astype(mx.bfloat16)
            if transform is not None:
                arr = transform(arr)
            mlx_weights[new_key] = arr
        else:
            unmapped.append(k)

    del pt_weights
    gc.collect()

    if unmapped:
        print(f"[convert-vae] {len(unmapped)} unmapped keys (likely quant_conv etc.): {unmapped[:3]}")

    print("[convert-vae] Loading into ZImageVAE model...")
    vae_mlx = ZImageVAE()
    model_keys = set(dict(tree_flatten(vae_mlx.parameters())).keys())
    missing = model_keys - set(mlx_weights.keys())
    if missing:
        n = len(missing)
        print(f"[convert-vae] Warning: {n} missing keys: {sorted(missing)[:3]}")
        if n > 50:
            raise RuntimeError(
                f"Too many missing keys ({n}) — key mapping likely failed. "
                "Check that the source file is a ZImage-Turbo VAE."
            )

    vae_mlx.load_weights(list(mlx_weights.items()))
    del mlx_weights
    mx.eval(vae_mlx.parameters())

    out_path = os.path.join(dst_dir, "model.safetensors")
    print(f"[convert-vae] Saving to {out_path}...")
    vae_mlx.save_weights(out_path)

    size_mb = os.path.getsize(out_path) / 1_048_576
    print(f"[convert-vae] Done. {size_mb:.0f} MB")


def _sd_to_diffusers_vae(sd_weights: dict) -> dict:
    """Fallback: manually remap SD-native VAE keys to diffusers format."""
    UP_REVERSAL = {0: 3, 1: 2, 2: 1, 3: 0}
    result = {}
    for k, v in sd_weights.items():
        # Simple prefix substitutions
        if k.startswith("decoder.norm_out."):
            nk = "decoder.conv_norm_out." + k[len("decoder.norm_out."):]
        elif k.startswith("encoder.norm_out."):
            nk = "encoder.conv_norm_out." + k[len("encoder.norm_out."):]
        # Mid block resnets
        elif k.startswith("decoder.mid.block_1."):
            nk = "decoder.mid_block.resnets.0." + k[len("decoder.mid.block_1."):]
        elif k.startswith("decoder.mid.block_2."):
            nk = "decoder.mid_block.resnets.1." + k[len("decoder.mid.block_2."):]
        elif k.startswith("encoder.mid.block_1."):
            nk = "encoder.mid_block.resnets.0." + k[len("encoder.mid.block_1."):]
        elif k.startswith("encoder.mid.block_2."):
            nk = "encoder.mid_block.resnets.1." + k[len("encoder.mid.block_2."):]
        # Mid block attention
        elif k.startswith("decoder.mid.attn_1."):
            s = k[len("decoder.mid.attn_1."):]
            s = s.replace("k.bias", "to_k.bias").replace("k.weight", "to_k.weight")
            s = s.replace("q.bias", "to_q.bias").replace("q.weight", "to_q.weight")
            s = s.replace("v.bias", "to_v.bias").replace("v.weight", "to_v.weight")
            s = s.replace("proj_out.", "to_out.0.").replace("norm.", "group_norm.")
            nk = "decoder.mid_block.attentions.0." + s
            # SD stores attention projections as 1x1 Conv [C,C,1,1]; squeeze to [C,C]
            if s.endswith(".weight") and hasattr(v, "shape") and len(v.shape) == 4:
                v = v.squeeze(-1).squeeze(-1)
        elif k.startswith("encoder.mid.attn_1."):
            s = k[len("encoder.mid.attn_1."):]
            s = s.replace("k.bias", "to_k.bias").replace("k.weight", "to_k.weight")
            s = s.replace("q.bias", "to_q.bias").replace("q.weight", "to_q.weight")
            s = s.replace("v.bias", "to_v.bias").replace("v.weight", "to_v.weight")
            s = s.replace("proj_out.", "to_out.0.").replace("norm.", "group_norm.")
            nk = "encoder.mid_block.attentions.0." + s
            if s.endswith(".weight") and hasattr(v, "shape") and len(v.shape) == 4:
                v = v.squeeze(-1).squeeze(-1)
        # Decoder up blocks (reversed)
        elif m := re.match(r'^decoder\.up\.(\d+)\.block\.(\d+)\.nin_shortcut\.(.+)$', k):
            i, r, rest = int(m.group(1)), int(m.group(2)), m.group(3)
            nk = f"decoder.up_blocks.{UP_REVERSAL[i]}.resnets.{r}.conv_shortcut.{rest}"
        elif m := re.match(r'^decoder\.up\.(\d+)\.block\.(\d+)\.(.+)$', k):
            i, r, rest = int(m.group(1)), int(m.group(2)), m.group(3)
            nk = f"decoder.up_blocks.{UP_REVERSAL[i]}.resnets.{r}.{rest}"
        elif m := re.match(r'^decoder\.up\.(\d+)\.upsample\.conv\.(.+)$', k):
            i, rest = int(m.group(1)), m.group(2)
            nk = f"decoder.up_blocks.{UP_REVERSAL[i]}.upsamplers.0.conv.{rest}"
        # Encoder down blocks
        elif m := re.match(r'^encoder\.down\.(\d+)\.block\.(\d+)\.nin_shortcut\.(.+)$', k):
            i, r, rest = int(m.group(1)), int(m.group(2)), m.group(3)
            nk = f"encoder.down_blocks.{i}.resnets.{r}.conv_shortcut.{rest}"
        elif m := re.match(r'^encoder\.down\.(\d+)\.block\.(\d+)\.(.+)$', k):
            i, r, rest = int(m.group(1)), int(m.group(2)), m.group(3)
            nk = f"encoder.down_blocks.{i}.resnets.{r}.{rest}"
        elif m := re.match(r'^encoder\.down\.(\d+)\.downsample\.conv\.(.+)$', k):
            i, rest = int(m.group(1)), m.group(2)
            nk = f"encoder.down_blocks.{i}.downsamplers.0.conv.{rest}"
        else:
            nk = k  # pass through (conv_in, conv_out, quant_conv, etc.)
        result[nk] = v
    return result


# ---------------------------------------------------------------------------
# External model store
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


def _externalize_weights(weights_path: str) -> None:
    store_dir = _external_store_dir()
    os.makedirs(store_dir, exist_ok=True)

    print("    Computing MD5...")
    md5 = _md5_file(weights_path)
    store_path = os.path.join(store_dir, f"{md5}.safetensors")
    file_size = os.path.getsize(weights_path)

    if os.path.exists(store_path):
        os.remove(weights_path)
    else:
        shutil.move(weights_path, store_path)
        if _md5_file(store_path) != md5:
            raise RuntimeError(f"MD5 mismatch after move: {store_path}")

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

    # *.safetensors is gitignored, so the symlink must be force-staged or the
    # commit ships a manifest with no weights (the 3d0c39b bug class).
    _git_add_force(weights_path)
    print(f"    Externalized → {os.path.basename(store_path)}")


def _git_add_force(path: str) -> None:
    """Force-stage *path* so a gitignored file still lands in the commit.

    Weight symlinks need this: ``*.safetensors`` is gitignored (safety net so
    the real blobs never commit), which also matches the symlink — a plain
    ``git add`` silently skips it and the commit ships a manifest with no
    weights, breaking every other worktree. Best-effort: warns on failure
    (e.g. not a git repo) rather than aborting the import. check-model's
    tracking invariant is the backstop that catches a missed stage regardless
    of how the symlink was created.
    """
    try:
        result = subprocess.run(
            ["git", "add", "-f", "--", path],
            capture_output=True, text=True, timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as e:
        print(f"    ⚠ could not run `git add -f` ({e}) — stage the symlink manually")
        return
    if result.returncode != 0:
        print(f"    ⚠ `git add -f` failed (rc={result.returncode}): "
              f"{result.stderr.strip() or 'unknown error'}")
        print("      stage the symlink manually or the commit will ship no weights")
    else:
        print("    Staged weight symlink (git add -f)")


# ---------------------------------------------------------------------------
# Manifest + README
# ---------------------------------------------------------------------------

_ZIMAGE_VAE_CONFIG_JSON = {
    "_class_name": "AutoencoderKL",
    "in_channels": 3,
    "out_channels": 3,
    "latent_channels": 16,
    "block_out_channels": [128, 256, 512, 512],
    "layers_per_block": 2,
    "norm_num_groups": 32,
    "scaling_factor": 0.3611,
    "shift_factor": 0.1159,
    "use_quant_conv": False,
    "use_post_quant_conv": False,
}


def _write_manifest(*, target_dir: str, name: str, description: str,
                    source_url: str | None, size_bytes: int) -> None:
    # Compute actual disk size through symlinks for accurate size_bytes
    actual_size = 0
    for dirpath, _, filenames in os.walk(target_dir):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            real = os.path.realpath(fp) if os.path.islink(fp) else fp
            try:
                actual_size += os.path.getsize(real)
            except OSError:
                pass
    manifest = {
        "_comment": "Private metadata for mlx-movie-director model registry. Validated by `run.py check-model`.",
        "name": name,
        "type": "vae",
        "arch": "flux-ae",
        "format": "mlx-bf16",
        "description": description,
        "source": source_url or "imported via import-vae",
        "compatible_with": ["transformer/zimage-moody-v126"],
        "pipeline": ["zimage-turbo"],
        "cli": {
            "action": "image t2i",
            "vae_path": name,
            "note": f"use --vae-path {name} to override the default VAE"
        },
        "size_bytes": actual_size or size_bytes,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if source_url:
        manifest["source_url"] = source_url
    out = os.path.join(target_dir, "manifest.json")
    with open(out, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Write config.json (required by check-model for vae category)
    config_out = os.path.join(target_dir, "config.json")
    if not os.path.exists(config_out):
        with open(config_out, "w") as f:
            json.dump(_ZIMAGE_VAE_CONFIG_JSON, f, indent=2)
            f.write("\n")


def _write_readme(*, target_dir: str, name: str, description: str,
                  source_url: str | None) -> None:
    lines = [
        f"# {name}",
        "",
        description,
        "",
        "## Details",
        "",
        "| Field | Value |",
        "|-------|-------|",
        f"| Type | VAE |",
        f"| Arch | flux-ae (ZImage AutoencoderKL, 16 latent channels) |",
        f"| Format | mlx-bf16 |",
        f"| Pipeline | zimage-turbo |",
    ]
    if source_url:
        lines += [f"| Source | [{source_url}]({source_url}) |"]
    lines += [
        "",
        "## Notes",
        "",
        "- Converted from CivitAI safetensors via `import-vae`",
        "- `model.safetensors` is a symlink to `../video_generation__models/<md5>.safetensors`",
        "- Compatible with ZImage-Turbo transformers (same 16-channel latent space)",
    ]
    out = os.path.join(target_dir, "README.md")
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Download + utilities
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


def _civitai_api_get(url: str) -> dict:
    token = (os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN")
             or _civitai_token_cache.get("token"))
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, timeout=30, headers=headers)
    resp.raise_for_status()
    return resp.json()


def _pick_primary_file(version_data: dict) -> tuple[str | None, str]:
    for f in version_data.get("files", []):
        if f.get("primary"):
            return f.get("downloadUrl"), f.get("name", "model.safetensors")
    files = version_data.get("files", [])
    if files:
        return files[0].get("downloadUrl"), files[0].get("name", "model.safetensors")
    return None, "model.safetensors"


def _estimate_gb(version_data: dict, target_url: str | None) -> float:
    for f in version_data.get("files", []):
        if f.get("downloadUrl") == target_url:
            return f.get("sizeKB", 0) / 1_048_576
    return 0.0


def _parse_civitai_model_id(url: str) -> str | None:
    m = _CIVITAI_URL_RE.search(url)
    return m.group(1) if m else None


def _parse_civitai_version_id(url: str) -> str | None:
    params = parse_qs(urlparse(url).query)
    vids = params.get("modelVersionId", [])
    return vids[0] if vids else None


def _try_ai_description(version_data: dict, model_name: str, args) -> str | None:
    if not _check_llm_available(args.api_url):
        return None
    model_desc = (version_data.get("description", "") or "")[:1000]
    version_name = version_data.get("name", "")
    prompt = (
        f"Generate a concise one-line description (under 120 characters) for a ZImage-Turbo VAE.\n"
        f"Model: {model_name} {version_name}\nDescription: {model_desc}\n"
        f"Respond with ONLY the one-line description."
    )
    try:
        return _call_llm(args.api_url, "default", prompt)
    except Exception:
        return None


def _call_llm(api_url: str, model: str, prompt: str) -> str | None:
    resp = requests.post(
        f"{api_url}/v1/chat/completions",
        json={"model": model, "messages": [{"role": "user", "content": prompt}],
              "max_tokens": 150, "temperature": 0.3},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def _check_llm_available(api_url: str, timeout: float = 3.0) -> bool:
    try:
        requests.get(f"{api_url}/v1/models", timeout=timeout)
        return True
    except Exception:
        return False


def _sanitize_name(raw: str) -> str:
    name = raw.lower().strip()
    name = re.sub(r"[^\w\s-]", "", name)
    name = re.sub(r"[\s_]+", "-", name)
    name = re.sub(r"-+", "-", name).strip("-")
    return name or "vae"


def _dir_size(path: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total


def _print_summary(name: str, target_dir: str, description: str, source_url: str | None) -> None:
    # Count symlink targets (external store) + regular files
    size_bytes = 0
    for dirpath, _, filenames in os.walk(target_dir):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            real = os.path.realpath(fp) if os.path.islink(fp) else fp
            if os.path.isfile(real):
                size_bytes += os.path.getsize(real)
    size_mb = size_bytes / 1_048_576
    print(f"\n[import-vae] Imported: {name}")
    print(f"  Directory:  {target_dir}")
    print(f"  Size:       {size_mb:.0f} MB (MLX BF16)")
    print(f"  Arch:       flux-ae (ZImage 16-ch)")
    print(f"  Format:     mlx-bf16")
    if source_url:
        print(f"  Source:     {source_url}")
    print()
    print(f"Validate: run.py check-model")
    print(f"Test:     run.py image t2i --pipeline zimage --transformer zimage-moody-v126 \\")
    print(f"            --vae {name} --prompt 'a test image'")
