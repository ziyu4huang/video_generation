"""Lightweight I/O helpers shared across command modules.

No dependencies on other app.* modules — safe to import anywhere.
"""

import os
import sys

from PIL import Image


def load_image_rgb(path: str) -> Image.Image:
    """Load an image and ensure RGB mode (strips alpha channel if present)."""
    img = Image.open(path)
    return img.convert("RGB") if img.mode != "RGB" else img


def require_file(path: str | None, label: str = "input") -> str:
    """Validate that a file path is provided and exists on disk.

    Prints a human-readable error and sys.exit(1) on failure.
    Returns the path unchanged on success (for chaining).
    """
    if not path:
        print(f"ERROR: {label} path is required", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(path):
        print(f"ERROR: {label} not found: {path}", file=sys.stderr)
        sys.exit(1)
    return path


def ensure_dir(path: str) -> None:
    """Create directory (and any missing parents) if it does not exist."""
    os.makedirs(path, exist_ok=True)
