"""Lightweight I/O helpers shared across command modules.

No dependencies on other app.* modules — safe to import anywhere.
"""

import os

from PIL import Image


def load_image_rgb(path: str) -> Image.Image:
    """Load an image and ensure RGB mode (strips alpha channel if present)."""
    img = Image.open(path)
    return img.convert("RGB") if img.mode != "RGB" else img


def require_file(path: str | None, label: str = "input") -> str:
    """Validate that a file path is provided and exists on disk.

    Raises ValueError (no path) / FileNotFoundError (missing) on failure —
    NOT sys.exit, so programmatic callers (tests, the GUI job runner) can
    catch the failure instead of having the whole process killed. The CLI
    boundary in run.py._run_with_gpu_guard converts these to a clean one-line
    error + exit. Returns the path unchanged on success (for chaining).
    """
    if not path:
        raise ValueError(f"{label} path is required")
    if not os.path.exists(path):
        raise FileNotFoundError(f"{label} not found: {path}")
    return path


def ensure_dir(path: str) -> None:
    """Create directory (and any missing parents) if it does not exist."""
    os.makedirs(path, exist_ok=True)
