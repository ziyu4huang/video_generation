"""check-manifests — validate all model manifests under models/."""

import argparse
import json
import os
import sys
from collections.abc import Iterator
from datetime import datetime
from typing import Any

from app import config as cfg

PARSER_META = {
    "help": "Validate model manifests under models/",
    "description": (
        "Two JSON files per model instance:\n"
        "  manifest.json  — Private metadata (ours). Tracks identity, source, format,\n"
        "                    size, compatibility. Always safe to edit. Created by\n"
        "                    convert.py or manually. Has _comment field.\n"
        "  config.json    — Model architecture config. Two possible origins:\n"
        "                    • Downloaded from HuggingFace: has _class_name,\n"
        "                      _diffusers_version, architectures, model_type,\n"
        "                      transformers_version. DO NOT EDIT these.\n"
        "                    • Created by us (convert.py): has _comment field marking\n"
        "                      it as ours. Safe to edit.\n"
        "                    Check for _comment to distinguish origin.\n"
        "\n"
        "Validates models/<category>/<instance>/manifest.json:\n"
        "  • Required fields present and correct type\n"
        "  • 'name' matches directory name\n"
        "  • 'type' matches parent category directory\n"
        "  • 'created_at' is valid ISO-8601\n"
        "  • 'format' is a known weight format\n"
        "  • 'size_bytes' is positive and within sanity bounds\n"
        "  • 'size_bytes' matches actual file size (for weight files)\n"
        "  • 'compatible_with' references resolve to existing manifests\n"
        "  • No self-reference in 'compatible_with'\n"
        "  • No duplicate 'name' across manifests\n"
        "  • manifest.json, README.md, and at least one weight file exist\n"
        "  • config.json schema validated per category (required + any_of fields)\n"
        "  • Orphan instance dirs (no manifest.json) are reported\n"
        "  • tmp/ folders reported as cleanup candidates\n"
        "  • MLX conversion candidates: models still in PyTorch/safetensors format\n"
        "    with estimated size savings if converted to MLX quantized format\n"
        "\n"
        "Flag files (touch to create, rm to remove):\n"
        "  .downloading  — download in progress; missing weight files become ℹ️ Notice\n"
        "                  (not ❌ Error). Set by the download workflow before calling\n"
        "                  ltx_downloader.py; removed automatically on completion.\n"
        "                  If left behind after a crash, remove manually:\n"
        "                    rm models/<category>/<instance>/.downloading\n"
        "  .disabled     — model intentionally excluded; missing weight files become\n"
        "                  ℹ️ Notice. Set manually by the user to suppress errors for\n"
        "                  optional components (e.g. audio) that are not needed.\n"
        "                  Create:  touch models/<category>/<instance>/.disabled\n"
        "                  Remove:  rm    models/<category>/<instance>/.disabled\n"
        "\n"
        "Instance directory layout:\n"
        "  manifest.json   — required; private metadata (see REQUIRED_FIELDS)\n"
        "  README.md       — required; human-readable description\n"
        "  config.json     — required for transformer/text_encoder/vae; optional\n"
        "                    for lora/tokenizer/audio. May be HF-downloaded or ours.\n"
        "  *.safetensors   — at least one required (unless .downloading or .disabled)\n"
        "                    default: model.safetensors; override with manifest weight_file\n"
        "  .downloading    — flag: download in progress (transient; auto-removed)\n"
        "  .disabled       — flag: model disabled (persistent; set/removed manually)\n"
    ),
}

# ── Unified manifest schema ──────────────────────────────────────────
REQUIRED_FIELDS = {
    "name":           str,
    "type":           str,
    "arch":           str,
    "format":         str,
    "description":    str,
    "source":         str,
    "compatible_with": list,
    "size_bytes":     int,
    "created_at":     str,
}

# Optional fields (validated for type if present, not required)
OPTIONAL_FIELDS = {
    "pipeline":      list,  # Pipeline names this model belongs to (e.g. ["zimage-turbo"])
    "source_url":    str,   # Civitai, HuggingFace, or other source page
    "hf_repo":       str,   # HuggingFace repo ID (e.g. "black-forest-labs/FLUX.2-klein-9B")
    "hf_filename":   str,   # Specific filename in HF repo
    "convert_flag":  str,   # convert.py flag to re-create (e.g. "--transformer")
    "weight_file":   str,   # Override weight filename (e.g. "transformer-dev.safetensors")
    "trigger_words": list,  # LoRA trigger words (e.g. ["style1", "style2"])
    "test_prompt":   str,   # LoRA reference test prompt
    "recommended_scale": float,  # Recommended LoRA weight (0.0-2.0)
}

# Known pipeline names (warn on unknown)
KNOWN_PIPELINES = {
    "zimage-turbo",
    "flux2-klein",
    "flux2-klein-edit",
    "ltx-2.3",
    "seedvr2-upscale",
}

# Known weight formats (warn on unknown)
KNOWN_FORMATS = {
    "mlx-4bit-gs32",
    "mlx-4bit-gs64",
    "mlx-8bit",
    "mlx-int8",
    "mlx-bf16",
    "mlx-fp16",
    "mlx-fp32",
    "pytorch-fp32",
    "pytorch-fp16",
    "safetensors-fp32",
    "safetensors-fp16",
    "safetensors-bf16",
    "hf-tokenizer",
}

# Minimum size_bytes per category (sanity check)
MIN_SIZE_BYTES = {
    "transformer":    1_000_000,     # 1 MB
    "text_encoder":   1_000_000,     # 1 MB
    "vae":            100_000,       # 100 KB
    "lora":           10_000,        # 10 KB
    "tokenizer":      1_000,         # 1 KB
    "audio":          10_000,        # 10 KB
    "controlnet":     100_000,       # 100 KB
}

# Weight file names that count as "present" (per category flexibility)
WEIGHT_FILENAMES = [
    "model.safetensors",
    "diffusion_pytorch_model.safetensors",
    "tokenizer.json",          # tokenizer category
    "tokenizer_config.json",   # tokenizer category
]

# Categories where config.json is NOT strictly required
CONFIG_OPTIONAL = {"lora", "tokenizer", "audio", "controlnet"}

# ── MLX conversion candidate detection ───────────────────────────────
# Formats still in PyTorch/safetensors — candidates for MLX conversion
NON_MLX_FORMATS = {
    "safetensors-bf16", "safetensors-fp16", "safetensors-fp32",
    "pytorch-fp32", "pytorch-fp16",
}

