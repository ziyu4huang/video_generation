"""import-lora-image — import a LoRA .safetensors file into the model registry.

Copies the LoRA file to models/lora/<name>/, generates manifest.json and README.md
following the project's model manifest schema. Validates architecture compatibility
and auto-detects companion link files for source attribution.

Examples:
  # Basic import (name derived from filename)
  run.py import-lora-image ~/Downloads/my-lora.safetensors --arch zimage-turbo

  # With trigger words and test prompt (recommended)
  run.py import-lora-image my-lora.safetensors --arch zimage-turbo \\
      --trigger-words "style1,style2" --test-prompt "a photo in STYLE style"

  # With explicit source info
  run.py import-lora-image my-lora.safetensors --arch flux2-klein-9b \\
      --source "civitai/user/model" --description "My custom LoRA"

  # Auto-detects companion .url/.webloc/.txt link files
  run.py import-lora-image ~/Downloads/my-lora.safetensors --arch zimage-turbo
"""

import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

from app import config as cfg

PARSER_META = {
    "help": "Import a LoRA .safetensors file into the model registry",
    "description": (
        "Import a LoRA adapter into models/lora/<name>/ with manifest.json and README.md.\n\n"
        "Auto-detects companion link files (.url, .webloc, .txt) next to the LoRA file\n"
        "and stores the URL as source_url in the manifest.\n\n"
        "Architectures are strictly separated — a LoRA trained for one arch will not\n"
        "work with another. Choose the correct --arch for your LoRA.\n\n"
        "Examples:\n"
        "  run.py import-lora-image my-lora.safetensors --arch zimage-turbo\n"
        "  run.py import-lora-image my-lora.safetensors --arch flux2-klein-9b \\\n"
        "      --trigger-words 'style1,style2' --test-prompt 'a photo in STYLE style'\n"
    ),
}

# ── Arch → metadata mapping ──────────────────────────────────────────
# Each arch maps to the pipeline and compatible_with values for manifest.json.
ARCH_METADATA = {
    "zimage-turbo": {
        "pipeline": ["zimage-turbo"],
        "compatible_with": ["transformer/zimage-moody-v126"],
    },
    "zimage-base": {
        "pipeline": ["zimage-turbo"],
        "compatible_with": [],
    },
    "flux2-klein-9b": {
        "pipeline": ["flux2-klein"],
        "compatible_with": ["transformer/klein-9b"],
    },
    "flux2-klein-4b": {
        "pipeline": ["flux2-klein"],
        "compatible_with": [],
    },
    "ltx-2.3": {
        "pipeline": ["ltx-2.3"],
        "compatible_with": ["transformer/ltx-2.3-dev-q8"],
    },
}

_MANIFEST_COMMENT = (
    "Private metadata for mlx-movie-director model registry. "
    "Created by convert.py or manually. Validated by `run.py check-manifests`. "
    "See docs/models.md for schema docs."
)


def add_args(parser):
    parser.add_argument("file", metavar="FILE",
                        help="Path to LoRA .safetensors file")
    parser.add_argument("--arch", required=True, choices=list(ARCH_METADATA.keys()),
                        help="Target architecture (required)")
    parser.add_argument("--name", type=str, default=None,
                        help="Instance name (default: derived from filename)")
    parser.add_argument("--source", type=str, default=None,
                        help="Source identifier, e.g. 'civitai/user/model'")
    parser.add_argument("--source-url", type=str, default=None,
                        help="Direct URL to LoRA source page")
    parser.add_argument("--link-file", type=str, default=None, metavar="PATH",
                        help="Path to companion link/URL file (.url, .webloc, .txt)")
    parser.add_argument("--format", type=str, default=None, metavar="FMT",
                        help="Weight format override (default: auto-detected from tensor dtype)")
    parser.add_argument("--description", type=str, default=None,
                        help="Human-readable description")
    parser.add_argument("--trigger-words", type=str, default=None,
                        help="Comma-separated trigger words (recommended)")
    parser.add_argument("--test-prompt", type=str, default=None,
                        help="Reference test prompt (recommended)")


