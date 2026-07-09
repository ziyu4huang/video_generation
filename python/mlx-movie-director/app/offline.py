"""Offline generation support: environment gating + weight-presence preflight.

Goal: make `run.py` generate image AND video with **zero runtime network
egress** on Apple Silicon, verifiable under `--offline`.

Two responsibilities:

1. **Environment gating** — `apply_offline()` sets ``HF_HUB_OFFLINE=1`` and
   ``TRANSFORMERS_OFFLINE=1`` for the process so every HuggingFace-backed
   loader (mflux ``from_pretrained`` for Z-Image / Flux2 / Lens;
   ``ltx_downloader``'s ``hf_hub_download``) resolves exclusively from the
   local cache and **fails loud** (``LocalEntryNotFoundError``) instead of
   silently fetching. Subprocess children inherit these env vars automatically.

2. **Weight-presence preflight** — `preflight(command, pipeline=None)` checks
   that the model directories + required weight files for a given generation
   path actually exist on disk BEFORE dispatch. Under ``--offline`` a missing
   weight aborts with a clear, actionable message; online it only warns (the
   fetch path may still succeed).

Pipeline → required-components mapping is derived from ``app.config`` so the
preflight tracks the real layout (single source of truth) rather than a
hand-maintained duplicate. The component registry is intentionally a
*directory + required-file* check — it does not re-derive model internals,
which keeps it robust against model swaps.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

from app import config as cfg


# ---------------------------------------------------------------------------
# Offline environment gating
# ---------------------------------------------------------------------------

def apply_offline() -> None:
    """Force HuggingFace-backed loaders to cache-only mode for this process.

    Sets the two env vars ``huggingface_hub`` / ``transformers`` read at
    download-call time (not import time), so calling this in ``run.py main()``
    before dispatch is early enough: every weight load happens inside an
    ``execute()`` that runs after ``main()`` parses argv. Subprocess children
    (t2i2v → caption / video generate via ``build_run_py_cmd``) inherit the
    environment, so one flip propagates to the whole process tree.
    """
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    # Also set the module flag so command code can branch without re-reading env.
    cfg.OFFLINE = True


# ---------------------------------------------------------------------------
# Pipeline → component registry (directory + required files)
# ---------------------------------------------------------------------------

def _files(d: str, names: list[str]) -> list[tuple[str, str]]:
    """Build (dir, [required filenames]) component entries."""
    return [(d, names)]


def _image_components(pipeline: str) -> list[tuple[str, list[str]]]:
    """Required model dirs for each image pipeline.

    Filenames are the load entry points the pipelines actually open; missing
    *additional* shard files are caught by the loader's own consistency check,
    but the entry point must exist or the pipeline never starts.
    """
    if pipeline == "zimage":
        return [
            (cfg.TRANSFORMER_DIR, _any_safetensors),
            (cfg.TEXT_ENCODER_DIR, _any_safetensors),
            (cfg.TOKENIZER_DIR, ["tokenizer.json", "tokenizer_config.json"]),
            (cfg.ZIMAGE_AE_VAE_DIR, _any_safetensors),
        ]
    if pipeline == "flux2-klein":
        return [
            (cfg.KLEIN_9B_TRANSFORMER_DIR, _any_safetensors),
            (cfg.KLEIN_9B_TEXT_ENCODER_DIR, _any_safetensors),
            (cfg.KLEIN_9B_TOKENIZER_DIR, ["tokenizer.json", "tokenizer_config.json"]),
            (cfg.KLEIN_9B_VAE_DIR, _any_safetensors),
        ]
    if pipeline == "lens":
        return [
            (cfg.TRANSFORMER_DIR, _any_safetensors),
            (cfg.TEXT_ENCODER_DIR, _any_safetensors),
            (cfg.TOKENIZER_DIR, ["tokenizer.json", "tokenizer_config.json"]),
            (cfg.VAE_DIR, _any_safetensors),
        ]
    return []


# Sentinel: "any *.safetensors file is acceptable" (sharded models, custom names).
_ANY = "__any_safetensors__"
_any_safetensors = [_ANY]


def _dir_has_weight(d: str) -> bool:
    """True if directory exists and contains at least one *.safetensors file."""
    if not os.path.isdir(d):
        return False
    try:
        return any(f.endswith(".safetensors") for f in os.listdir(d))
    except OSError:
        return False


def _component_ok(directory: str, required: list[str]) -> bool:
    """Check a component directory against its required-file list.

    A required entry of ``_ANY`` passes if the dir holds any ``*.safetensors``;
    a concrete name passes if that exact file exists.
    """
    if not os.path.isdir(directory):
        return False
    for name in required:
        if name == _ANY:
            if not _dir_has_weight(directory):
                return False
        elif not os.path.exists(os.path.join(directory, name)):
            return False
    return True


def _missing_for_component(directory: str, required: list[str]) -> list[str]:
    """Human-readable list of what's missing for a component (for error msgs)."""
    missing: list[str] = []
    if not os.path.isdir(directory):
        return [f"directory missing: {directory}"]
    for name in required:
        if name == _ANY:
            if not _dir_has_weight(directory):
                missing.append(f"no *.safetensors in {directory}")
        elif not os.path.exists(os.path.join(directory, name)):
            missing.append(f"{name} not in {os.path.basename(directory)}/")
    return missing


