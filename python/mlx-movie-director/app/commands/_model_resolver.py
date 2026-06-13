"""Model path resolution — LoRA, VAE, and safetensors directory discovery.

Split from _shared.py (was ~903 lines).
"""

import os
import sys

from app import config as cfg


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _find_safetensors_in_dir(directory: str) -> str:
    """Find the single .safetensors file in a directory. Exit if 0 or >1."""
    files = [f for f in os.listdir(directory) if f.endswith(".safetensors")]
    if len(files) == 1:
        return os.path.abspath(os.path.join(directory, files[0]))
    if not files:
        print(f"ERROR: no .safetensors file found in {directory}", file=sys.stderr)
        sys.exit(1)
    print(f"ERROR: multiple .safetensors files in {directory}: {', '.join(files)}",
          file=sys.stderr)
    print(f"  Use full path to specify which one.", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# LoRA resolution
# ---------------------------------------------------------------------------

def resolve_lora_path(raw: str | None) -> str | None:
    """Resolve a --lora-path value to an absolute .safetensors file path.

    Accepts:
      1. Full path to a .safetensors file  → used as-is
      2. Path to a directory               → find the .safetensors inside
      3. Short name (e.g. "klein-slider-bodyweight-50")
         → search models/lora/ for a matching subdirectory
      4. Partial name (e.g. "klein-slider")
         → matches if exactly one lora dir starts with it

    Returns None if raw is None. Exits with error if unresolvable.
    """
    if raw is None:
        return None

    # Already a full path to a file
    if os.path.isfile(raw):
        return os.path.abspath(raw)

    lora_base = os.path.join(cfg.MODELS_DIR, "lora")

    # Check if it's a path to a directory (absolute or relative)
    if os.path.isdir(raw):
        return _find_safetensors_in_dir(raw)

    # Check models/lora/<raw> as a directory name
    candidate = os.path.join(lora_base, raw)
    if os.path.isdir(candidate):
        return _find_safetensors_in_dir(candidate)

    # Partial name match: find dirs that start with the given prefix
    if os.path.isdir(lora_base):
        matches = [
            d for d in os.listdir(lora_base)
            if os.path.isdir(os.path.join(lora_base, d)) and d.startswith(raw)
        ]
        if len(matches) == 1:
            print(f"  LoRA resolved: {raw} → {matches[0]}")
            return _find_safetensors_in_dir(os.path.join(lora_base, matches[0]))
        elif len(matches) > 1:
            print(f"ERROR: ambiguous LoRA name '{raw}' matches: {', '.join(matches)}",
                  file=sys.stderr)
            print(f"  Use a more specific name.", file=sys.stderr)
            sys.exit(1)

    print(f"ERROR: cannot resolve LoRA '{raw}'", file=sys.stderr)
    print(f"  Searched: file path, models/lora/{raw}, partial match in models/lora/",
          file=sys.stderr)
    sys.exit(1)


def list_available_loras(pipeline_filter: str | None = None) -> None:
    """List available LoRAs from the model registry, optionally filtered by pipeline.

    Args:
        pipeline_filter: If set, only show LoRAs with this pipeline in their manifest.
                         E.g. "zimage-turbo", "flux2-klein".
    """
    from app.model_registry import ModelRegistry

    registry = ModelRegistry(cfg.MODELS_DIR)
    lorals = registry.list("lora")

    if not lorals:
        print("No LoRAs found in models/lora/")
        return

    if pipeline_filter:
        lorals = [l for l in lorals if pipeline_filter in l.get("pipeline", [])]
        if not lorals:
            print(f"No LoRAs found for pipeline '{pipeline_filter}'.")
            print(f"Available pipelines: {', '.join(sorted(set(p for l in registry.list('lora') for p in l.get('pipeline', []))))}")
            return

    # Format table
    print(f"\n{'Name':<35} {'Arch':<20} {'Pipeline':<20} {'Size':>10}  Description")
    print(f"{'─'*35} {'─'*20} {'─'*20} {'─'*10}  {'─'*40}")
    for l in lorals:
        name = l.get("name", "?")
        arch = l.get("arch", "?")
        pipelines = ", ".join(l.get("pipeline", []))
        size_mb = l.get("size_bytes", 0) / (1024 * 1024)
        desc = l.get("description", "")
        # Truncate long descriptions
        if len(desc) > 60:
            desc = desc[:57] + "..."
        print(f"{name:<35} {arch:<20} {pipelines:<20} {size_mb:>8.1f}MB  {desc}")

    print(f"\n{len(lorals)} LoRA(s) found" + (f" (pipeline={pipeline_filter})" if pipeline_filter else ""))


# ---------------------------------------------------------------------------
# VAE resolution
# ---------------------------------------------------------------------------

def resolve_vae_path(raw: str | None) -> str | None:
    """Resolve a --vae-path value to an absolute directory path.

    Accepts:
      1. Full path to a directory  → used as-is
      2. Short name (e.g. "ultraflux")
         → search models/vae/ for a matching subdirectory
      3. Partial name prefix match

    Returns None if raw is None. Exits with error if unresolvable.
    """
    if raw is None:
        return None

    if os.path.isdir(raw):
        return os.path.abspath(raw)

    vae_base = os.path.join(cfg.MODELS_DIR, "vae")

    candidate = os.path.join(vae_base, raw)
    if os.path.isdir(candidate):
        return os.path.abspath(candidate)

    if os.path.isdir(vae_base):
        matches = [
            d for d in os.listdir(vae_base)
            if os.path.isdir(os.path.join(vae_base, d)) and d.startswith(raw)
        ]
        if len(matches) == 1:
            print(f"  VAE resolved: {raw} → {matches[0]}")
            return os.path.abspath(os.path.join(vae_base, matches[0]))
        elif len(matches) > 1:
            print(f"ERROR: ambiguous VAE name '{raw}' matches: {', '.join(matches)}",
                  file=sys.stderr)
            print(f"  Use a more specific name.", file=sys.stderr)
            sys.exit(1)

    print(f"ERROR: cannot resolve VAE '{raw}'", file=sys.stderr)
    print(f"  Searched: directory path, models/vae/{raw}, partial match in models/vae/",
          file=sys.stderr)
    sys.exit(1)