# Suggested MLX target format per category (for conversion candidates)
_MLX_TARGET_FORMAT = {
    "transformer":    ("mlx-4bit-gs32", 0.25),   # ~4x smaller
    "text_encoder":   ("mlx-4bit-gs32", 0.25),   # ~4x smaller
    "vae":            ("mlx-bf16",      1.00),   # VAEs need full precision
    "lora":           ("mlx-8bit",      0.50),   # LoRA precision-sensitive
    "audio":          ("mlx-4bit-gs32", 0.25),   # ~4x smaller
    "controlnet":     ("mlx-4bit-gs32", 0.25),   # ~4x smaller
}


def _fmt_bytes(n: int) -> str:
    """Human-readable byte count."""
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.1f} GB"
    elif n >= 1_000_000:
        return f"{n / 1_000_000:.0f} MB"
    elif n >= 1_000:
        return f"{n / 1_000:.0f} KB"
    return f"{n} bytes"

# ── Per-category config.json schema ─────────────────────────────────
# "required": field_name -> expected_type  (all must be present)
# "any_of": list of (field_names, expected_type, human_label)
#           at least one field in each group must be present
CONFIG_SCHEMAS = {
    "transformer": {
        "required": {},
        "any_of": [
            (["n_layers", "num_layers", "num_hidden_layers"], int, "layer count"),
            (["dim", "hidden_size", "vid_dim", "video_dim", "emb_dim", "joint_attention_dim"], int, "model dimension"),
        ],
    },
    "text_encoder": {
        # Standard encoders (Gemma, T5) use hidden_size / num_hidden_layers.
        # LTX connectors use cross_attention_dim / num_layers / num_attention_heads.
        # Accept any combination via any_of so both pass without error.
        "required": {},
        "any_of": [
            (["hidden_size", "cross_attention_dim"], int, "model dimension"),
            (["num_hidden_layers", "num_layers", "num_attention_heads"], int, "layer/attention count"),
        ],
    },
    "vae": {
        "required": {
            "in_channels": int,
            "out_channels": int,
            "latent_channels": int,
        },
        "any_of": [],
    },
}


def add_args(parser: "argparse.ArgumentParser") -> None:
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show passing checks too")
    parser.add_argument("--json", action="store_true",
                        help="Output structured JSON to stdout and save to output/model-check.json")
    parser.add_argument("--html", action="store_true",
                        help="Generate interactive HTML report in output/")
    parser.add_argument("--open", action="store_true",
                        help="Auto-open HTML report in browser (implies --html)")


def _find_manifests(models_dir: str) -> Iterator[tuple[str, str, str]]:
    """Yield (category, instance, manifest_path) for every manifest.json."""
    for category in sorted(os.listdir(models_dir)):
        cat_dir = os.path.join(models_dir, category)
        if not os.path.isdir(cat_dir):
            continue
        for instance in sorted(os.listdir(cat_dir)):
            inst_dir = os.path.join(cat_dir, instance)
            mf = os.path.join(inst_dir, "manifest.json")
            if os.path.isdir(inst_dir) and os.path.exists(mf):
                yield category, instance, mf


# Directories to skip during orphan scanning (not model categories)
_SKIP_DIRS = {".cache", "__pycache__", ".git", "tmp"}


def _find_orphans(models_dir: str) -> Iterator[tuple[str, str]]:
    """Yield (category, instance) for dirs without manifest.json."""
    for category in sorted(os.listdir(models_dir)):
        cat_dir = os.path.join(models_dir, category)
        if not os.path.isdir(cat_dir) or category.startswith("."):
            continue
        if category in _SKIP_DIRS:
            continue
        for instance in sorted(os.listdir(cat_dir)):
            inst_dir = os.path.join(cat_dir, instance)
            mf = os.path.join(inst_dir, "manifest.json")
            if os.path.isdir(inst_dir) and not os.path.exists(mf):
                if instance in _SKIP_DIRS or instance.startswith("."):
                    continue
                yield category, instance


def _has_weight_file(inst_dir: str, declared: str | None = None) -> str | None:
    """Return the name of a weight file if one exists, else None.

    If *declared* is given (from manifest ``weight_file`` field), check that
    filename first before falling back to the default list and glob.
    """
    if declared:
        if os.path.exists(os.path.join(inst_dir, declared)):
            return declared
    for name in WEIGHT_FILENAMES:
        if os.path.exists(os.path.join(inst_dir, name)):
            return name
    # Also check for any .safetensors file (e.g. lora with custom name, sharded 0.safetensors)
    for f in sorted(os.listdir(inst_dir)):
        if f.endswith(".safetensors"):
            return f
    return None


def _dir_size(path: str) -> int:
    """Total bytes of all files under a directory (recursive).

    Skips broken symlinks (os.path.getsize raises FileNotFoundError).
    """
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass  # broken symlink — skip
    return total


def _total_safetensors_size(inst_dir: str) -> int:
    """Sum bytes of all *.safetensors files in the instance directory (non-recursive).

    Skips broken symlinks (os.path.getsize raises FileNotFoundError).
    """
    total = 0
    for f in os.listdir(inst_dir):
        if f.endswith(".safetensors"):
            try:
                total += os.path.getsize(os.path.join(inst_dir, f))
            except OSError:
                pass  # broken symlink — skip
    return total


def _validate_config(label: str, config_path: str, category: str,
                    errors: list[str], warnings: list[str]) -> None:
    """Validate config.json against the per-category schema."""
    try:
        with open(config_path) as f:
            cfg_data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        errors.append(f"{label}: config.json parse error: {e}")
        return

    if not isinstance(cfg_data, dict):
        errors.append(f"{label}: config.json must be a JSON object, got {type(cfg_data).__name__}")
        return

    schema = CONFIG_SCHEMAS.get(category)
    if not schema:
        return  # no schema defined for this category — skip

    # Required fields: must all exist with correct type
    for field, expected_type in schema.get("required", {}).items():
        if field not in cfg_data:
            errors.append(
                f"{label}: config.json missing required field '{field}'"
            )
        elif not isinstance(cfg_data[field], expected_type):
            warnings.append(
                f"{label}: config.json field '{field}' expected "
                f"{expected_type.__name__}, got {type(cfg_data[field]).__name__}"
            )

    # any_of groups: at least one field must exist with correct type
    for field_names, expected_type, human_label in schema.get("any_of", []):
        found = False
        for fn in field_names:
            if fn in cfg_data:
                if not isinstance(cfg_data[fn], expected_type):
                    warnings.append(
                        f"{label}: config.json field '{fn}' expected "
                        f"{expected_type.__name__}, got {type(cfg_data[fn]).__name__}"
                    )
                else:
                    found = True
                break
        if not found:
            errors.append(
                f"{label}: config.json must have at least one {human_label} "
                f"field ({'/'.join(field_names)})"
            )


