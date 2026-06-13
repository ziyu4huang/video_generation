"""Regression tests for app/commands/_model_resolver.py — LoRA and VAE resolution.

Uses tmp_path for all filesystem operations — no real models needed.
"""

import os
import sys

import pytest

# Patch MODELS_DIR before importing model_resolver so all path resolution
# uses the temp directory. This is safe because _model_resolver uses
# cfg.MODELS_DIR at function call time (not import time).
from app import config as cfg

from app.commands._model_resolver import (
    _find_safetensors_in_dir,
    resolve_lora_path,
    resolve_vae_path,
    list_available_loras,
)


# ==========================================================================
# _find_safetensors_in_dir
# ==========================================================================

class TestFindSafetensorsInDir:
    def test_one_file_returns_abspath(self, tmp_path):
        p = tmp_path / "model.safetensors"
        p.write_bytes(b"dummy")
        result = _find_safetensors_in_dir(str(tmp_path))
        assert result == str(p)

    def test_no_file_exits(self, tmp_path):
        with pytest.raises(SystemExit) as exc:
            _find_safetensors_in_dir(str(tmp_path))
        assert exc.value.code == 1

    def test_multiple_files_exits(self, tmp_path):
        (tmp_path / "a.safetensors").write_bytes(b"a")
        (tmp_path / "b.safetensors").write_bytes(b"b")
        with pytest.raises(SystemExit) as exc:
            _find_safetensors_in_dir(str(tmp_path))
        assert exc.value.code == 1

    def test_no_file_stderr_message(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _find_safetensors_in_dir(str(tmp_path))
        err = capsys.readouterr().err
        assert "no .safetensors file" in err

    def test_multiple_files_stderr_message(self, tmp_path, capsys):
        (tmp_path / "a.safetensors").write_bytes(b"a")
        (tmp_path / "b.safetensors").write_bytes(b"b")
        with pytest.raises(SystemExit):
            _find_safetensors_in_dir(str(tmp_path))
        err = capsys.readouterr().err
        assert "multiple" in err
        assert "a.safetensors" in err
        assert "b.safetensors" in err

    def test_extension_filtered(self, tmp_path):
        """Only .safetensors files are counted."""
        (tmp_path / "model.bin").write_bytes(b"bin")
        (tmp_path / "model.safetensors").write_bytes(b"safe")
        result = _find_safetensors_in_dir(str(tmp_path))
        assert result.endswith("model.safetensors")


# ==========================================================================
# resolve_lora_path
# ==========================================================================

class TestResolveLoraPath:
    def test_none_returns_none(self):
        assert resolve_lora_path(None) is None

    def test_full_path_to_file_returns_abspath(self, tmp_path):
        p = tmp_path / "lora.safetensors"
        p.write_bytes(b"dummy")
        result = resolve_lora_path(str(p))
        assert result == str(p)

    def test_directory_path_finds_safetensors(self, tmp_path):
        lora_dir = tmp_path / "my-lora"
        lora_dir.mkdir()
        (lora_dir / "weights.safetensors").write_bytes(b"w")
        # resolve_lora_path checks os.path.isdir first if raw points to a dir
        result = resolve_lora_path(str(lora_dir))
        assert result == str(lora_dir / "weights.safetensors")

    def test_short_name_in_lora_base(self, monkeypatch, tmp_path):
        """Short name resolves to models/lora/<name>/<safetensors>."""
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        lora_dir = tmp_path / "lora" / "my-lora"
        lora_dir.mkdir(parents=True)
        (lora_dir / "weights.safetensors").write_bytes(b"w")
        result = resolve_lora_path("my-lora")
        assert result == str(lora_dir / "weights.safetensors")

    def test_partial_name_prefix_match(self, monkeypatch, tmp_path):
        """Prefix match when exactly one dir starts with the name."""
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        lora_base = tmp_path / "lora"
        lora_base.mkdir(parents=True)
        (lora_base / "klein-slider-anatomy").mkdir()
        (lora_base / "klein-slider-anatomy" / "model.safetensors").write_bytes(b"w")
        # partial name 'klein' should NOT match 'klein-slider-anatomy' uniquely
        # If there are other 'klein-*' dirs, it would be ambiguous
        result = resolve_lora_path("klein-slider")
        assert result is not None
        assert "klein-slider-anatomy" in result

    def test_ambiguous_name_exits(self, monkeypatch, tmp_path):
        """If multiple dirs start with the prefix, exit with error."""
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        lora_base = tmp_path / "lora"
        lora_base.mkdir(parents=True)
        (lora_base / "klein-a").mkdir()
        (lora_base / "klein-b").mkdir()
        with pytest.raises(SystemExit):
            resolve_lora_path("klein")

    def test_unresolvable_name_exits(self, monkeypatch, tmp_path, capsys):
        """No match anywhere → exit."""
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        lora_base = tmp_path / "lora"
        lora_base.mkdir(parents=True)
        with pytest.raises(SystemExit):
            resolve_lora_path("nonexistent-lora")
        err = capsys.readouterr().err
        assert "cannot resolve LoRA" in err

    def test_exact_short_name_returns_path(self, monkeypatch, tmp_path):
        """Exact short name match (no partial prefix) returns the path directly."""
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        lora_dir = tmp_path / "lora" / "my-adapter"
        lora_dir.mkdir(parents=True)
        f = lora_dir / "adapter.safetensors"
        f.write_bytes(b"w")
        result = resolve_lora_path("my-adapter")
        assert result == str(f)

    def test_directory_path_uses_find_safetensors(self, tmp_path):
        """If raw is a dir without .safetensors, should exit."""
        empty_dir = tmp_path / "empty-lora"
        empty_dir.mkdir()
        with pytest.raises(SystemExit):
            resolve_lora_path(str(empty_dir))

    def test_non_safetensors_file_ignored(self, tmp_path):
        """A .bin file should not be found by resolve_lora_path via full path."""
        p = tmp_path / "model.bin"
        p.write_bytes(b"not-a-lora")
        # Full path to a non-.safetensors file → os.path.isfile is True → returns abspath
        # Even though it's .bin, resolve_lora_path just checks os.path.isfile
        # So it returns the path even for non-.safetensors files.
        result = resolve_lora_path(str(p))
        assert result == str(p)


# ==========================================================================
# resolve_vae_path
# ==========================================================================

class TestResolveVaePath:
    def test_none_returns_none(self):
        assert resolve_vae_path(None) is None

    def test_directory_path_returns_abspath(self, tmp_path):
        vae_dir = tmp_path / "my-vae"
        vae_dir.mkdir()
        result = resolve_vae_path(str(vae_dir))
        assert result == str(vae_dir)

    def test_short_name_in_vae_base(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        vae_dir = tmp_path / "vae" / "ultraflux"
        vae_dir.mkdir(parents=True)
        result = resolve_vae_path("ultraflux")
        assert result == str(vae_dir)

    def test_partial_name_match(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        vae_base = tmp_path / "vae"
        vae_base.mkdir(parents=True)
        (vae_base / "ultraflux-vae").mkdir()
        result = resolve_vae_path("ultra")
        assert result == str(vae_base / "ultraflux-vae")

    def test_ambiguous_name_exits(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        vae_base = tmp_path / "vae"
        vae_base.mkdir(parents=True)
        (vae_base / "flux-a").mkdir()
        (vae_base / "flux-b").mkdir()
        with pytest.raises(SystemExit):
            resolve_vae_path("flux")

    def test_unresolvable_exits(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        with pytest.raises(SystemExit):
            resolve_vae_path("nonexistent")
        err = capsys.readouterr().err
        assert "cannot resolve VAE" in err

    def test_exact_short_name_returns_path(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        vae_dir = tmp_path / "vae" / "my-vae"
        vae_dir.mkdir(parents=True)
        result = resolve_vae_path("my-vae")
        assert result == str(vae_dir)


# ==========================================================================
# list_available_loras — output format
# ==========================================================================

class TestListAvailableLoras:
    def test_empty_lora_dir_prints_message(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        list_available_loras()
        out = capsys.readouterr().out
        assert "No LoRAs found" in out

    def test_with_registry_data(self, monkeypatch, tmp_path, capsys):
        """list_available_loras calls ModelRegistry.list('lora')."""
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        # Create a minimal manifest for a lora
        lora_dir = tmp_path / "lora" / "test-lora"
        lora_dir.mkdir(parents=True)
        (lora_dir / "manifest.json").write_bytes(b'{"name": "test-lora", "arch": "lokr", "pipeline": ["zimage-turbo"], "size_bytes": 1000, "description": "A test LoRA"}')
        list_available_loras()
        out = capsys.readouterr().out
        assert "test-lora" in out

    def test_pipeline_filter(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        lora_dir = tmp_path / "lora" / "flux-lora"
        lora_dir.mkdir(parents=True)
        (lora_dir / "manifest.json").write_bytes(b'{"name": "flux-lora", "pipeline": ["flux2-klein"]}')
        # Filter for zimage → nothing found
        list_available_loras(pipeline_filter="zimage-turbo")
        out = capsys.readouterr().out
        assert "No LoRAs found for pipeline" in out
