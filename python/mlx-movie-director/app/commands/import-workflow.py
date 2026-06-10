"""import-workflow — download ComfyUI workflow JSON from CivitAI.

Accepts a CivitAI model URL (type=Workflows or any model with attached workflow
files), resolves the latest or specified version via the CivitAI REST API,
downloads .json workflow files to the local workflows directory, and optionally
parses them to display a parameter summary.

Also supports extracting workflow JSON embedded in PNG metadata (the
"workflow-in-a-PNG" trick used by ComfyUI).

Reuses CivitAI API helpers from import-lora-image.py.

Examples:
  # Download latest version of a workflow
  run.py import-workflow 'https://civitai.com/models/379786/outpainting-comfyui-workflow-or-expand-image'

  # Download specific version
  run.py import-workflow 'https://civitai.com/models/449322?modelVersionId=1234567'

  # Download + parse (show extracted params)
  run.py import-workflow 'https://civitai.com/models/379786/...' --parse

  # Dry run (show metadata, don't download)
  run.py import-workflow 'https://civitai.com/models/379786/...' --dry-run

  # Extract workflow from sample images (PNG metadata)
  run.py import-workflow 'https://civitai.com/models/379786/...' --extract-png

  # Custom output directory
  run.py import-workflow '...' --output-dir ./my-workflows/
"""

import importlib
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import requests

# Import shared config for default paths
from app import config as cfg

# Reuse CivitAI helpers from import-lora-image (filenames have hyphens, need importlib)
_lora_importer = importlib.import_module("app.commands.import-lora-image")

# Re-exported helpers
_civitai_api_get = _lora_importer._civitai_api_get
_parse_civitai_model_id = _lora_importer._parse_civitai_model_id
_parse_civitai_version_id = _lora_importer._parse_civitai_version_id
_download_file = _lora_importer._download_file

# CivitAI API endpoints (same as import-lora-image)
_CIVITAI_API_MODEL = _lora_importer._CIVITAI_API_MODEL
_CIVITAI_API_VERSION = _lora_importer._CIVITAI_API_VERSION

PARSER_META = {
    "help": "Download ComfyUI workflow JSON from CivitAI",
    "description": (
        "Download ComfyUI workflow JSON from a CivitAI model URL.\n\n"
        "Resolves the model/version via the CivitAI REST API, downloads .json\n"
        "workflow files, and optionally parses them to show key parameters.\n\n"
        "Use --parse to display a summary of extracted sampler/outpaint params.\n"
        "Use --extract-png to also extract workflow from sample image PNG metadata.\n\n"
        "Examples:\n"
        "  run.py import-workflow 'https://civitai.com/models/379786/...'\n"
        "  run.py import-workflow 'https://civitai.com/models/379786/...' --parse\n"
        "  run.py import-workflow 'https://civitai.com/models/379786/...' --dry-run\n"
        "  run.py import-workflow '...' --extract-png\n"
    ),
}