def run(args):
    src_path = os.path.abspath(args.file)

    # ── 1. Validate input file ────────────────────────────────────
    if not os.path.exists(src_path):
        print(f"ERROR: file not found: {src_path}", file=sys.stderr)
        sys.exit(1)
    if not src_path.endswith(".safetensors"):
        print(f"WARNING: file does not have .safetensors extension: {src_path}",
              file=sys.stderr)

    # ── 2. Derive name ────────────────────────────────────────────
    name = _sanitize_name(args.name) if args.name else _derive_name(src_path)

    # ── 3. Check target directory ─────────────────────────────────
    target_dir = os.path.join(cfg.MODELS_DIR, "lora", name)
    if os.path.exists(target_dir):
        print(f"ERROR: target directory already exists: {target_dir}", file=sys.stderr)
        print(f"  Use --name to choose a different name, or remove the existing directory.",
              file=sys.stderr)
        sys.exit(1)

    # ── 4. Detect format ──────────────────────────────────────────
    fmt = args.format or _detect_format(src_path)

    # ── 5. Detect link URL ────────────────────────────────────────
    link_url = args.source_url
    detected_link = None
    if not link_url:
        if args.link_file:
            link_url = _read_link_file(args.link_file)
            detected_link = args.link_file
        else:
            link_url, detected_link = _auto_detect_link(src_path)
    if detected_link:
        print(f"  Link file:  {os.path.basename(detected_link)}")

    # ── 6. Copy file and create directory ─────────────────────────
    os.makedirs(target_dir, exist_ok=True)
    dest_file = os.path.join(target_dir, os.path.basename(src_path))
    shutil.copy2(src_path, dest_file)
    file_size = os.path.getsize(dest_file)
    filename = os.path.basename(dest_file)

    # ── 7. Parse optional fields ──────────────────────────────────
    trigger_words = None
    if args.trigger_words:
        trigger_words = [w.strip() for w in args.trigger_words.split(",") if w.strip()]

    source = args.source or "manual-import"
    description = args.description or f"LoRA adapter for {args.arch}"
    arch_meta = ARCH_METADATA[args.arch]

    # ── 8. Generate manifest.json ─────────────────────────────────
    manifest = {
        "_comment": _MANIFEST_COMMENT,
        "name": name,
        "type": "lora",
        "arch": args.arch,
        "format": fmt,
        "description": description,
        "source": source,
        "compatible_with": arch_meta["compatible_with"],
        "size_bytes": file_size,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    # Optional fields (omit if empty)
    if arch_meta["pipeline"]:
        manifest["pipeline"] = arch_meta["pipeline"]
    if link_url:
        manifest["source_url"] = link_url
    if trigger_words:
        manifest["trigger_words"] = trigger_words
    if args.test_prompt:
        manifest["test_prompt"] = args.test_prompt

    manifest_path = os.path.join(target_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # ── 9. Generate README.md ─────────────────────────────────────
    readme = _generate_readme(
        name=name, arch=args.arch, filename=filename, file_size=file_size,
        description=description, source=source, source_url=link_url,
        trigger_words=trigger_words, test_prompt=args.test_prompt,
    )
    readme_path = os.path.join(target_dir, "README.md")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(readme)

    # ── 10. Print summary ─────────────────────────────────────────
    size_mb = file_size / 1_048_576
    print(f"[import-lora-image] Imported: {name}")
    print(f"  Directory:  {target_dir}")
    print(f"  File:       {filename} ({size_mb:.1f} MB)")
    print(f"  Arch:       {args.arch}")
    print(f"  Format:     {fmt}")
    if trigger_words:
        print(f"  Triggers:   {', '.join(trigger_words)}")
    if link_url:
        print(f"  Source URL: {link_url}")
    print()
    print(f"Validate: run.py check-manifests")
    print(f"Test:     run.py generate --prompt '{args.test_prompt or 'test prompt'}' \\")
    print(f"            --lora-path {os.path.join(target_dir, filename)}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sanitize_name(raw: str) -> str:
    """Sanitize a user-provided name: lowercase, non-alphanumeric → hyphens."""
    name = raw.lower()
    name = re.sub(r"[^a-z0-9-]", "-", name)
    name = re.sub(r"-{2,}", "-", name)
    name = name.strip("-")
    if not name:
        print(f"ERROR: '--name {raw}' produces empty name after sanitization",
              file=sys.stderr)
        sys.exit(1)
    return name


def _derive_name(filepath: str) -> str:
    """Derive instance name from the safetensors filename."""
    basename = os.path.basename(filepath)
    # Strip extension(s): .safetensors, .fp16.safetensors, etc.
    name = re.sub(r"\.safetensors$", "", basename, flags=re.IGNORECASE)
    # Further strip common suffixes like .fp16, .bf16
    name = re.sub(r"\.(fp16|bf16|fp32)$", "", name, flags=re.IGNORECASE)
    return _sanitize_name(name)


def _detect_format(filepath: str) -> str:
    """Auto-detect weight format by inspecting tensor dtype in safetensors."""
    try:
        from safetensors import safe_open
        with safe_open(filepath, framework="pt") as f:
            for key in f.keys():
                tensor = f.get_tensor(key)
                dtype = str(tensor.dtype)
                if "bfloat16" in dtype:
                    return "safetensors-bf16"
                elif "float16" in dtype or "half" in dtype:
                    return "safetensors-fp16"
                elif "float32" in dtype or "float" in dtype:
                    return "safetensors-fp32"
                break  # only check first tensor
    except Exception as e:
        print(f"  WARNING: could not detect format: {e}", file=sys.stderr)
    return "safetensors-fp16"  # safe default


def _auto_detect_link(lora_path: str) -> tuple[str | None, str | None]:
    """Auto-detect companion link file next to the LoRA file.

    Checks for <basename>.url, <basename>.webloc, <basename>.txt in order.
    Returns (url, detected_file_path) or (None, None).
    """
    base, _ = os.path.splitext(lora_path)
    for ext in [".url", ".webloc", ".txt"]:
        companion = base + ext
        if os.path.exists(companion):
            url = _read_link_file(companion)
            if url:
                return url, companion
    return None, None


def _read_link_file(path: str) -> str | None:
    """Read a link/URL from a .url, .webloc, or plain text file."""
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read().strip()
    except (OSError, UnicodeDecodeError):
        return None

    if not content:
        return None

    # .url format: [InternetShortcut]\nURL=https://...
    url_match = re.search(r"^URL=(.+)$", content, re.MULTILINE)
    if url_match:
        return url_match.group(1).strip()

    # .webloc format: plist XML with <string>url</string>
    if "<dict>" in content:
        string_match = re.search(r"<string>(https?://[^<]+)</string>", content)
        if string_match:
            return string_match.group(1)

    # Plain text: first line matching a URL
    url_match = re.search(r"(https?://\S+)", content)
    if url_match:
        return url_match.group(1)

    return None


def _generate_readme(*, name, arch, filename, file_size, description,
                     source, source_url, trigger_words, test_prompt) -> str:
    """Generate README.md content for the imported LoRA."""
    size_mb = file_size / 1_048_576
    lines = [
        f"# {name} — LoRA Adapter ({arch})",
        "",
        f"{description}.",
    ]

    if source_url:
        lines.append("")
        lines.append(f"Source: [{source_url}]({source_url})")
    elif source and source != "manual-import":
        lines.append("")
        lines.append(f"Source: `{source}`")

    lines.extend([
        "",
        "## Files",
        "",
        f"| File | Size | Description |",
        f"|------|------|-------------|",
        f"| `{filename}` | ~{size_mb:.0f} MB | LoRA weights ({arch}) |",
    ])

    if trigger_words:
        lines.extend([
            "",
            "## Trigger Words",
            "",
            ", ".join(f"`{w}`" for w in trigger_words),
        ])

    lines.extend([
        "",
        "## Usage",
        "",
        "```bash",
        f"# Apply LoRA with default scale 1.0",
        f"./python/venv/bin/python python/mlx-movie-director/run.py \\",
        f"  --prompt 'your prompt here' \\",
        f"  --lora-path python/mlx-movie-director/models/lora/{name}/{filename}",
        "",
        f"# Adjust scale",
        f"./python/venv/bin/python python/mlx-movie-director/run.py \\",
        f"  --prompt 'your prompt here' \\",
        f"  --lora-path python/mlx-movie-director/models/lora/{name}/{filename} \\",
        f"  --lora-scale 0.8",
        "```",
    ])

    if test_prompt:
        lines.extend([
            "",
            "## Test Prompt",
            "",
            "```",
            test_prompt,
            "```",
        ])

    lines.append("")
    return "\n".join(lines)
