"""Regression tests for ModelRegistry manifest discovery."""

import json

import pytest

from app.model_registry import ModelRegistry, ModelNotFoundError


def _write_manifest(model_dir, payload: dict) -> None:
    """Write a manifest.json into a model instance dir (created if needed)."""
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "manifest.json").write_text(json.dumps(payload))


class TestList:
    def test_empty_dir_returns_empty(self, tmp_path):
        reg = ModelRegistry(str(tmp_path))
        assert reg.list("transformers") == []

    def test_reads_manifests_sorted_by_name(self, tmp_path):
        base = tmp_path / "transformers"
        _write_manifest(base / "beta", {"name": "beta", "arch": "klein"})
        _write_manifest(base / "alpha", {"name": "alpha", "arch": "klein"})
        reg = ModelRegistry(str(tmp_path))
        result = reg.list("transformers")
        assert [m["name"] for m in result] == ["alpha", "beta"]
        assert all("_path" in m for m in result)

    def test_skips_invalid_json(self, tmp_path):
        base = tmp_path / "transformers"
        _write_manifest(base / "good", {"name": "good", "arch": "klein"})
        (base / "bad").mkdir(parents=True)
        (base / "bad" / "manifest.json").write_text("{ not valid json")
        reg = ModelRegistry(str(tmp_path))
        assert [m["name"] for m in reg.list("transformers")] == ["good"]


class TestFind:
    def test_by_name(self, tmp_path):
        base = tmp_path / "transformers"
        _write_manifest(base / "alpha", {"name": "alpha", "arch": "klein"})
        reg = ModelRegistry(str(tmp_path))
        assert reg.find("transformers", name="alpha").endswith("transformers/alpha")

    def test_by_arch(self, tmp_path):
        base = tmp_path / "transformers"
        _write_manifest(base / "alpha", {"name": "alpha", "arch": "klein"})
        reg = ModelRegistry(str(tmp_path))
        assert reg.find("transformers", arch="klein").endswith("transformers/alpha")

    def test_missing_raises(self, tmp_path):
        reg = ModelRegistry(str(tmp_path))
        with pytest.raises(ModelNotFoundError):
            reg.find("transformers", name="nope")


class TestGetManifestAndDefault:
    def test_get_manifest_by_name(self, tmp_path):
        base = tmp_path / "transformers"
        _write_manifest(base / "alpha", {"name": "alpha", "arch": "klein"})
        reg = ModelRegistry(str(tmp_path))
        assert reg.get_manifest("transformers", "alpha")["name"] == "alpha"

    def test_get_manifest_missing_raises(self, tmp_path):
        reg = ModelRegistry(str(tmp_path))
        with pytest.raises(ModelNotFoundError):
            reg.get_manifest("transformers", "nope")

    def test_default_delegates_to_find_by_arch(self, tmp_path):
        base = tmp_path / "transformers"
        _write_manifest(base / "alpha", {"name": "alpha", "arch": "klein"})
        reg = ModelRegistry(str(tmp_path))
        assert reg.default("transformers", "klein").endswith("transformers/alpha")