def add_args(parser):
    parser.add_argument(
        "url", type=str, metavar="URL",
        help="CivitAI model URL (e.g. https://civitai.com/models/379786/...)",
    )
    parser.add_argument(
        "--civitai-token", type=str, default=None,
        help="CivitAI API token for downloads (or set CIVITAI_TOKEN env var)",
    )
    parser.add_argument(
        "--output-dir", type=str, default=None,
        help="Output directory for downloaded workflows "
             "(default: comfyui_data/user/default/workflows/)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Show metadata without downloading files",
    )
    parser.add_argument(
        "--parse", action="store_true", default=False,
        help="Parse downloaded workflow and print parameter summary",
    )
    parser.add_argument(
        "--extract-png", action="store_true", default=False,
        help="Also extract workflow JSON from sample images (PNG metadata)",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(args):
    # Set CivitAI token from CLI arg or env var
    token = getattr(args, "civitai_token", None) or os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN")
    if token:
        os.environ["CIVITAI_TOKEN"] = token
        _lora_importer._civitai_token_cache["token"] = token

    url = args.url
    model_id = _parse_civitai_model_id(url)
    if not model_id:
        print(f"ERROR: Could not parse CivitAI model ID from URL: {url}", file=sys.stderr)
        print("  Expected format: https://civitai.com/models/<id>/...", file=sys.stderr)
        sys.exit(1)

    # Default output: repo_root/comfyui_data/user/default/workflows/
    # __file__ = .../python/mlx-movie-director/app/commands/import-workflow.py
    _this_dir = os.path.dirname(os.path.abspath(__file__))
    _repo_root = os.path.normpath(os.path.join(
        _this_dir, "..", "..", "..", ".."
    ))
    output_dir = args.output_dir or os.path.join(
        _repo_root, "comfyui_data", "user", "default", "workflows"
    )
    output_dir = os.path.abspath(output_dir)

    version_id = _parse_civitai_version_id(url)
    _run_import(model_id, version_id, output_dir, args)


# ---------------------------------------------------------------------------
# Import logic
# ---------------------------------------------------------------------------

def _run_import(model_id: str, version_id: str | None,
                output_dir: str, args) -> None:
    """Main import flow: resolve → download → optionally parse."""

    # Step 1: Resolve version
    if not version_id:
        print(f"[import-workflow] Fetching model {model_id}...")
        try:
            model_data = _civitai_api_get(_CIVITAI_API_MODEL.format(model_id=model_id))
        except Exception as e:
            print(f"ERROR: Failed to fetch model info: {e}", file=sys.stderr)
            sys.exit(1)

        model_name = model_data.get("name", f"model-{model_id}")
        model_type = model_data.get("type", "")
        versions = model_data.get("modelVersions", [])

        print(f"  Model: {model_name} (type={model_type})")
        print(f"  Versions available: {len(versions)}")

        if not versions:
            print("ERROR: No versions found for this model.", file=sys.stderr)
            sys.exit(1)

        version_data = versions[0]
        version_id = str(version_data.get("id", ""))
        version_name = version_data.get("name", "")
    else:
        # Fetch specific version
        print(f"[import-workflow] Fetching version {version_id}...")
        try:
            version_data = _civitai_api_get(_CIVITAI_API_VERSION.format(version_id=version_id))
        except Exception as e:
            print(f"ERROR: Failed to fetch version info: {e}", file=sys.stderr)
            sys.exit(1)

        model_name = version_data.get("model", {}).get("name", f"model-{model_id}")
        version_name = version_data.get("name", "")

    print(f"  Version: {version_name} (id={version_id})")

    # Step 2: Find workflow files
    files = version_data.get("files", [])
    json_files = [f for f in files if f.get("name", "").endswith(".json")]
    zip_files = [f for f in files if f.get("name", "").endswith(".zip")]

    # Also check for images with workflow metadata
    images = version_data.get("images", [])

    print(f"  Files: {len(json_files)} JSON, {len(zip_files)} ZIP, {len(images)} sample image(s)")

    if not json_files and not zip_files and not (args.extract_png and images):
        print("  No workflow files found.")
        if images:
            print(f"  Tip: {len(images)} sample images available. Use --extract-png to try extracting workflow from PNG metadata.")
        print()
        _print_version_summary(version_data)
        return

    # Step 3: Print summary
    _print_version_summary(version_data)

    if args.dry_run:
        print("\n[dry-run] Would download:")
        for f in json_files:
            print(f"  {f.get('name', '?')} ({f.get('sizeKB', '?')} KB)")
        if args.extract_png and images:
            print(f"  + {len(images)} PNG image(s) for metadata extraction")
        return

    # Step 4: Download JSON files
    os.makedirs(output_dir, exist_ok=True)
    downloaded = []

    for f in json_files:
        filename = f.get("name", f"workflow-{version_id}.json")
        download_url = f.get("downloadUrl", "")
        if not download_url:
            # Construct download URL
            download_url = f"https://civitai.com/api/download/models/{version_id}?type=Model&format=Other"

        dest_path = os.path.join(output_dir, _sanitize_filename(filename))
        print(f"\n  Downloading: {filename}")
        try:
            _download_file(download_url, dest_path)
            downloaded.append(dest_path)
        except Exception as e:
            print(f"  WARNING: Download failed: {e}", file=sys.stderr)

    # Step 4b: Download and extract ZIP files
    for f in zip_files:
        filename = f.get("name", f"workflow-{version_id}.zip")
        download_url = f.get("downloadUrl", "")
        if not download_url:
            download_url = f"https://civitai.com/api/download/models/{version_id}?type=Model&format=Other"

        print(f"\n  Downloading ZIP: {filename}")
        try:
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
                tmp_path = tmp.name
            _download_file(download_url, tmp_path)
            zip_extracted = _extract_zip_workflows(tmp_path, output_dir)
            downloaded.extend(zip_extracted)
            os.unlink(tmp_path)
        except Exception as e:
            print(f"  WARNING: ZIP download/extract failed: {e}", file=sys.stderr)
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    # Step 5: Extract PNG metadata
    if args.extract_png and images:
        png_workflows = _extract_png_workflows(images, output_dir, version_id)
        downloaded.extend(png_workflows)

    # Step 6: Parse if requested
    if args.parse and downloaded:
        from app.comfyui_workflow_parser import parse_workflow_file, print_workflow_summary
        print()
        for path in downloaded:
            if path.endswith(".json"):
                print("=" * 60)
                try:
                    summary = parse_workflow_file(path)
                    print_workflow_summary(summary)
                except Exception as e:
                    print(f"  Parse error: {e}")
                print()

    # Summary
    print(f"\n[import-workflow] Done: {len(downloaded)} file(s) saved to {output_dir}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sanitize_filename(name: str) -> str:
    """Make a filename safe for the filesystem."""
    # Remove/replace problematic characters
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    name = re.sub(r'\s+', '-', name)
    return name


def _print_version_summary(version_data: dict) -> None:
    """Print a brief summary of the version metadata."""
    base_model = version_data.get("baseModel", "")
    trained_words = version_data.get("trainedWords", [])
    desc = version_data.get("description", "")

    print()
    if base_model:
        print(f"  Base model: {base_model}")
    if trained_words:
        print(f"  Trained words: {', '.join(trained_words[:5])}")
    if desc:
        snippet = desc[:200].replace('\n', ' ').strip()
        print(f"  Description: {snippet}{'...' if len(desc) > 200 else ''}")

    # List files
    files = version_data.get("files", [])
    if files:
        print(f"  Files:")
        for f in files:
            size_kb = f.get("sizeKB", 0)
            size_str = f"{size_kb:.0f} KB" if size_kb else "?"
            ftype = f.get("type", "?")
            print(f"    [{ftype}] {f.get('name', '?')} ({size_str})")

    # List images
    images = version_data.get("images", [])
    if images:
        print(f"  Sample images: {len(images)}")


def _extract_png_workflows(images: list[dict], output_dir: str,
                           version_id: str) -> list[str]:
    """Download sample PNG images and extract embedded workflow JSON from metadata.

    ComfyUI stores workflow JSON in PNG text chunks under the 'workflow' key.
    """
    from PIL import Image
    import io

    extracted = []
    for i, img_info in enumerate(images[:3]):  # Max 3 images
        img_url = img_info.get("url", "")
        if not img_url:
            continue

        if not img_url.startswith("http"):
            img_url = f"https://image.civitai.com/{img_url}"

        print(f"\n  Extracting PNG metadata from image {i+1}/{min(3, len(images))}...")
        try:
            resp = requests.get(img_url, timeout=30, stream=True)
            resp.raise_for_status()

            # Load into PIL to read metadata
            img = Image.open(io.BytesIO(resp.content))
            metadata = img.text if hasattr(img, 'text') else {}

            # Check for workflow JSON
            workflow_json_str = metadata.get("workflow") or metadata.get("Workflow")
            if workflow_json_str:
                out_name = f"extracted-v{version_id}-img{i+1}.json"
                out_path = os.path.join(output_dir, out_name)
                with open(out_path, "w", encoding="utf-8") as f:
                    # Validate it's proper JSON first
                    data = json.loads(workflow_json_str)
                    json.dump(data, f, indent=2, ensure_ascii=False)
                extracted.append(out_path)
                print(f"    Extracted workflow → {out_name}")
            else:
                # Check for prompt (also useful)
                prompt_str = metadata.get("prompt") or metadata.get("Prompt")
                if prompt_str:
                    out_name = f"extracted-v{version_id}-img{i+1}-prompt.json"
                    out_path = os.path.join(output_dir, out_name)
                    with open(out_path, "w", encoding="utf-8") as f:
                        data = json.loads(prompt_str)
                        json.dump(data, f, indent=2, ensure_ascii=False)
                    extracted.append(out_path)
                    print(f"    Extracted prompt → {out_name} (no workflow metadata)")
                else:
                    print(f"    No workflow metadata found in PNG")

        except Exception as e:
            print(f"    Failed: {e}")

    return extracted


def _extract_zip_workflows(zip_path: str, output_dir: str) -> list[str]:
    """Extract .json workflow files from a downloaded ZIP archive.

    Returns list of extracted file paths.
    """
    import zipfile

    extracted = []
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            for entry in zf.namelist():
                if entry.endswith(".json") and not entry.startswith("__MACOSX"):
                    # Read and validate JSON
                    with zf.open(entry) as f:
                        raw = f.read()
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    # Skip if not a ComfyUI workflow (no "nodes" key)
                    if not isinstance(data, dict) or "nodes" not in data:
                        continue

                    basename = os.path.basename(entry)
                    if not basename:
                        basename = "workflow.json"
                    out_path = os.path.join(output_dir, _sanitize_filename(basename))
                    with open(out_path, "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=2, ensure_ascii=False)
                    extracted.append(out_path)
                    print(f"    Extracted: {basename}")

    except zipfile.BadZipFile:
        print(f"    WARNING: Not a valid ZIP file", file=sys.stderr)

    if not extracted:
        print(f"    No ComfyUI workflow JSON found in ZIP")

    return extracted