# ---------------------------------------------------------------------------
# Data collection (shared by JSON and console/HTML paths)
# ---------------------------------------------------------------------------

def _collect_models_data(models_dir: str) -> dict:
    """Scan models directory and return all validation data.

    Returns dict with keys: errors, warnings, notices, passed,
    models_data, total_disk_bytes, category_disk_bytes, model_disk_sizes,
    conversion_candidates, orphan_dirs, manifests.
    """
    errors: list[str] = []
    warnings: list[str] = []
    notices: list[str] = []
    passed: list[str] = []

    all_instances: set[tuple[str, str]] = set()
    all_instance_ids: set[str] = set()
    manifests: list[tuple[str, str, str]] = []

    for category, instance, mf_path in _find_manifests(models_dir):
        all_instances.add((category, instance))
        all_instance_ids.add(f"{category}/{instance}")
        manifests.append((category, instance, mf_path))

    # Orphan detection
    orphan_dirs: list[tuple[str, str]] = []
    for category, instance in _find_orphans(models_dir):
        warnings.append(
            f"{category}/{instance}: directory exists but has no manifest.json"
        )
        orphan_dirs.append((category, instance))

    seen_names: dict[str, tuple[str, str]] = {}
    conversion_candidates: list[tuple[str, str, int, str, int, str]] = []
    total_disk_bytes = 0
    category_disk_bytes: dict[str, list[int]] = {}
    model_disk_sizes: list[tuple[str, int]] = []
    models_data: list[dict] = []

    # Progress: announce scan start
    print(f"📂 Scanning {len(manifests)} manifests in {models_dir}...", file=sys.stderr)

    for category, instance, mf_path in manifests:
        inst_dir = os.path.dirname(mf_path)
        label = f"{category}/{instance}"

        # Load JSON
        try:
            with open(mf_path) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            errors.append(f"{label}: manifest.json parse error: {e}")
            continue

        # 1. Required fields — presence and type
        for field, expected_type in REQUIRED_FIELDS.items():
            if field not in data:
                errors.append(f"{label}: missing required field '{field}'")
            elif not isinstance(data[field], expected_type):
                errors.append(
                    f"{label}: field '{field}' expected {expected_type.__name__}, "
                    f"got {type(data[field]).__name__}"
                )

        # 1b. Optional fields — type check if present
        for field, expected_type in OPTIONAL_FIELDS.items():
            if field in data and not isinstance(data[field], expected_type):
                warnings.append(
                    f"{label}: optional field '{field}' expected "
                    f"{expected_type.__name__}, got {type(data[field]).__name__}"
                )

        # 2. name == directory name
        if "name" in data and data["name"] != instance:
            errors.append(
                f"{label}: 'name' is '{data['name']}' but directory is '{instance}'"
            )

        # 3. type == parent category directory
        if "type" in data and data["type"] != category:
            errors.append(
                f"{label}: 'type' is '{data['type']}' but category directory is '{category}'"
            )

        # 4. Duplicate name across manifests
        if "name" in data:
            name = data["name"]
            if name in seen_names:
                prev = seen_names[name]
                errors.append(
                    f"{label}: duplicate 'name' \"{name}\" "
                    f"(already used by {prev[0]}/{prev[1]})"
                )
            else:
                seen_names[name] = (category, instance)

        # 5. created_at — ISO-8601 format
        if "created_at" in data and isinstance(data["created_at"], str):
            raw = data["created_at"]
            try:
                normalized = raw.rstrip("Z")
                datetime.fromisoformat(normalized)
            except (ValueError, TypeError):
                errors.append(
                    f"{label}: 'created_at' is not valid ISO-8601: \"{raw}\""
                )

        # 6. format — known enum
        if "format" in data and isinstance(data["format"], str):
            if data["format"] not in KNOWN_FORMATS:
                warnings.append(
                    f"{label}: 'format' \"{data['format']}\" not in known set "
                    f"({', '.join(sorted(KNOWN_FORMATS))})"
                )

        # 7. size_bytes — positive + sanity bounds
        if "size_bytes" in data and isinstance(data["size_bytes"], int):
            sb = data["size_bytes"]
            if sb <= 0:
                errors.append(f"{label}: 'size_bytes' must be positive, got {sb}")
            else:
                threshold = MIN_SIZE_BYTES.get(category, 0)
                if sb < threshold:
                    warnings.append(
                        f"{label}: 'size_bytes' ({sb}) is below minimum "
                        f"threshold for '{category}' ({threshold})"
                    )

        # 8. Self-reference in compatible_with
        if "compatible_with" in data and isinstance(data["compatible_with"], list):
            own_id = f"{category}/{instance}"
            for ref in data["compatible_with"]:
                if ref == own_id:
                    warnings.append(
                        f"{label}: 'compatible_with' contains self-reference "
                        f"\"{ref}\""
                    )

        # 9. compatible_with references must resolve
        if "compatible_with" in data and isinstance(data["compatible_with"], list):
            for ref in data["compatible_with"]:
                if ref not in all_instance_ids:
                    warnings.append(
                        f"{label}: 'compatible_with' reference '{ref}' "
                        f"not found (expected category/name format)"
                    )

        # 9b. pipeline — validate against known set
        if "pipeline" in data and isinstance(data["pipeline"], list):
            for p in data["pipeline"]:
                if p not in KNOWN_PIPELINES:
                    warnings.append(
                        f"{label}: 'pipeline' \"{p}\" not in known set "
                        f"({', '.join(sorted(KNOWN_PIPELINES))})"
                    )

        # 10. size_bytes vs actual weight file(s)
        declared_weight = data.get("weight_file")
        weight_file = _has_weight_file(inst_dir, declared=declared_weight)
        if "size_bytes" in data and weight_file:
            actual = _total_safetensors_size(inst_dir)
            if actual == 0:
                try:
                    actual = os.path.getsize(os.path.join(inst_dir, weight_file))
                except OSError:
                    actual = 0
            expected = data["size_bytes"]
            if actual != expected:
                warnings.append(
                    f"{label}: size_bytes={expected} but actual total is {actual} bytes"
                )

        # 11. README.md must exist
        if not os.path.exists(os.path.join(inst_dir, "README.md")):
            errors.append(f"{label}: missing README.md")

        # 12. At least one weight file must exist
        downloading_flag = os.path.exists(os.path.join(inst_dir, ".downloading"))
        disabled_flag = os.path.exists(os.path.join(inst_dir, ".disabled"))
        if not weight_file:
            if downloading_flag:
                notices.append(f"{label}: download in progress (.downloading) — weight files not yet available")
            elif disabled_flag:
                notices.append(f"{label}: model disabled (.disabled) — skipped")
            else:
                errors.append(f"{label}: no weight file found (expected one of {WEIGHT_FILENAMES} or *.safetensors)")

        # 13. config.json required + schema validation
        config_path = os.path.join(inst_dir, "config.json")
        if category not in CONFIG_OPTIONAL:
            if not os.path.exists(config_path):
                warnings.append(f"{label}: missing config.json (recommended for {category})")
            else:
                _validate_config(label, config_path, category, errors, warnings)

        # 14. tmp/ folder notice
        tmp_dir = os.path.join(inst_dir, "tmp")
        if os.path.isdir(tmp_dir):
            tmp_size = _dir_size(tmp_dir)
            tmp_files = os.listdir(tmp_dir)
            notices.append(
                f"{label}: tmp/ folder exists ({len(tmp_files)} files, "
                f"{tmp_size:,} bytes) — safe to delete to save space"
            )

        # 15. MLX conversion candidate detection
        fmt = data.get("format", "")
        if fmt in NON_MLX_FORMATS:
            target_info = _MLX_TARGET_FORMAT.get(category)
            if target_info:
                target_fmt, ratio = target_info
                size_bytes_val = data.get("size_bytes", 0)
                est_size = int(size_bytes_val * ratio) if size_bytes_val else 0
                convert_flag = data.get("convert_flag", "")
                conversion_candidates.append(
                    (label, fmt, size_bytes_val, target_fmt, est_size, convert_flag)
                )

        passed.append(label)

        # 16. Accumulate disk usage
        disk_bytes = 0
        if not downloading_flag and not disabled_flag:
            sz = _dir_size(inst_dir)
            disk_bytes = sz
            total_disk_bytes += sz
            cat_entry = category_disk_bytes.setdefault(category, [0, 0])
            cat_entry[0] += sz
            cat_entry[1] += 1
            model_disk_sizes.append((label, sz))

        # 17. Collect per-model data dict
        models_data.append({
            "label": label,
            "category": category,
            "manifest": dict(data),
            "disk_bytes": disk_bytes,
            "weight_file": weight_file,
            "has_readme": os.path.exists(os.path.join(inst_dir, "README.md")),
            "has_config": os.path.exists(os.path.join(inst_dir, "config.json")),
            "downloading": downloading_flag,
            "disabled": disabled_flag,
        })

        # Progress: per-model status
        fmt = data.get("format", "?")
        status_icon = "⏳" if downloading_flag else "🚫" if disabled_flag else "✓"
        print(f"  {status_icon} {label} — {_fmt_bytes(disk_bytes)} ({fmt})", file=sys.stderr)

    # Progress: scan summary
    print(f"📊 Done: {len(models_data)} models · {_fmt_bytes(total_disk_bytes)}", file=sys.stderr)

    return {
        "errors": errors,
        "warnings": warnings,
        "notices": notices,
        "passed": passed,
        "models_data": models_data,
        "total_disk_bytes": total_disk_bytes,
        "category_disk_bytes": category_disk_bytes,
        "model_disk_sizes": model_disk_sizes,
        "conversion_candidates": conversion_candidates,
        "orphan_dirs": orphan_dirs,
        "manifests": manifests,
    }


