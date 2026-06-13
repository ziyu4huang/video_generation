"""Regression tests for app/commands/_output.py — output path utilities.

This module was split out of _shared.py; the logic here is CPU-pure (path
construction + timestamp + dir creation) and never touches MLX/GPU/weights.
Importing app.commands._output only pulls in `os`, `time`, `typing`, and
app.config — no heavy pipelines.

The sibling test_shared_helpers.py covers the _duplicate_ copies still living
in _shared.py; these tests target the _output.py module specifically (which
otherwise stays at 0% coverage).
"""

import os
import re

import pytest

from app import config as cfg
from app.commands._output import (
    DEFAULT_UPSCALE_MODEL,
    RELAY_FINAL_MODE,
    OutputPaths,
    generate_base_name,
    make_output_paths,
)


# ==========================================================================
# Constants
# ==========================================================================

class TestConstants:
    def test_relay_final_mode_value(self):
        assert RELAY_FINAL_MODE == "relay-final"

    def test_default_upscale_model_under_repo_dir(self):
        """DEFAULT_UPSCALE_MODEL lives under REPO_DIR/comfyui_data/models."""
        assert DEFAULT_UPSCALE_MODEL.startswith(cfg.REPO_DIR)

    def test_default_upscale_model_in_upscale_models_subdir(self):
        assert "upscale_models" in DEFAULT_UPSCALE_MODEL.split(os.sep)

    def test_default_upscale_model_basename(self):
        assert os.path.basename(DEFAULT_UPSCALE_MODEL) == "4xNomosWebPhoto_RealPLKSR.pth"

    def test_default_upscale_model_is_absolute(self):
        assert os.path.isabs(DEFAULT_UPSCALE_MODEL)


# ==========================================================================
# generate_base_name
# ==========================================================================

class TestGenerateBaseName:
    def test_prefix(self):
        assert generate_base_name().startswith("output_")

    def test_format(self):
        # output_YYYYMMDD_HHMMSS
        name = generate_base_name()
        assert re.match(r"^output_\d{8}_\d{6}$", name), name

    def test_distinct_calls(self):
        """Two calls rarely collide; assert string value (timestamp may tie)."""
        a, b = generate_base_name(), generate_base_name()
        assert isinstance(a, str) and isinstance(b, str)
        assert a.startswith("output_") and b.startswith("output_")


# ==========================================================================
# OutputPaths NamedTuple
# ==========================================================================

class TestOutputPathsShape:
    def test_fields(self):
        assert OutputPaths._fields == ("base_name", "run_file", "manifest_file", "output_file")

    def test_is_namedtuple(self):
        paths = make_output_paths()
        assert isinstance(paths, OutputPaths)
        assert isinstance(paths, tuple)

    def test_field_access(self):
        paths = make_output_paths()
        for f in OutputPaths._fields:
            assert isinstance(getattr(paths, f), str)


# ==========================================================================
# make_output_paths — path construction
# ==========================================================================

class TestMakeOutputPaths:
    def test_default_ext_png(self):
        assert make_output_paths().output_file.endswith(".png")

    def test_custom_ext(self):
        assert make_output_paths(ext=".mp4").output_file.endswith(".mp4")

    def test_custom_suffix(self):
        paths = make_output_paths(suffix="_ref1", ext=".png")
        assert paths.output_file.endswith("_ref1.png")

    def test_empty_suffix(self):
        paths = make_output_paths(suffix="", ext=".png")
        assert paths.output_file.endswith(f"{paths.base_name}.png")

    def test_all_paths_share_base_name(self):
        paths = make_output_paths()
        b = paths.base_name
        assert paths.run_file == os.path.join(cfg.OUTPUT_DIR, f"{b}.run.json")
        assert paths.manifest_file == os.path.join(cfg.OUTPUT_DIR, f"{b}.manifest.json")
        assert paths.output_file == os.path.join(cfg.OUTPUT_DIR, f"{b}.png")

    def test_all_under_output_dir(self):
        paths = make_output_paths()
        for f in (paths.run_file, paths.manifest_file, paths.output_file):
            assert f.startswith(cfg.OUTPUT_DIR)

    def test_suffix_and_ext_combined(self):
        paths = make_output_paths(suffix="_v2", ext=".webm")
        assert paths.output_file.endswith("_v2.webm")
        assert paths.output_file.startswith(cfg.OUTPUT_DIR)


# ==========================================================================
# make_output_paths — directory creation side effect
# ==========================================================================

class TestMakeOutputPathsDirCreation:
    def test_creates_output_dir(self, monkeypatch, tmp_path):
        target = tmp_path / "fresh_output"
        monkeypatch.setattr(cfg, "OUTPUT_DIR", str(target))
        assert not target.exists()
        paths = make_output_paths()
        assert target.is_dir()
        assert paths.output_file.startswith(str(target))

    def test_idempotent_existing_dir(self, monkeypatch, tmp_path):
        target = tmp_path / "exists_output"
        target.mkdir()
        monkeypatch.setattr(cfg, "OUTPUT_DIR", str(target))
        # Should not raise when dir already exists.
        paths = make_output_paths()
        assert target.is_dir()
        assert os.path.dirname(paths.run_file) == str(target)
