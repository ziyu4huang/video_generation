"""model_registry — discover and enumerate model instances from manifest.json files.

Directory convention:
  models/{type}/{name}/manifest.json

Each manifest.json describes one model instance.  The registry scans subdirectories
under each type and reads their manifests, allowing multiple instances per type
(e.g. transformer/zimage-moody-v126/ and transformer/flux2-klein-9b/).
"""

import json
import os
from typing import Any


class ModelNotFoundError(FileNotFoundError):
    pass


class ModelRegistry:
    def __init__(self, models_dir: str):
        self.models_dir = models_dir

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list(self, model_type: str) -> list[dict[str, Any]]:
        """Return all manifests for a given type, sorted by name."""
        type_dir = os.path.join(self.models_dir, model_type)
        if not os.path.isdir(type_dir):
            return []
        results = []
        for entry in sorted(os.listdir(type_dir)):
            manifest_path = os.path.join(type_dir, entry, "manifest.json")
            if os.path.isfile(manifest_path):
                try:
                    with open(manifest_path) as f:
                        data = json.load(f)
                    data["_path"] = os.path.join(type_dir, entry)
                    results.append(data)
                except (json.JSONDecodeError, OSError):
                    pass
        return results

    def find(self, model_type: str, *, name: str | None = None, arch: str | None = None) -> str:
        """Return the directory path of the first model matching name or arch.

        Raises ModelNotFoundError if nothing matches.
        """
        for manifest in self.list(model_type):
            if name and manifest.get("name") == name:
                return manifest["_path"]
            if arch and manifest.get("arch") == arch:
                return manifest["_path"]
        criteria = f"name={name!r}" if name else f"arch={arch!r}"
        raise ModelNotFoundError(
            f"No {model_type!r} model found with {criteria} in {self.models_dir}"
        )

    def default(self, model_type: str, arch: str) -> str:
        """Return the first model path matching arch; raise if none found."""
        return self.find(model_type, arch=arch)

    def get_manifest(self, model_type: str, name: str) -> dict:
        """Return the manifest dict for a specific model by name."""
        for manifest in self.list(model_type):
            if manifest.get("name") == name:
                return manifest
        raise ModelNotFoundError(f"No manifest found: {model_type}/{name}")
