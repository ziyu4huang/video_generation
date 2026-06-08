"""import-lora-image — import a LoRA .safetensors file into the model registry.

Copies the LoRA file to models/lora/<name>/, generates manifest.json and README.md
following the project's model manifest schema. Validates architecture compatibility
and auto-detects companion link files for source attribution.

Accepts local files or URLs (CivitAI, HuggingFace, etc.).
URL import uses rule-based detection first; AI enrichment runs by default
to extract trigger words, test prompts, and recommended scale from model metadata.
Use --no-ai to disable AI enrichment.

Examples:
  # Import from CivitAI URL (arch auto-detected, AI enrichment ON by default)
  run.py import-lora-image \\
    'https://civitai.com/models/2194714/jib-mix-realistic-z-image-lora?modelVersionId=2471161'

  # Basic local file import (name derived from filename)
  run.py import-lora-image ~/Downloads/my-lora.safetensors --arch zimage-turbo

  # Pass both LoRA and link file (order doesn't matter)
  run.py import-lora-image my-lora.safetensors my-lora.webloc --arch flux2-klein-9b

  # With trigger words and test prompt (recommended)
  run.py import-lora-image my-lora.safetensors --arch zimage-turbo \\
      --trigger-words "style1,style2" --test-prompt "a photo in STYLE style"

  # Disable AI enrichment (rule-based only)
  run.py import-lora-image 'https://civitai.com/models/1234/...' --no-ai
"""

import json
import math
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

import requests

from app import config as cfg

