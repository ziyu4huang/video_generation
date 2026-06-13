"""Output path utilities — path construction, naming, base name generation.

Split from _shared.py (was ~903 lines, now ~50 lines).
"""

import os
from typing import NamedTuple

from app import config as cfg

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_UPSCALE_MODEL = os.path.join(
    cfg.REPO_DIR, "comfyui_data", "models", "upscale_models",
    "4xNomosWebPhoto_RealPLKSR.pth"
)

RELAY_FINAL_MODE = "relay-final"


# ---------------------------------------------------------------------------
# Output naming
# ---------------------------------------------------------------------------

import time


def generate_base_name() -> str:
    return f"output_{time.strftime('%Y%m%d_%H%M%S')}"


# ---------------------------------------------------------------------------
# Output path helpers
# ---------------------------------------------------------------------------

class OutputPaths(NamedTuple):
    base_name: str       # "output_20260613_143022"
    run_file: str        # ".../output_XXXX.run.json"
    manifest_file: str   # ".../output_XXXX.manifest.json"
    output_file: str     # ".../output_XXXX<suffix><ext>"


def make_output_paths(suffix: str = "", ext: str = ".png") -> OutputPaths:
    """Build a consistent set of output paths from a single timestamp base name."""
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()
    d = cfg.OUTPUT_DIR
    return OutputPaths(
        base_name=base,
        run_file=os.path.join(d, f"{base}.run.json"),
        manifest_file=os.path.join(d, f"{base}.manifest.json"),
        output_file=os.path.join(d, f"{base}{suffix}{ext}"),
    )
