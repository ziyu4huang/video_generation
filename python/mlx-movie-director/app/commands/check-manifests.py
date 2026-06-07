"""check-manifests — validate all model manifests under models/."""

import json
import os
import sys
from datetime import datetime

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
}

# Weight file names that count as "present" (per category flexibility)
WEIGHT_FILENAMES = [
    "model.safetensors",
    "diffusion_pytorch_model.safetensors",
    "tokenizer.json",          # tokenizer category
    "tokenizer_config.json",   # tokenizer category
]

# Categories where config.json is NOT strictly required
CONFIG_OPTIONAL = {"lora", "tokenizer", "audio"}

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


def add_args(parser):
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show passing checks too")


def _find_manifests(models_dir: str):
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


def _find_orphans(models_dir: str):
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
    """Total bytes of all files under a directory (recursive)."""
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    return total


def _total_safetensors_size(inst_dir: str) -> int:
    """Sum bytes of all *.safetensors files in the instance directory (non-recursive)."""
    total = 0
    for f in os.listdir(inst_dir):
        if f.endswith(".safetensors"):
            total += os.path.getsize(os.path.join(inst_dir, f))
    return total


def _validate_config(label, config_path, category, errors, warnings):
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


def run(args):
    models_dir = cfg.MODELS_DIR
    errors = []
    warnings = []
    notices = []
    passed = []

    # Collect all known (category, instance) pairs for cross-ref validation
    all_instances = set()
    all_instance_ids = set()   # "category/name" strings for compatible_with validation
    manifests = []

    for category, instance, mf_path in _find_manifests(models_dir):
        all_instances.add((category, instance))
        all_instance_ids.add(f"{category}/{instance}")
        manifests.append((category, instance, mf_path))

    # ── Orphan detection ──────────────────────────────────────────
    for category, instance in _find_orphans(models_dir):
        warnings.append(
            f"{category}/{instance}: directory exists but has no manifest.json"
        )

    # ── Duplicate name tracking ───────────────────────────────────
    seen_names = {}  # name -> (category, instance)

    # ── MLX conversion candidates ──────────────────────────────────
    conversion_candidates = []  # (label, format, size_bytes, target_format, est_size, convert_flag)

    # ── Validate each manifest ────────────────────────────────────
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
                # Strip trailing 'Z' for fromisoformat compat (Python 3.11+)
                # but also handle it manually for older Pythons
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

        # 8. Self-reference in compatible_with (category/name format)
        if "compatible_with" in data and isinstance(data["compatible_with"], list):
            own_id = f"{category}/{instance}"
            for ref in data["compatible_with"]:
                if ref == own_id:
                    warnings.append(
                        f"{label}: 'compatible_with' contains self-reference "
                        f"\"{ref}\""
                    )

        # 9. compatible_with references must resolve to category/name of existing manifests
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
        # Sum all *.safetensors to handle multi-file models (vae, audio, sharded).
        # Fall back to the single detected weight file for non-safetensors formats
        # (e.g. tokenizer dirs where weight_file is tokenizer.json).
        declared_weight = data.get("weight_file")
        weight_file = _has_weight_file(inst_dir, declared=declared_weight)
        if "size_bytes" in data and weight_file:
            actual = _total_safetensors_size(inst_dir)
            if actual == 0:
                actual = os.path.getsize(os.path.join(inst_dir, weight_file))
            expected = data["size_bytes"]
            if actual != expected:
                warnings.append(
                    f"{label}: size_bytes={expected} but actual total is {actual} bytes"
                )

        # 11. README.md must exist
        if not os.path.exists(os.path.join(inst_dir, "README.md")):
            errors.append(f"{label}: missing README.md")

        # 12. At least one weight file must exist (skip if .downloading or .disabled flag present)
        downloading_flag = os.path.exists(os.path.join(inst_dir, ".downloading"))
        disabled_flag    = os.path.exists(os.path.join(inst_dir, ".disabled"))
        if not weight_file:
            if downloading_flag:
                notices.append(f"{label}: download in progress (.downloading) — weight files not yet available")
            elif disabled_flag:
                notices.append(f"{label}: model disabled (.disabled) — skipped")
            else:
                errors.append(f"{label}: no weight file found (expected one of {WEIGHT_FILENAMES} or *.safetensors)")

        # 13. config.json required (except for lora, tokenizer) + schema validation
        config_path = os.path.join(inst_dir, "config.json")
        if category not in CONFIG_OPTIONAL:
            if not os.path.exists(config_path):
                warnings.append(f"{label}: missing config.json (recommended for {category})")
            else:
                # Validate config.json schema
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
                size_bytes = data.get("size_bytes", 0)
                est_size = int(size_bytes * ratio) if size_bytes else 0
                convert_flag = data.get("convert_flag", "")
                conversion_candidates.append(
                    (label, fmt, size_bytes, target_fmt, est_size, convert_flag)
                )

        passed.append(label)

    # ── Report ────────────────────────────────────────────────────
    print(f"Models directory: {models_dir}")
    print(f"Manifests found:  {len(manifests)}")
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

    sys.exit(1 if errors else 0)