def _video_components() -> list[tuple[str, list[str]]]:
    """Required model dirs for the native LTX-2.3 video path.

    The LTX pipeline loads from the flat symlink forest ``LTX_MLX_DIR/dev``
    (or distilled/dasiwa) plus the decomposed text-encoder + VAE dirs.
    """
    comps: list[tuple[str, list[str]]] = [
        (cfg.LTX_MLX_DEV_DIR, _any_safetensors),
        (cfg.LTX_TEXT_ENCODER_DIR, _any_safetensors),
        (cfg.LTX_VAE_DIR, _any_safetensors),
    ]
    return comps


# ---------------------------------------------------------------------------
# Preflight entry point
# ---------------------------------------------------------------------------

class OfflinePreflightError(RuntimeError):
    """Raised when --offline preflight finds a missing required weight."""


def preflight(command: str, pipeline: Optional[str] = None, *,
              offline: Optional[bool] = None) -> list[str]:
    """Verify required weights for a generation command resolve locally.

    Returns a list of human-readable problem strings (empty = all present).
    Under ``--offline`` (or when ``cfg.OFFLINE`` is already True), the FIRST
    missing required weight is raised as :class:`OfflinePreflightError` so the
    CLI boundary prints one clean error and exits — never a silent network
    fetch. Online, problems are only returned (caller may warn).

    Args:
        command: the run.py subcommand name (``image``, ``video``, ``video-t2i2v``…).
        pipeline: for ``image``, the ``--pipeline`` value (zimage/flux2-klein/lens).
        offline: override the offline decision (else derived from ``cfg.OFFLINE``).
    """
    if offline is None:
        offline = bool(getattr(cfg, "OFFLINE", False))

    components: list[tuple[str, list[str]]] = []
    if command == "image":
        components = _image_components(pipeline or "zimage")
    elif command in ("video", "video-generate"):
        components = _video_components()
    elif command in ("video-t2i2v", "t2i2v"):
        # t2i2v = image T2I + video I2V → need both image + video components.
        components = _image_components("zimage") + _video_components()
    else:
        # Commands that don't load generation weights (check-model, schema,
        # import-*, caption-VLM) skip the preflight — no offline weight gate.
        return []

    problems: list[str] = []
    for directory, required in components:
        if _component_ok(directory, required):
            continue
        miss = _missing_for_component(directory, required)
        label = os.path.relpath(directory, cfg.MODELS_DIR) if directory.startswith(cfg.MODELS_DIR) else directory
        for m in miss:
            problems.append(f"{label}: {m}")

    if problems and offline:
        # Fail loud: one actionable message, then raise for the CLI boundary.
        detail = "; ".join(problems)
        raise OfflinePreflightError(
            f"--offline preflight: required weight(s) not found locally ({detail}). "
            f"Fetch them first ONLINE (e.g. `python app/ltx_downloader.py`, "
            f"`run.py import-checkpoint`), then re-run with --offline."
        )
    return problems


# ---------------------------------------------------------------------------
# Granular LTX component check (reused by `check-model --preflight`)
# ---------------------------------------------------------------------------

def check_ltx_components() -> tuple[list[str], list[str]]:
    """Verify every REQUIRED LTX-2.3 component file is present locally.

    Reuses ``ltx_downloader.COMPONENT_FILES`` (single source of truth for the
    file manifest) and excludes ``OPTIONAL_FILES``. Returns ``(missing,
    present_names)`` where each missing entry is ``"<component>/<filename>"``.
    Used by ``check-model --preflight`` so the weight preflight is ONE command.
    """
    from app.ltx_downloader import COMPONENT_FILES, OPTIONAL_FILES

    missing: list[str] = []
    present: list[str] = []
    for component, (dest_dir, filenames) in COMPONENT_FILES.items():
        for fname in filenames:
            if fname in OPTIONAL_FILES:
                continue
            if os.path.exists(os.path.join(dest_dir, fname)):
                present.append(f"{component}/{fname}")
            else:
                missing.append(f"{component}/{fname}")
    return missing, present