def _build_json_result(collected: dict, models_dir: str) -> dict:
    """Build the structured JSON result from collected data."""
    _enrich_with_validation(
        collected["models_data"],
        collected["errors"],
        collected["warnings"],
        collected["notices"],
    )

    # Disk usage by category (sorted by size descending)
    sorted_cats = sorted(
        collected["category_disk_bytes"].items(),
        key=lambda x: x[1][0],
        reverse=True,
    )
    disk_by_category = [
        {"category": c, "bytes": v[0], "count": v[1], "human": _fmt_bytes(v[0])}
        for c, v in sorted_cats
    ]

    # Top models by disk size
    sorted_models = sorted(collected["model_disk_sizes"], key=lambda x: x[1], reverse=True)
    top_models = [
        {"label": lbl, "bytes": sz, "human": _fmt_bytes(sz)}
        for lbl, sz in sorted_models[:10]
    ]

    # Conversion candidates with savings
    conv_candidates = []
    for label, fmt, size_bytes, target_fmt, est_size, convert_flag in collected["conversion_candidates"]:
        savings = size_bytes - est_size
        conv_candidates.append({
            "label": label,
            "format": fmt,
            "size_bytes": size_bytes,
            "size_human": _fmt_bytes(size_bytes),
            "target_format": target_fmt,
            "est_size": est_size,
            "est_size_human": _fmt_bytes(est_size),
            "savings_bytes": savings,
            "savings_human": _fmt_bytes(savings),
            "convert_flag": convert_flag,
        })

    # Orphans
    orphans = [
        {"category": cat, "instance": inst}
        for cat, inst in collected["orphan_dirs"]
    ]

    # Models with enriched validation
    models = []
    for m in collected["models_data"]:
        models.append({
            "label": m["label"],
            "category": m["category"],
            "manifest": m["manifest"],
            "disk_bytes": m["disk_bytes"],
            "disk_human": _fmt_bytes(m["disk_bytes"]) if m["disk_bytes"] else "",
            "weight_file": m["weight_file"],
            "has_readme": m["has_readme"],
            "has_config": m["has_config"],
            "downloading": m["downloading"],
            "disabled": m["disabled"],
            "validation": m.get("validation", {"errors": [], "warnings": [], "notices": []}),
            "status": m.get("status", "ok"),
        })

    return {
        "timestamp": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "models_dir": models_dir,
        "summary": {
            "total_models": len(collected["models_data"]),
            "total_disk_bytes": collected["total_disk_bytes"],
            "total_disk_human": _fmt_bytes(collected["total_disk_bytes"]),
            "error_count": len(collected["errors"]),
            "warning_count": len(collected["warnings"]),
            "notice_count": len(collected["notices"]),
            "conversion_candidate_count": len(collected["conversion_candidates"]),
            "orphan_count": len(collected["orphan_dirs"]),
        },
        "disk_usage": {
            "by_category": disk_by_category,
            "top_models": top_models,
        },
        "models": models,
        "conversion_candidates": conv_candidates,
        "orphans": orphans,
    }