PARSER_META = {
    "help": "Import a LoRA .safetensors file into the model registry",
    "description": (
        "Import a LoRA adapter into models/lora/<name>/ with manifest.json and README.md.\n\n"
        "Accepts local files or URLs (CivitAI, HuggingFace, etc.).\n"
        "URL import auto-detects arch and metadata via API.\n"
        "AI enrichment runs by default to extract trigger words and metadata\n"
        "from model descriptions. Use --no-ai to disable.\n\n"
        "Architectures are strictly separated — a LoRA trained for one arch will not\n"
        "work with another. Choose the correct --arch for your LoRA.\n\n"
        "Examples:\n"
        "  run.py import-lora-image 'https://civitai.com/models/2194714/...?modelVersionId=2471161'\n"
        "  run.py import-lora-image my-lora.safetensors --arch zimage-turbo\n"
        "  run.py import-lora-image my-lora.safetensors my-lora.webloc --arch flux2-klein-9b\n"
    ),
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Arch → metadata mapping for manifest.json
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

# CivitAI URL patterns and API endpoints
_CIVITAI_URL_RE = re.compile(r"civitai\.(com|red)/models/(\d+)")
_CIVITAI_API_MODEL = "https://civitai.com/api/v1/models/{model_id}"
_CIVITAI_API_VERSION = "https://civitai.com/api/v1/model-versions/{version_id}"
_CIVITAI_DOWNLOAD = "https://civitai.com/api/download/models/{version_id}"

# Module-level token cache (set from --civitai-token or CIVITAI_TOKEN env var)
_civitai_token_cache: dict = {}

# CivitAI baseModel → project arch name mapping
_CIVITAI_BASEMODEL_TO_ARCH = {
    "ZImageTurbo": "zimage-turbo",
    "ZImage": "zimage-base",
    "Flux": "flux2-klein-9b",
    "Flux.2 Klein 9B": "flux2-klein-9b",
    "Flux.2 Klein 4B": "flux2-klein-4b",
    "SD 1.5": None,  # unsupported
    "SDXL": None,  # unsupported
}

# LLM endpoint defaults (same as caption.py)
_DEFAULT_API_URL = "http://localhost:1234/v1"
_DEFAULT_MODEL = "qwen/qwen3-vl-4b"

_LINK_EXTENSIONS = {".url", ".webloc", ".txt"}

_MANIFEST_COMMENT = (
    "Private metadata for mlx-movie-director model registry. "
    "Created by convert.py or manually. Validated by `run.py check-manifests`. "
    "See docs/models.md for schema docs."
)

# ---------------------------------------------------------------------------
# AI assistant prompt templates
# ---------------------------------------------------------------------------

_AI_IMPORT_PROMPT = """\
You are a LoRA model import assistant for a macOS image generation pipeline (mlx-movie-director).

The user wants to import a LoRA. Analyze the input below and extract import parameters.

Known architectures: zimage-turbo, zimage-base, flux2-klein-9b, flux2-klein-4b, ltx-2.3

Input: {input_str}

Respond with ONLY a JSON object (no markdown fences, no explanation):
{{
  "source": "civitai" | "huggingface" | "unknown",
  "model_id": "numeric model id if available, else empty",
  "version_id": "numeric version id if available, else empty",
  "download_url": "direct download URL if you can construct it, else empty",
  "suggested_name": "lowercase-hyphen-name for the model directory",
  "suggested_arch": "one of: zimage-turbo, zimage-base, flux2-klein-9b, flux2-klein-4b, ltx-2.3, or unknown",
  "description": "one-line description of the LoRA",
  "confidence": "high" | "medium" | "low"
}}"""

_AI_ENRICH_PROMPT = """\
You are a LoRA metadata extraction assistant. Analyze the CivitAI model data below \
and extract structured metadata.

RULES:
- Extract trigger words from the description, trainedWords field, tags, and image prompts.
  Trigger words are short phrases the model creator intended users to include in prompts \
to activate the LoRA style/concept.
- If trainedWords is non-empty, include those words. Also extract any additional trigger words \
mentioned in the description text (e.g., "use 'keyword' to activate", "trigger: xyz").
- Generate a test_prompt that demonstrates usage of the trigger words. Keep it under 100 words.
- Extract recommended LoRA scale/weight from the description if mentioned (e.g., \
"recommended weight 0.8", "use at 0.6-1.0"). If not mentioned or unclear, set to null.
- Enhance the description to be a single informative line (under 120 chars).

INPUT DATA:
Model name: {model_name}
Architecture: {arch}
Trained words (from API): {trained_words}
Tags: {tags}
Base model: {base_model}
Version description:
{version_description}
Model description:
{model_description}
Sample image prompts:
{image_prompts}

Respond with ONLY a JSON object (no markdown fences, no explanation):
{{
  "trigger_words": ["word1", "word2"],
  "test_prompt": "a photo of ... using trigger words ...",
  "description": "enhanced one-line description",
  "recommended_scale": 0.8,
  "confidence": "high"
}}

If recommended_scale cannot be determined, set it to null.
If no trigger words are found, return an empty array."""


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_args(parser):
    parser.add_argument("files", nargs="+", metavar="FILE_OR_URL",
                        help="LoRA .safetensors file or URL (CivitAI, HuggingFace, etc.), "
                             "optionally followed by a link file (.url, .webloc, .txt)")
    parser.add_argument("--arch", required=False, choices=list(ARCH_METADATA.keys()),
                        help="Target architecture (required for local files, auto-detected for URLs)")
    parser.add_argument("--name", type=str, default=None,
                        help="Instance name (default: derived from filename or API metadata)")
    parser.add_argument("--source", type=str, default=None,
                        help="Source identifier, e.g. 'civitai/user/model'")
    parser.add_argument("--source-url", type=str, default=None,
                        help="Direct URL to LoRA source page")
    parser.add_argument("--link-file", type=str, default=None, metavar="PATH",
                        help="Path to companion link/URL file (also accepted as 2nd positional)")
    parser.add_argument("--format", type=str, default=None, metavar="FMT",
                        help="Weight format override (default: auto-detected from tensor dtype)")
    parser.add_argument("--description", type=str, default=None,
                        help="Human-readable description")
    parser.add_argument("--trigger-words", type=str, default=None,
                        help="Comma-separated trigger words (recommended)")
    parser.add_argument("--test-prompt", type=str, default=None,
                        help="Reference test prompt (recommended)")
    # AI assistant options (AI enrichment is ON by default)
    parser.add_argument("--no-ai", action="store_true", default=False,
                        help="Disable AI metadata enrichment (use rule-based data only)")
    parser.add_argument("--api-url", type=str, default=_DEFAULT_API_URL,
                        help=f"LLM API base URL for AI assistant (default: {_DEFAULT_API_URL})")
    parser.add_argument("--model", type=str, default=_DEFAULT_MODEL,
                        help=f"LLM model name for AI assistant (default: {_DEFAULT_MODEL})")
    parser.add_argument("--civitai-token", type=str, default=None,
                        help="CivitAI API token for downloads (or set CIVITAI_TOKEN env var)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(args):
    # Set CivitAI token from CLI arg or env var (supports both CIVITAI_TOKEN and CIVITAI_API_TOKEN)
    token = getattr(args, "civitai_token", None) or os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN")
    if token:
        _civitai_token_cache["token"] = token
        if not os.environ.get("CIVITAI_TOKEN"):
            os.environ["CIVITAI_TOKEN"] = token

    input_str = args.files[0]

    if _is_url(input_str):
        _run_url_import(input_str, args)
    else:
        _run_local_import(args.files, args)


# ---------------------------------------------------------------------------
# URL import flow
# ---------------------------------------------------------------------------

def _run_url_import(url: str, args) -> None:
    """Import a LoRA from a URL. Rule-based first, AI enrichment second."""
    print(f"[import-lora-image] URL detected: {url}")

    # Phase 1: Try rule-based detection (fetch raw CivitAI data for AI enrichment)
    include_raw = not args.no_ai
    import_info = _try_rule_based_import(url, include_raw=include_raw)

    # Phase 2: AI fallback if rule-based failed entirely
    if import_info is None:
        try:
            import_info = _try_ai_import(url, args)
        except Exception as e:
            print(f"  AI assistant failed: {e}", file=sys.stderr)

    if import_info is None:
        print("ERROR: Could not auto-detect import parameters from URL.", file=sys.stderr)
        print("  Provide manually: --arch <arch> --source-url <url>", file=sys.stderr)
        sys.exit(1)

    # Phase 3: AI enrichment (default ON, skip if --no-ai)
    if not args.no_ai:
        _try_ai_enrichment(import_info, args)

    # Phase 4: CLI overrides take precedence over everything
    _apply_cli_overrides(import_info, args)

    # Validate we have an arch
    if not import_info.get("arch"):
        print("ERROR: Architecture not detected. Use --arch to specify manually.", file=sys.stderr)
        sys.exit(1)
    if import_info["arch"] not in ARCH_METADATA:
        print(f"ERROR: Unknown arch '{import_info['arch']}'. "
              f"Supported: {', '.join(ARCH_METADATA.keys())}", file=sys.stderr)
        sys.exit(1)

    _execute_import_from_info(import_info, args)


def _try_rule_based_import(url: str, include_raw: bool = False) -> dict | None:
    """Try to extract import info from a known URL pattern.

    Returns dict with keys: name, arch, source_url, download_url, filename,
    description, trigger_words, version_id. Returns None if pattern not matched.
    """
    # CivitAI detection
    model_id = _parse_civitai_model_id(url)
    if model_id:
        print(f"  CivitAI model detected (id={model_id})")
        return _resolve_civitai_import(url, model_id, include_raw=include_raw)

    # Add HuggingFace, etc. here in the future

    return None


def _try_ai_import(url: str, args) -> dict | None:
    """Use local LLM to analyze a URL and extract import parameters."""
    prompt = _AI_IMPORT_PROMPT.format(input_str=url)
    response = _call_llm(args.api_url, args.model, prompt)

    # Parse JSON from LLM response
    # Strip markdown fences if present
    response = re.sub(r"^```(?:json)?\s*", "", response)
    response = re.sub(r"\s*```$", "", response)

    try:
        data = json.loads(response)
    except json.JSONDecodeError:
        print(f"  AI returned invalid JSON: {response[:200]}", file=sys.stderr)
        return None

    confidence = data.get("confidence", "low")
    if confidence == "low":
        print(f"  AI has low confidence. Suggested: {data.get('suggested_arch', '?')}")
        return None

    info = {
        "name": data.get("suggested_name", ""),
        "arch": data.get("suggested_arch") if data.get("suggested_arch") != "unknown" else None,
        "source_url": url,
        "download_url": data.get("download_url", ""),
        "filename": "",
        "description": data.get("description", ""),
        "trigger_words": [],
        "version_id": data.get("version_id", ""),
    }

    # If AI provided a CivitAI model/version ID, enrich with API metadata
    version_id = data.get("version_id", "")
    if version_id and version_id.isdigit():
        print(f"  AI found version ID {version_id}, fetching API metadata...")
        try:
            civitai_info = _fetch_civitai_version_metadata(version_id)
            if civitai_info:
                # Merge API metadata over AI suggestions (API is more reliable)
                info.update({k: v for k, v in civitai_info.items() if v})
        except Exception as e:
            print(f"  API metadata fetch failed: {e}", file=sys.stderr)

    print(f"  AI suggests: name={info['name']}, arch={info['arch']}, "
          f"confidence={confidence}")
    return info


def _try_ai_enrichment(info: dict, args) -> None:
    """Attempt AI enrichment of import metadata. Warns but continues on failure.

    Reads 'civitai_raw' from info dict, sends to LLM for trigger word extraction,
    and merges results back into info. Always removes 'civitai_raw' afterward.
    """
    civitai_raw = info.get("civitai_raw")
    if not civitai_raw:
        return

    print("  AI enrichment: extracting trigger words from model metadata...")

    if not _check_llm_available(args.api_url):
        print(f"  WARNING: LLM endpoint not reachable at {args.api_url}", file=sys.stderr)
        print("  Proceeding with rule-based metadata only.", file=sys.stderr)
        info.pop("civitai_raw", None)
        return

    try:
        enrichment = _ai_enrich_metadata(info, args)
        if enrichment:
            # Merge trigger words: keep rule-based, append AI extras (dedup)
            ai_tw = enrichment.get("trigger_words", [])
            if ai_tw:
                existing = info.get("trigger_words", [])
                combined = existing + [w for w in ai_tw if w not in existing]
                info["trigger_words"] = combined

            # test_prompt: only fill if rule-based didn't provide one
            if enrichment.get("test_prompt") and not info.get("test_prompt"):
                info["test_prompt"] = enrichment["test_prompt"]

            # description: replace generic placeholders, keep specific ones
            if enrichment.get("description"):
                current = info.get("description", "")
                if not current or current.startswith("LoRA adapter"):
                    info["description"] = enrichment["description"]

            # recommended_scale: always take AI suggestion
            if enrichment.get("recommended_scale"):
                info["recommended_scale"] = enrichment["recommended_scale"]

            tw = info.get("trigger_words", [])
            scale = enrichment.get("recommended_scale")
            print(f"  AI enrichment: {len(tw)} trigger words"
                  + (f", recommended scale={scale}" if scale else ""))
        else:
            print("  AI enrichment: LLM returned no usable data.")
    except Exception as e:
        print(f"  WARNING: AI enrichment failed: {e}", file=sys.stderr)
        print("  Proceeding with rule-based metadata.", file=sys.stderr)
    finally:
        # Always clean up raw data before it reaches the manifest
        info.pop("civitai_raw", None)


def _apply_cli_overrides(info: dict, args) -> None:
    """Merge explicit CLI args over auto-detected info."""
    if args.name:
        info["name"] = _sanitize_name(args.name)
    if args.arch:
        info["arch"] = args.arch
    if args.source_url:
        info["source_url"] = args.source_url
    if args.description:
        info["description"] = args.description
    if args.trigger_words:
        info["trigger_words"] = [w.strip() for w in args.trigger_words.split(",") if w.strip()]


def _execute_import_from_info(info: dict, args) -> None:
    """Download file and run the standard manifest + README generation."""
    name = info["name"]
    arch = info["arch"]
    download_url = info["download_url"]
    source_url = info.get("source_url", "")
    description = info.get("description", f"LoRA adapter for {arch}")
    trigger_words = info.get("trigger_words", [])
    test_prompt = args.test_prompt or info.get("test_prompt")
    recommended_scale = info.get("recommended_scale")

    # Target directory
    target_dir = os.path.join(cfg.MODELS_DIR, "lora", name)
    if os.path.exists(target_dir):
        print(f"ERROR: target directory already exists: {target_dir}", file=sys.stderr)
        print(f"  Use --name to choose a different name, or remove the existing directory.",
              file=sys.stderr)
        sys.exit(1)

    # Download
    filename = info.get("filename") or _derive_filename_from_url(download_url, name)
    dest_path = os.path.join(target_dir, filename)

    print(f"  Downloading: {download_url}")
    os.makedirs(target_dir, exist_ok=True)
    _download_file(download_url, dest_path)

    file_size = os.path.getsize(dest_path)

    # Detect format
    fmt = args.format or _detect_format(dest_path)

    # Build manifest
    arch_meta = ARCH_METADATA[arch]
    manifest = {
        "_comment": _MANIFEST_COMMENT,
        "name": name,
        "type": "lora",
        "arch": arch,
        "format": fmt,
        "description": description,
        "source": f"civitai/{name}",
        "compatible_with": arch_meta["compatible_with"],
        "size_bytes": file_size,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if arch_meta["pipeline"]:
        manifest["pipeline"] = arch_meta["pipeline"]
    if source_url:
        manifest["source_url"] = source_url
    if trigger_words:
        manifest["trigger_words"] = trigger_words
    if test_prompt:
        manifest["test_prompt"] = test_prompt
    if recommended_scale:
        manifest["recommended_scale"] = recommended_scale

    manifest_path = os.path.join(target_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Generate README
    readme = _generate_readme(
        name=name, arch=arch, filename=filename, file_size=file_size,
        description=description, source=f"civitai/{name}", source_url=source_url,
        trigger_words=trigger_words, test_prompt=test_prompt,
        recommended_scale=recommended_scale,
    )
    with open(os.path.join(target_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme)

    # Summary
    size_mb = file_size / 1_048_576
    print(f"\n[import-lora-image] Imported: {name}")
    print(f"  Directory:  {target_dir}")
    print(f"  File:       {filename} ({size_mb:.1f} MB)")
    print(f"  Arch:       {arch}")
    print(f"  Format:     {fmt}")
    if trigger_words:
        print(f"  Triggers:   {', '.join(trigger_words)}")
    if recommended_scale:
        print(f"  Scale:      {recommended_scale}")
    if source_url:
        print(f"  Source URL: {source_url}")
    print()
    print(f"Validate: run.py check-model")
    print(f"Test:     run.py image --prompt '{test_prompt or 'test prompt'}' \\")
    if recommended_scale:
        print(f"            --lora-scale {recommended_scale} \\")
    print(f"            --lora-path {name}")


# ---------------------------------------------------------------------------
# CivitAI-specific helpers
# ---------------------------------------------------------------------------

def _parse_civitai_model_id(url: str) -> str | None:
    """Extract CivitAI model ID from a URL. Returns None if not a CivitAI URL."""
    match = _CIVITAI_URL_RE.search(url)
    return match.group(2) if match else None


def _parse_civitai_version_id(url: str) -> str | None:
    """Extract modelVersionId from CivitAI URL query string."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    vids = params.get("modelVersionId", [])
    return vids[0] if vids else None


def _resolve_civitai_import(url: str, model_id: str,
                            include_raw: bool = False) -> dict | None:
    """Resolve CivitAI import: get version metadata, find download URL and arch."""
    # Determine version ID
    version_id = _parse_civitai_version_id(url)
    if not version_id:
        # Fetch model info to get the latest version
        print(f"  No version ID in URL, fetching model {model_id}...")
        try:
            model_data = _civitai_api_get(_CIVITAI_API_MODEL.format(model_id=model_id))
            versions = model_data.get("modelVersions", [])
            if not versions:
                print("  No versions found for this model.", file=sys.stderr)
                return None
            version_id = str(versions[0].get("id", ""))
        except Exception as e:
            print(f"  Failed to fetch model info: {e}", file=sys.stderr)
            return None

    if not version_id:
        return None

    return _fetch_civitai_version_metadata(version_id, include_raw=include_raw)


def _fetch_civitai_version_metadata(version_id: str,
                                     include_raw: bool = False) -> dict | None:
    """Fetch version metadata from CivitAI API and extract import info.

    When include_raw is True, also fetches model-level tags/description and
    collects sample image prompts for AI enrichment.
    """
    api_url = _CIVITAI_API_VERSION.format(version_id=version_id)
    data = _civitai_api_get(api_url)

    # Extract model name
    model_info = data.get("model", {})
    model_name = model_info.get("name", "")
    version_name = data.get("name", "")
    name = _sanitize_name(model_name) if model_name else f"civitai-{version_id}"

    # Map base model to arch
    base_model = data.get("baseModel", "")
    arch = _CIVITAI_BASEMODEL_TO_ARCH.get(base_model)
    if not arch:
        # Try case-insensitive match
        for key, val in _CIVITAI_BASEMODEL_TO_ARCH.items():
            if key.lower() == base_model.lower():
                arch = val
                break
    if not arch:
        print(f"  WARNING: unmapped CivitAI baseModel '{base_model}'. "
              f"Use --arch to specify.", file=sys.stderr)

    # Find primary .safetensors file
    files = data.get("files", [])
    download_url = _CIVITAI_DOWNLOAD.format(version_id=version_id)
    filename = ""
    for f in files:
        if f.get("type") == "Model" and f.get("primary"):
            filename = f.get("name", "")
            # Use the file's download URL if available (may include token)
            if f.get("downloadUrl"):
                download_url = f["downloadUrl"]
            break

    if not filename:
        # Fallback: find any .safetensors file
        for f in files:
            if f.get("name", "").endswith(".safetensors"):
                filename = f["name"]
                if f.get("downloadUrl"):
                    download_url = f["downloadUrl"]
                break

    # Extract trained words
    trained_words = data.get("trainedWords", [])
    if isinstance(trained_words, str):
        trained_words = [w.strip() for w in trained_words.split(",") if w.strip()]

    # Build description
    desc_parts = []
    if model_name:
        desc_parts.append(model_name)
    if version_name:
        desc_parts.append(version_name)
    training_details = data.get("trainingDetails") or {}
    training_type = training_details.get("type", "") if training_details else ""
    if training_type:
        desc_parts.append(f"({training_type} LoRA)")
    description = " ".join(desc_parts) if desc_parts else f"LoRA adapter (CivitAI #{version_id})"

    print(f"  Resolved: {name} | arch={arch or '?'} | {filename or 'unknown file'}")

    result = {
        "name": name,
        "arch": arch,
        "source_url": f"https://civitai.com/models/{data.get('modelId', '')}",
        "download_url": download_url,
        "filename": filename,
        "description": description,
        "trigger_words": trained_words,
        "version_id": version_id,
    }

    # Collect raw CivitAI data for AI enrichment
    if include_raw:
        model_tags = []
        model_desc_html = ""
        try:
            model_data = _civitai_api_get(
                _CIVITAI_API_MODEL.format(model_id=data.get("modelId", ""))
            )
            model_tags = [t.get("name", "") for t in model_data.get("tags", [])
                          if isinstance(t, dict)]
            model_desc_html = model_data.get("description", "")
        except Exception:
            pass

        # Collect sample image prompts (first 3 max)
        image_prompts = []
        for img in data.get("images", [])[:3]:
            meta = img.get("meta", {}) or {}
            prompt = meta.get("prompt", "")
            if prompt:
                image_prompts.append(prompt)

        result["civitai_raw"] = {
            "version_description_html": data.get("description", ""),
            "model_description_html": model_desc_html,
            "trained_words": data.get("trainedWords", []),
            "training_details": data.get("trainingDetails", {}),
            "tags": model_tags,
            "base_model": base_model,
            "image_prompts": image_prompts,
        }

    return result


def _civitai_api_get(url: str) -> dict:
    """GET a CivitAI API endpoint and return parsed JSON."""
    token = os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN") or _civitai_token_cache.get("token")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, timeout=30, headers=headers)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

def _download_file(url: str, dest_path: str, chunk_size: int = 8192) -> None:
    """Download a file with progress display. Follows redirects."""
    token = os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN") or _civitai_token_cache.get("token")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, stream=True, timeout=300, allow_redirects=True, headers=headers)
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
                    mb_done = downloaded / 1_048_576
                    mb_total = total / 1_048_576
                    print(f"    {pct}% ({mb_done:.1f}/{mb_total:.1f} MB)")
                    last_pct = pct

    mb = os.path.getsize(dest_path) / 1_048_576
    print(f"    Downloaded: {mb:.1f} MB")


# ---------------------------------------------------------------------------
# LLM helpers (reuses same LM Studio endpoint as caption.py)
# ---------------------------------------------------------------------------

def _call_llm(api_url: str, model: str, prompt: str) -> str:
    """Text-only LLM call via OpenAI-compatible API (same endpoint as caption)."""
    url = f"{api_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1024,
        "temperature": 0.2,
        "stream": False,
    }
    resp = requests.post(url, json=payload, timeout=60)
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    # Strip Qwen3 <think/> reasoning blocks if present
    return re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()


def _check_llm_available(api_url: str, timeout: float = 3.0) -> bool:
    """Quick health check for the LLM endpoint. Returns True if reachable."""
    try:
        url = f"{api_url}/models"
        resp = requests.get(url, timeout=timeout)
        return resp.status_code == 200
    except (requests.ConnectionError, requests.Timeout):
        return False


# ---------------------------------------------------------------------------
# AI enrichment helpers
# ---------------------------------------------------------------------------

def _truncate_html(html: str, max_chars: int = 2000) -> str:
    """Strip HTML tags, collapse whitespace, and truncate to max_chars."""
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_chars:
        text = text[:max_chars] + "..."
    return text


def _ai_enrich_metadata(info: dict, args) -> dict | None:
    """Use LLM to enrich import metadata from raw CivitAI data.

    Returns an enrichment dict with keys: trigger_words, test_prompt,
    description, recommended_scale. Returns None if LLM call fails or
    returns no usable data.
    """
    civitai_raw = info.get("civitai_raw")
    if not civitai_raw:
        return None

    version_desc = _truncate_html(
        civitai_raw.get("version_description_html", ""), 2000
    )
    model_desc = _truncate_html(
        civitai_raw.get("model_description_html", ""), 2000
    )
    image_prompts = "\n---\n".join(civitai_raw.get("image_prompts", []))
    trained_words = json.dumps(civitai_raw.get("trained_words", []))
    tags = ", ".join(civitai_raw.get("tags", []))
    base_model = civitai_raw.get("base_model", "")

    prompt = _AI_ENRICH_PROMPT.format(
        model_name=info.get("name", ""),
        arch=info.get("arch", ""),
        trained_words=trained_words,
        tags=tags,
        base_model=base_model,
        version_description=version_desc,
        model_description=model_desc,
        image_prompts=image_prompts or "(none)",
    )

    response = _call_llm(args.api_url, args.model, prompt)

    # Strip markdown fences
    response = re.sub(r"^```(?:json)?\s*", "", response)
    response = re.sub(r"\s*```$", "", response)

    try:
        data = json.loads(response)
    except json.JSONDecodeError:
        print(f"  AI enrichment returned invalid JSON: {response[:200]}", file=sys.stderr)
        return None

    result = {}
    if isinstance(data.get("trigger_words"), list):
        result["trigger_words"] = data["trigger_words"]
    if isinstance(data.get("test_prompt"), str) and data["test_prompt"]:
        result["test_prompt"] = data["test_prompt"]
    if isinstance(data.get("description"), str) and data["description"]:
        result["description"] = data["description"]
    if data.get("recommended_scale") is not None:
        try:
            result["recommended_scale"] = float(data["recommended_scale"])
        except (ValueError, TypeError):
            pass

    return result if result else None


# ---------------------------------------------------------------------------
# URL / filename utilities
# ---------------------------------------------------------------------------

def _is_url(s: str) -> bool:
    """Check if the string looks like a URL."""
    return s.startswith("http://") or s.startswith("https://")


def _derive_filename_from_url(url: str, name: str) -> str:
    """Derive a .safetensors filename from URL or name."""
    # Try to get filename from Content-Disposition or URL path
    parsed = urlparse(url)
    path = parsed.path
    basename = os.path.basename(path)
    if basename.endswith(".safetensors"):
        return basename
    # Fallback: construct from name
    return f"{name}.safetensors"


# ---------------------------------------------------------------------------
# Local file import flow (original logic, preserved)
# ---------------------------------------------------------------------------

def _run_local_import(file_args: list[str], args) -> None:
    """Import a LoRA from local file(s). Original import logic."""
    lora_path, explicit_link = _classify_inputs(file_args)
    src_path = os.path.abspath(lora_path)

    # --arch is required for local files
    if not args.arch:
        print("ERROR: --arch is required for local file imports.", file=sys.stderr)
        print(f"  Supported: {', '.join(ARCH_METADATA.keys())}", file=sys.stderr)
        sys.exit(1)

    # Validate input file
    if not os.path.exists(src_path):
        print(f"ERROR: file not found: {src_path}", file=sys.stderr)
        sys.exit(1)
    if not src_path.endswith(".safetensors"):
        print(f"WARNING: file does not have .safetensors extension: {src_path}",
              file=sys.stderr)

    # Derive name
    name = _sanitize_name(args.name) if args.name else _derive_name(src_path)

    # Check target directory
    target_dir = os.path.join(cfg.MODELS_DIR, "lora", name)
    if os.path.exists(target_dir):
        print(f"ERROR: target directory already exists: {target_dir}", file=sys.stderr)
        print(f"  Use --name to choose a different name, or remove the existing directory.",
              file=sys.stderr)
        sys.exit(1)

    # Detect format
    fmt = args.format or _detect_format(src_path)

    # Detect link URL
    link_url = args.source_url
    detected_link = None
    if not link_url:
        link_src = args.link_file or explicit_link
        if link_src:
            link_url = _read_link_file(link_src)
            detected_link = link_src
        else:
            link_url, detected_link = _auto_detect_link(src_path)
    if detected_link:
        print(f"  Link file:  {os.path.basename(detected_link)}")

    # Copy file and create directory
    os.makedirs(target_dir, exist_ok=True)
    dest_file = os.path.join(target_dir, os.path.basename(src_path))
    shutil.copy2(src_path, dest_file)
    file_size = os.path.getsize(dest_file)
    filename = os.path.basename(dest_file)

    # Parse optional fields
    trigger_words = None
    if args.trigger_words:
        trigger_words = [w.strip() for w in args.trigger_words.split(",") if w.strip()]

    source = args.source or "manual-import"
    description = args.description or f"LoRA adapter for {args.arch}"
    test_prompt = args.test_prompt
    recommended_scale = None
    arch_meta = ARCH_METADATA[args.arch]

    # AI enrichment for local import: if source is CivitAI, fetch metadata
    if link_url and not args.no_ai:
        model_id = _parse_civitai_model_id(link_url)
        if model_id:
            print("  CivitAI URL detected in link file, fetching metadata for AI enrichment...")
            try:
                version_id = _parse_civitai_version_id(link_url) or ""
                if not version_id:
                    # Try to get latest version
                    model_data = _civitai_api_get(
                        _CIVITAI_API_MODEL.format(model_id=model_id)
                    )
                    versions = model_data.get("modelVersions", [])
                    if versions:
                        version_id = str(versions[0].get("id", ""))

                if version_id:
                    civitai_info = _fetch_civitai_version_metadata(
                        version_id, include_raw=True
                    )
                    if civitai_info:
                        # Use API-provided trigger words if user didn't specify
                        if not trigger_words and civitai_info.get("trigger_words"):
                            trigger_words = civitai_info["trigger_words"]

                        # Use API-provided description if user didn't specify
                        if not args.description and civitai_info.get("description"):
                            api_desc = civitai_info["description"]
                            if not api_desc.startswith("LoRA adapter"):
                                description = api_desc

                        # Run AI enrichment on the raw data
                        if civitai_info.get("civitai_raw"):
                            enrich_info = {
                                "name": name,
                                "arch": args.arch,
                                "trigger_words": trigger_words or [],
                                "description": description,
                                "civitai_raw": civitai_info["civitai_raw"],
                            }
                            _try_ai_enrichment(enrich_info, args)

                            # Apply enrichment back to local vars
                            if enrich_info.get("trigger_words"):
                                trigger_words = enrich_info["trigger_words"]
                            if enrich_info.get("description") and not args.description:
                                description = enrich_info["description"]
                            if enrich_info.get("recommended_scale"):
                                recommended_scale = enrich_info["recommended_scale"]
                            if enrich_info.get("test_prompt") and not test_prompt:
                                test_prompt = enrich_info["test_prompt"]
            except Exception as e:
                print(f"  WARNING: CivitAI metadata enrichment failed: {e}",
                      file=sys.stderr)

    # Generate manifest.json
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
    if arch_meta["pipeline"]:
        manifest["pipeline"] = arch_meta["pipeline"]
    if link_url:
        manifest["source_url"] = link_url
    if trigger_words:
        manifest["trigger_words"] = trigger_words
    if test_prompt:
        manifest["test_prompt"] = test_prompt
    if recommended_scale:
        manifest["recommended_scale"] = recommended_scale

    manifest_path = os.path.join(target_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Generate README.md
    readme = _generate_readme(
        name=name, arch=args.arch, filename=filename, file_size=file_size,
        description=description, source=source, source_url=link_url,
        trigger_words=trigger_words, test_prompt=test_prompt,
        recommended_scale=recommended_scale,
    )
    readme_path = os.path.join(target_dir, "README.md")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(readme)

    # Print summary
    size_mb = file_size / 1_048_576
    print(f"[import-lora-image] Imported: {name}")
    print(f"  Directory:  {target_dir}")
    print(f"  File:       {filename} ({size_mb:.1f} MB)")
    print(f"  Arch:       {args.arch}")
    print(f"  Format:     {fmt}")
    if trigger_words:
        print(f"  Triggers:   {', '.join(trigger_words)}")
    if recommended_scale:
        print(f"  Scale:      {recommended_scale}")
    if link_url:
        print(f"  Source URL: {link_url}")
    print()
    print(f"Validate: run.py check-model")
    print(f"Test:     run.py image --prompt '{test_prompt or 'test prompt'}' \\")
    if recommended_scale:
        print(f"            --lora-scale {recommended_scale} \\")
    print(f"            --lora-path {os.path.join(target_dir, filename)}")


# ---------------------------------------------------------------------------
# Input classification (local files only)
# ---------------------------------------------------------------------------

def _classify_inputs(file_args: list[str]) -> tuple[str, str | None]:
    """Classify input files into (safetensors_path, link_path_or_None)."""
    lora_file = None
    link_file = None

    for path in file_args:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".safetensors":
            if lora_file:
                print("ERROR: multiple .safetensors files provided", file=sys.stderr)
                sys.exit(1)
            lora_file = path
        elif ext in _LINK_EXTENSIONS:
            if link_file:
                print("ERROR: multiple link files provided", file=sys.stderr)
                sys.exit(1)
            link_file = path
        else:
            print(f"WARNING: unrecognized file extension: {path}", file=sys.stderr)
            if lora_file is None:
                lora_file = path  # assume it's the LoRA file

    if not lora_file:
        print("ERROR: no .safetensors file found in arguments", file=sys.stderr)
        sys.exit(1)

    return lora_file, link_file


# ---------------------------------------------------------------------------
# Name helpers
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


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Link file detection & parsing
# ---------------------------------------------------------------------------

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
    ext = os.path.splitext(path)[1].lower()

    # .webloc: macOS property list (binary or XML)
    if ext == ".webloc":
        return _read_webloc(path)

    # .url, .txt, or other: text-based
    return _read_text_link(path)


def _read_webloc(path: str) -> str | None:
    """Extract URL from macOS .webloc (binary or XML plist)."""
    # Try binary plist first (modern macOS default)
    try:
        import plistlib
        with open(path, "rb") as f:
            data = plistlib.load(f)
        if isinstance(data, dict) and "URL" in data:
            return data["URL"]
    except Exception:
        pass

    # Fallback: try reading as XML text (older .webloc format)
    return _read_text_link(path)


def _read_text_link(path: str) -> str | None:
    """Extract URL from a .url, .txt, or XML-format .webloc file."""
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

    # XML plist: <dict><key>URL</key><string>https://...</string></dict>
    if "<dict>" in content:
        string_match = re.search(r"<string>(https?://[^<]+)</string>", content)
        if string_match:
            return string_match.group(1)

    # Plain text: first line matching a URL
    url_match = re.search(r"(https?://\S+)", content)
    if url_match:
        return url_match.group(1)

    return None


# ---------------------------------------------------------------------------
# README generation
# ---------------------------------------------------------------------------

def _generate_readme(*, name, arch, filename, file_size, description,
                     source, source_url, trigger_words, test_prompt,
                     recommended_scale=None) -> str:
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

    if recommended_scale:
        lines.extend([
            "",
            f"**Recommended scale:** `{recommended_scale}`",
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
        f"  --lora-scale {recommended_scale or 0.8}",
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