# ---------------------------------------------------------------------------
# HTML report renderer
# ---------------------------------------------------------------------------

def _enrich_with_validation(models_data: list[dict], errors: list[str],
                            warnings: list[str], notices: list[str]) -> None:
    """Attach per-model validation status to models_data in-place."""
    known_labels = {m["label"] for m in models_data}
    err_map = _extract_per_model(errors, known_labels)
    warn_map = _extract_per_model(warnings, known_labels)
    note_map = _extract_per_model(notices, known_labels)
    for m in models_data:
        lbl = m["label"]
        m["validation"] = {
            "errors": err_map.get(lbl, []),
            "warnings": warn_map.get(lbl, []),
            "notices": note_map.get(lbl, []),
        }
        has_err = bool(m["validation"]["errors"])
        has_warn = bool(m["validation"]["warnings"])
        m["status"] = "error" if has_err else ("warning" if has_warn else "ok")


def _extract_per_model(messages: list[str], known_labels: set[str]) -> dict[str, list[str]]:
    """Group flat 'label: message' list into {label: [messages]} dict."""
    per_model: dict[str, list[str]] = {}
    for msg in messages:
        label = msg.split(":")[0]
        if label in known_labels:
            per_model.setdefault(label, []).append(msg[len(label) + 2:])
    return per_model


def _render_html_report(
    models_data: list[dict[str, Any]],
    total_disk_bytes: int,
    category_disk_bytes: dict[str, list[int]],
    conversion_candidates: list[tuple[str, str, int, str, int, str]],
    orphan_dirs: list[tuple[str, str]],
    errors: list[str],
    warnings: list[str],
    notices: list[str],
) -> str:
    """Generate a self-contained interactive HTML report."""
    from datetime import datetime

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    known_labels = {m["label"] for m in models_data}
    err_map = _extract_per_model(errors, known_labels)
    warn_map = _extract_per_model(warnings, known_labels)
    note_map = _extract_per_model(notices, known_labels)

    # Attach per-model validation status
    for m in models_data:
        lbl = m["label"]
        m["validation"] = {
            "errors": err_map.get(lbl, []),
            "warnings": warn_map.get(lbl, []),
            "notices": note_map.get(lbl, []),
        }
        has_err = bool(m["validation"]["errors"])
        has_warn = bool(m["validation"]["warnings"])
        m["status"] = "error" if has_err else ("warning" if has_warn else "ok")
        m["status_icon"] = "❌" if has_err else ("⚠️" if has_warn else "✅")

    # Build JSON payloads for JavaScript
    models_json = json.dumps(models_data, ensure_ascii=False, default=str)

    cat_items = sorted(category_disk_bytes.items(), key=lambda x: x[1][0], reverse=True)
    cat_json = json.dumps([
        {"category": c, "bytes": v[0], "count": v[1]}
        for c, v in cat_items
    ], ensure_ascii=False)

    conv_json = json.dumps([
        {"label": c[0], "format": c[1], "size_bytes": c[2],
         "target_format": c[3], "est_size": c[4], "convert_flag": c[5]}
        for c in conversion_candidates
    ], ensure_ascii=False)

    orphan_json = json.dumps(orphan_dirs, ensure_ascii=False)
    total_disk_str = _fmt_bytes(total_disk_bytes)
    n_models = len(models_data)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Model Inventory Report</title>
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{
  --bg:#0f0f0f;--bg2:#1a1a1a;--bg3:#242424;--bg4:#2e2e2e;
  --border:#333;--text:#e0e0e0;--muted:#888;
  --accent:#4a9eff;--gold:#f5c842;--green:#4caf50;--red:#f44336;--orange:#ff9800;
  --radius:6px;
}}
body{{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}}
a{{color:var(--accent);text-decoration:none}}
a:hover{{text-decoration:underline}}
header{{background:var(--bg2);border-bottom:1px solid var(--border);padding:16px 24px;position:sticky;top:0;z-index:100}}
header h1{{font-size:18px;font-weight:700;color:var(--accent);margin-bottom:2px}}
header .meta{{color:var(--muted);font-size:12px}}
.container{{max-width:1200px;margin:0 auto;padding:20px 24px}}

/* Search & filter bar */
.toolbar{{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px}}
.search-box{{flex:1;min-width:200px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;font-family:inherit}}
.search-box::placeholder{{color:#555}}
.search-box:focus{{outline:none;border-color:var(--accent)}}
select{{padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;font-family:inherit;cursor:pointer}}
select:focus{{outline:none;border-color:var(--accent)}}
.stat-chip{{padding:4px 10px;background:var(--bg3);border-radius:var(--radius);font-size:11px;color:var(--muted);white-space:nowrap}}
.stat-chip b{{color:var(--text)}}

/* Section */
.section{{margin-bottom:28px}}
.section-title{{font-size:15px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}}
.section-title .icon{{font-size:16px}}

/* Disk usage bars */
.disk-bars{{display:flex;flex-direction:column;gap:6px}}
.disk-row{{display:flex;align-items:center;gap:10px}}
.disk-label{{width:120px;text-align:right;font-size:12px;color:var(--muted);flex-shrink:0}}
.disk-bar-bg{{flex:1;height:22px;background:var(--bg3);border-radius:4px;overflow:hidden;position:relative}}
.disk-bar-fill{{height:100%;border-radius:4px;transition:width .3s;display:flex;align-items:center;padding-left:8px;font-size:11px;color:#fff;font-weight:500}}
.disk-size{{width:80px;font-size:12px;color:var(--text);flex-shrink:0}}
.disk-count{{width:80px;font-size:11px;color:var(--muted);flex-shrink:0}}

/* Model table */
.model-table{{width:100%;border-collapse:collapse}}
.model-table th{{text-align:left;padding:8px 10px;font-size:11px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}}
.model-table th:hover{{color:var(--text)}}
.model-table th .sort-arrow{{font-size:9px;margin-left:4px;opacity:.4}}
.model-table th.sorted .sort-arrow{{opacity:1;color:var(--accent)}}
.model-table td{{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}}
.model-table tr.model-row{{cursor:pointer;transition:background .1s}}
.model-table tr.model-row:hover{{background:var(--bg3)}}
.model-table tr.model-row.expanded{{background:var(--bg3)}}
.model-name{{font-weight:500;color:var(--text)}}
.model-name .cat-tag{{font-size:10px;color:var(--muted);margin-left:6px;font-weight:400}}
.model-format{{font-size:11px;color:var(--muted)}}
.model-size{{font-variant-numeric:tabular-nums;white-space:nowrap}}

/* Expandable detail row */
.detail-row{{display:none}}
.detail-row.open{{display:table-row}}
.detail-row td{{padding:0;border-bottom:1px solid var(--border)}}
.detail-content{{padding:12px 20px 16px;background:var(--bg2)}}
.detail-grid{{display:grid;grid-template-columns:140px 1fr 140px 1fr;gap:6px 16px;font-size:12px}}
.detail-grid .dk{{color:var(--muted);font-weight:500}}
.detail-grid .dv{{color:var(--text);word-break:break-all}}
.detail-validation{{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}}
.detail-validation h4{{font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}}
.val-item{{font-size:12px;padding:2px 0}}
.val-error{{color:var(--red)}}
.val-warning{{color:var(--orange)}}
.val-notice{{color:var(--muted)}}

/* Status badges */
.status{{display:inline-block;width:20px;text-align:center}}
.status-ok{{color:var(--green)}}
.status-warn{{color:var(--orange)}}
.status-error{{color:var(--red)}}

/* Conversion candidates */
.conv-list{{display:flex;flex-direction:column;gap:6px}}
.conv-item{{padding:8px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}}
.conv-label{{font-weight:500;color:var(--accent);min-width:200px}}
.conv-arrow{{color:var(--muted)}}
.conv-save{{color:var(--green);font-weight:500}}
.conv-flag{{font-size:10px;color:var(--muted);background:var(--bg3);padding:2px 6px;border-radius:3px}}

/* Orphan list */
.orphan-list{{display:flex;flex-direction:column;gap:4px}}
.orphan-item{{padding:6px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--orange)}}

/* Footer */
.footer{{text-align:center;padding:20px;color:#444;font-size:11px;border-top:1px solid var(--border);margin-top:30px}}

/* No-results message */
.no-results{{text-align:center;padding:30px;color:var(--muted);font-size:14px;display:none}}
</style>
</head>
<body>
<header>
  <h1>📋 Model Inventory Report</h1>
  <div class="meta">{total_disk_str} across {n_models} models &nbsp;·&nbsp; {now_str}</div>
</header>
<div class="container">

  <!-- Toolbar -->
  <div class="toolbar">
    <input class="search-box" id="search" type="text" placeholder="Search models by name, arch, format, source…">
    <select id="cat-filter">
      <option value="">All Categories</option>
    </select>
    <span class="stat-chip"><b id="visible-count">{n_models}</b> models</span>
    <span class="stat-chip">💾 <b>{total_disk_str}</b></span>
  </div>

  <!-- Disk Usage -->
  <div class="section" id="disk-section">
    <div class="section-title"><span class="icon">💾</span> Disk Usage by Category</div>
    <div class="disk-bars" id="disk-bars"></div>
  </div>

  <!-- Model Table -->
  <div class="section">
    <div class="section-title"><span class="icon">📦</span> Models</div>
    <table class="model-table">
      <thead>
        <tr>
          <th data-col="status" style="width:36px" onclick="sortBy('status')"><span class="sort-arrow">▲</span></th>
          <th data-col="label" onclick="sortBy('label')">Model<span class="sort-arrow">▲</span></th>
          <th data-col="format" onclick="sortBy('format')">Format<span class="sort-arrow">▲</span></th>
          <th data-col="size" onclick="sortBy('size')">Size<span class="sort-arrow">▲</span></th>
          <th data-col="category" onclick="sortBy('category')">Category<span class="sort-arrow">▲</span></th>
        </tr>
      </thead>
      <tbody id="model-tbody"></tbody>
    </table>
    <div class="no-results" id="no-results">No models match your search.</div>
  </div>

  <!-- MLX Conversion Candidates -->
  <div class="section" id="conv-section" style="display:none">
    <div class="section-title"><span class="icon">🔄</span> MLX Conversion Candidates</div>
    <div class="conv-list" id="conv-list"></div>
  </div>

  <!-- Orphan Directories -->
  <div class="section" id="orphan-section" style="display:none">
    <div class="section-title"><span class="icon">⚠️</span> Orphan Directories (no manifest.json)</div>
    <div class="orphan-list" id="orphan-list"></div>
  </div>

  <div class="footer">Generated by mlx-movie-director check-model — {now_str}</div>
</div>

<script>
// ── Data ──────────────────────────────────────────────────────────────
const MODELS = {models_json};
const CATEGORIES = {cat_json};
const CONVERSIONS = {conv_json};
const ORPHANS = {orphan_json};
const MAX_DISK = Math.max(...CATEGORIES.map(c => c.bytes), 1);

// ── State ─────────────────────────────────────────────────────────────
let sortCol = 'size';
let sortDir = -1;  // -1 = descending
let expandedLabel = null;

// ── Init ──────────────────────────────────────────────────────────────
function init() {{
  renderDiskBars();
  populateCategoryFilter();
  renderTable();
  renderConversions();
  renderOrphans();
  document.getElementById('search').addEventListener('input', renderTable);
  document.getElementById('cat-filter').addEventListener('change', renderTable);
}}

// ── Disk bars ─────────────────────────────────────────────────────────
function fmtBytes(n) {{
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}}

function renderDiskBars() {{
  const el = document.getElementById('disk-bars');
  el.innerHTML = CATEGORIES.map(c => {{
    const pct = Math.max((c.bytes / MAX_DISK) * 100, 1);
    const hue = 210 - (pct / 100) * 30;
    return `<div class="disk-row">
      <div class="disk-label">${{c.category}}</div>
      <div class="disk-bar-bg"><div class="disk-bar-fill" style="width:${{pct}}%;background:hsl(${{hue}},60%,50%)"></div></div>
      <div class="disk-size">${{fmtBytes(c.bytes)}}</div>
      <div class="disk-count">${{c.count}} ${{c.count === 1 ? 'model' : 'models'}}</div>
    </div>`;
  }}).join('');
}}

// ── Category filter ───────────────────────────────────────────────────
function populateCategoryFilter() {{
  const sel = document.getElementById('cat-filter');
  CATEGORIES.forEach(c => {{
    const opt = document.createElement('option');
    opt.value = c.category;
    opt.textContent = `${{c.category}} (${{c.count}})`;
    sel.appendChild(opt);
  }});
}}

// ── Filtering ─────────────────────────────────────────────────────────
function getFiltered() {{
  const q = document.getElementById('search').value.toLowerCase().trim();
  const cat = document.getElementById('cat-filter').value;
  return MODELS.filter(m => {{
    if (cat && m.category !== cat) return false;
    if (!q) return true;
    const m2 = m.manifest || {{}};
    const haystack = [
      m.label, m.category, m2.arch || '', m2.format || '',
      m2.source || '', m2.description || '', m2.name || '',
      ...(m2.compatible_with || []),
      ...(m2.pipeline || []),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }});
}}

// ── Sorting ───────────────────────────────────────────────────────────
function sortBy(col) {{
  if (sortCol === col) sortDir *= -1;
  else {{ sortCol = col; sortDir = -1; }}
  renderTable();
}}

function sortModels(models) {{
  return [...models].sort((a, b) => {{
    let va, vb;
    switch(sortCol) {{
      case 'status': va = a.status; vb = b.status; break;
      case 'label': va = a.label; vb = b.label; break;
      case 'format': va = (a.manifest||{{}}).format||''; vb = (b.manifest||{{}}).format||''; break;
      case 'size': va = a.disk_bytes; vb = b.disk_bytes; break;
      case 'category': va = a.category; vb = b.category; break;
      default: va = a.label; vb = b.label;
    }}
    if (typeof va === 'number') return (va - vb) * sortDir;
    return String(va).localeCompare(String(vb)) * sortDir;
  }});
}}

// ── Table rendering ──────────────────────────────────────────────────
function renderTable() {{
  const filtered = sortModels(getFiltered());
  const tbody = document.getElementById('model-tbody');
  document.getElementById('visible-count').textContent = filtered.length;
  document.getElementById('no-results').style.display = filtered.length ? 'none' : 'block';

  // Update sort indicators
  document.querySelectorAll('.model-table th').forEach(th => {{
    const col = th.dataset.col;
    th.classList.toggle('sorted', col === sortCol);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = col === sortCol ? (sortDir === 1 ? '▲' : '▼') : '▲';
  }});

  let html = '';
  filtered.forEach(m => {{
    const mf = m.manifest || {{}};
    const isExpanded = expandedLabel === m.label;
    const statusClass = m.status === 'error' ? 'status-error' : m.status === 'warning' ? 'status-warn' : 'status-ok';

    html += `<tr class="model-row ${{isExpanded ? 'expanded' : ''}}" data-label="${{escHtml(m.label)}}" onclick="toggleRow('${{escAttr(m.label)}}')">
      <td class="status ${{statusClass}}">${{m.status_icon}}</td>
      <td><span class="model-name">${{escHtml(m.label)}}</span></td>
      <td class="model-format">${{escHtml(mf.format || '-')}}</td>
      <td class="model-size">${{m.disk_bytes ? fmtBytes(m.disk_bytes) : '-'}}</td>
      <td>${{escHtml(m.category)}}</td>
    </tr>`;

    // Detail row
    html += `<tr class="detail-row ${{isExpanded ? 'open' : ''}}" data-detail="${{escHtml(m.label)}}">
      <td colspan="5"><div class="detail-content">`;

    // Manifest fields
    const fields = [
      ['Arch', mf.arch], ['Format', mf.format], ['Source', mf.source],
      ['Source URL', mf.source_url], ['HF Repo', mf.hf_repo],
      ['Description', mf.description], ['Size (declared)', mf.size_bytes ? fmtBytes(mf.size_bytes) : ''],
      ['Weight File', m.weight_file], ['Pipeline', (mf.pipeline||[]).join(', ')],
      ['Compatible With', (mf.compatible_with||[]).join(', ')],
      ['Trigger Words', (mf.trigger_words||[]).join(', ')],
      ['Convert Flag', mf.convert_flag], ['Created', mf.created_at],
      ['Files', [
        m.has_readme ? 'README.md' : null,
        m.has_config ? 'config.json' : null,
        m.weight_file,
        m.downloading ? '⏳ .downloading' : null,
        m.disabled ? '🚫 .disabled' : null,
      ].filter(Boolean).join(', ')],
    ];

    html += '<div class="detail-grid">';
    fields.forEach(([k, v]) => {{
      if (v) html += `<div class="dk">${{escHtml(k)}}</div><div class="dv">${{escHtml(String(v))}}</div>`;
    }});
    html += '</div>';

    // Validation messages
    const v = m.validation || {{}};
    const hasVal = v.errors.length || v.warnings.length || v.notices.length;
    if (hasVal) {{
      html += '<div class="detail-validation"><h4>Validation</h4>';
      (v.errors||[]).forEach(e => {{ html += `<div class="val-item val-error">❌ ${{escHtml(e)}}</div>`; }});
      (v.warnings||[]).forEach(w => {{ html += `<div class="val-item val-warning">⚠️ ${{escHtml(w)}}</div>`; }});
      (v.notices||[]).forEach(n => {{ html += `<div class="val-item val-notice">ℹ️ ${{escHtml(n)}}</div>`; }});
      html += '</div>';
    }}

    html += '</div></td></tr>';
  }});

  tbody.innerHTML = html;
}}

function toggleRow(label) {{
  expandedLabel = expandedLabel === label ? null : label;
  renderTable();
}}

// ── Conversion candidates ────────────────────────────────────────────
function renderConversions() {{
  if (!CONVERSIONS.length) return;
  document.getElementById('conv-section').style.display = '';
  const el = document.getElementById('conv-list');
  let totalSave = 0;
  el.innerHTML = CONVERSIONS.map(c => {{
    const save = c.size_bytes - c.est_size;
    totalSave += save;
    return `<div class="conv-item">
      <span class="conv-label">${{escHtml(c.label)}}</span>
      <span>${{fmtBytes(c.size_bytes)}} (${{c.format}})</span>
      <span class="conv-arrow">→</span>
      <span>~${{fmtBytes(c.est_size)}} ${{c.target_format}}</span>
      <span class="conv-save">(save ~${{fmtBytes(save)}})</span>
      ${{c.convert_flag ? `<span class="conv-flag">${{escHtml(c.convert_flag)}}</span>` : ''}}
    </div>`;
  }}).join('') + `<div class="conv-item" style="border-color:var(--green)">
    <span style="color:var(--green);font-weight:600">Total potential savings: ~${{fmtBytes(totalSave)}}</span>
  </div>`;
}}

// ── Orphan dirs ───────────────────────────────────────────────────────
function renderOrphans() {{
  if (!ORPHANS.length) return;
  document.getElementById('orphan-section').style.display = '';
  const el = document.getElementById('orphan-list');
  el.innerHTML = ORPHANS.map(([cat, inst]) =>
    `<div class="orphan-item">${{escHtml(cat)}}/${{escHtml(inst)}} — no manifest.json</div>`
  ).join('');
}}

// ── Utilities ─────────────────────────────────────────────────────────
function escHtml(s) {{
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}}
function escAttr(s) {{
  return s.replace(/'/g, "\\\\'").replace(/"/g, '&quot;');
}}

// ── Boot ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
</script>
</body>
</html>"""


def run(args: "argparse.Namespace") -> None:
    models_dir = cfg.MODELS_DIR
    collected = _collect_models_data(models_dir)

    errors = collected["errors"]
    warnings = collected["warnings"]
    notices = collected["notices"]
    passed = collected["passed"]
    models_html_data = collected["models_data"]
    total_disk_bytes = collected["total_disk_bytes"]
    category_disk_bytes = collected["category_disk_bytes"]
    model_disk_sizes = collected["model_disk_sizes"]
    conversion_candidates = collected["conversion_candidates"]
    orphan_dirs = collected["orphan_dirs"]
    manifests = collected["manifests"]

    # ── JSON output (short-circuit) ──────────────────────────────
    if getattr(args, 'json', False):
        result = _build_json_result(collected, models_dir)
        os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
        cache_path = os.path.join(cfg.OUTPUT_DIR, "model-check.json")
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, default=str, indent=2)
        print(json.dumps(result, ensure_ascii=False, default=str))
        sys.exit(1 if errors else 0)

    # ── Console report ────────────────────────────────────────────
    print(f"Models directory: {models_dir}")
    print(f"Manifests found:  {len(manifests)}")
    print()

    # ── Disk Usage Summary ────────────────────────────────────────
    if model_disk_sizes:
        counted = len(model_disk_sizes)
        print(f"💾 Disk Usage:")
        print(f"   Total: {_fmt_bytes(total_disk_bytes)} across {counted} models")
        print()

        # By category (sorted by size descending)
        sorted_cats = sorted(category_disk_bytes.items(), key=lambda x: x[1][0], reverse=True)
        print("   By Category:")
        for cat, (cat_bytes, cat_count) in sorted_cats:
            model_word = "model" if cat_count == 1 else "models"
            print(f"     {cat:<16s} {_fmt_bytes(cat_bytes):>10s}   ({cat_count} {model_word})")
        print()

        # Top 3 largest models
        sorted_models = sorted(model_disk_sizes, key=lambda x: x[1], reverse=True)
        top_n = min(3, len(sorted_models))
        print(f"   Top {top_n} Models:")
        for i, (lbl, sz) in enumerate(sorted_models[:top_n], 1):
            print(f"     {i}. {lbl:<42s} {_fmt_bytes(sz)}")
        print()

    if errors:
        print(f"❌ Errors ({len(errors)}):")
        for e in errors:
            print(f"   {e}")
        print()

    if warnings:
        print(f"⚠️  Warnings ({len(warnings)}):")
        for w in warnings:
            print(f"   {w}")
        print()

    if notices:
        print(f"ℹ️  Notices ({len(notices)}):")
        for n in notices:
            print(f"   {n}")
        print()

    if not errors and not warnings:
        print(f"✅ All {len(passed)} manifests valid — no errors or warnings.")
    elif not errors:
        print(f"✅ All {len(passed)} manifests passed (with {len(warnings)} warning(s)).")

    if args.verbose and passed:
        print(f"\nPassed: {', '.join(passed)}")

    # ── MLX Conversion Candidates ──────────────────────────────────
    if conversion_candidates:
        total_current = sum(c[2] for c in conversion_candidates)
        total_est = sum(c[4] for c in conversion_candidates)
        total_savings = total_current - total_est
        print()
        print(f"🔄 MLX Conversion Candidates ({len(conversion_candidates)}):")
        for label, fmt, size_bytes, target_fmt, est_size, convert_flag in conversion_candidates:
            savings = size_bytes - est_size
            line = (
                f"   {label}: {_fmt_bytes(size_bytes)} ({fmt})"
                f" → ~{_fmt_bytes(est_size)} {target_fmt}"
                f" (save ~{_fmt_bytes(savings)})"
            )
            if convert_flag:
                line += f"  [{convert_flag}]"
            print(line)
        print(f"   Total potential savings: ~{_fmt_bytes(total_savings)}")

    # ── HTML report ────────────────────────────────────────────────
    if getattr(args, 'html', False) or getattr(args, 'open', False):
        import subprocess

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
        output = os.path.join(cfg.OUTPUT_DIR, f"model-report-{ts}.html")
        html = _render_html_report(
            models_html_data, total_disk_bytes, category_disk_bytes,
            conversion_candidates, orphan_dirs,
            errors, warnings, notices,
        )
        with open(output, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"\n📄 HTML report: {output}")
        print(f"📄 Report: {output}", file=sys.stderr)
        if getattr(args, 'open', False):
            subprocess.Popen(["open", output])

    sys.exit(1 if errors else 0)
