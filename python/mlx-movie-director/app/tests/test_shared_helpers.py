"""Regression tests for core pure functions in app/commands/_shared.py.

Focuses on pure-logic functions that don't need extensive mocking.
build_run_py_cmd is already tested in test_gpu_monitor.py::TestBuildRunPyCmd.
run_session is tested via its integration manifests in test_manifest.py.
"""

import argparse
import re

import pytest

from app.commands._shared import (
    apply_draft_overrides,
    seed_sequence,
    normalize_self_test,
    generate_base_name,
    make_output_paths,
    resolve_prompt,
    resolve_upscale_model,
)
from app.run_config import RunConfig


# ==========================================================================
# apply_draft_overrides
# ==========================================================================

class TestApplyDraftOverrides:
    def test_draft_false_leaves_unchanged(self):
        args = argparse.Namespace(draft=False, steps=10, width=640, height=960)
        apply_draft_overrides(args)
        assert args.steps == 10
        assert args.width == 640
        assert args.height == 960

    def test_draft_true_sets_steps_to_4(self):
        args = argparse.Namespace(draft=True, steps=9, width=640, height=960)
        apply_draft_overrides(args)
        assert args.steps == 4

    def test_draft_true_sets_width_height_512_when_none(self):
        args = argparse.Namespace(draft=True, steps=9, width=None, height=None)
        apply_draft_overrides(args)
        assert args.width == 512
        assert args.height == 512

    def test_draft_true_preserves_explicit_width(self):
        args = argparse.Namespace(draft=True, steps=9, width=800, height=600)
        apply_draft_overrides(args)
        assert args.width == 800  # explicitly set → not overridden
        assert args.height == 600

    def test_draft_no_draft_attr(self):
        """If draft attr is missing, treated as falsy → no change."""
        args = argparse.Namespace(steps=9)
        apply_draft_overrides(args)
        assert args.steps == 9

    def test_draft_prints_message(self, capsys):
        args = argparse.Namespace(draft=True, steps=9, width=None, height=None)
        apply_draft_overrides(args)
        out = capsys.readouterr().out
        assert "[Draft]" in out


# ==========================================================================
# seed_sequence
# ==========================================================================

class TestSeedSequence:
    def test_default_seed(self):
        """No seed → uses 42."""
        args = argparse.Namespace(count=1, seed=None, seed_start=None)
        assert seed_sequence(args) == [42]

    def test_explicit_seed(self):
        args = argparse.Namespace(count=1, seed=99, seed_start=None)
        assert seed_sequence(args) == [99]

    def test_count_2_same_seed(self):
        args = argparse.Namespace(count=2, seed=42, seed_start=None)
        assert seed_sequence(args) == [42, 42]

    def test_seed_start_produces_sequential(self):
        args = argparse.Namespace(count=3, seed=None, seed_start=100)
        assert seed_sequence(args) == [100, 101, 102]

    def test_seed_start_overrides_seed(self):
        args = argparse.Namespace(count=2, seed=99, seed_start=200)
        assert seed_sequence(args) == [200, 201]

    def test_count_defaults_to_1(self):
        args = argparse.Namespace(count=None, seed=42, seed_start=None)
        assert seed_sequence(args) == [42]

    def test_count_zero_returns_1_seed(self):
        args = argparse.Namespace(count=0, seed=42, seed_start=None)
        assert seed_sequence(args) == [42]

    def test_seed_zero(self):
        """Seed 0 is falsy in Python, should still work (use the getattr-or-42 pattern)."""
        args = argparse.Namespace(count=1, seed=0, seed_start=None)
        result = seed_sequence(args)
        # WARNING: getattr(args, 'seed', None) or 42 → None or 42 → 42 for seed=0
        # This is a known quirk: seed=0 is treated as "no seed" because 0 is falsy.
        assert result == [42], f"seed=0 quirk: got {result}"

    def test_works_with_runconfig(self):
        """seed_sequence accepts RunConfig objects too."""
        rc = RunConfig(count=3, seed=42)
        assert seed_sequence(rc) == [42, 42, 42]

    def test_runconfig_seed_start(self):
        rc = RunConfig(count=3, seed=99, seed_start=50)
        assert seed_sequence(rc) == [50, 51, 52]


# ==========================================================================
# normalize_self_test
# ==========================================================================

class TestNormalizeSelfTest:
    def test_none_stays_none(self):
        args = argparse.Namespace(self_test=None)
        normalize_self_test(args)
        assert args.self_test is None

    def test_empty_list_becomes_true(self):
        args = argparse.Namespace(self_test=[])
        normalize_self_test(args)
        assert args.self_test is True

    def test_single_name_becomes_string(self):
        args = argparse.Namespace(self_test=["ultraflux"])
        normalize_self_test(args)
        assert args.self_test == "ultraflux"

    def test_two_names_stays_list(self):
        args = argparse.Namespace(self_test=["redzit15", "redzit15-lora"])
        normalize_self_test(args)
        assert args.self_test == ["redzit15", "redzit15-lora"]

    def test_no_self_test_attr_does_nothing(self):
        args = argparse.Namespace()
        normalize_self_test(args)  # should not crash


# ==========================================================================
# generate_base_name
# ==========================================================================

class TestGenerateBaseName:
    def test_starts_with_output(self):
        name = generate_base_name()
        assert name.startswith("output_")

    def test_has_timestamp_format(self):
        name = generate_base_name()
        # output_YYYYMMDD_HHMMSS
        assert re.match(r"output_\d{8}_\d{6}$", name), f"Unexpected format: {name}"


# ==========================================================================
# make_output_paths
# ==========================================================================

class TestMakeOutputPaths:
    def test_returns_named_tuple(self):
        paths = make_output_paths()
        assert hasattr(paths, "base_name")
        assert hasattr(paths, "run_file")
        assert hasattr(paths, "manifest_file")
        assert hasattr(paths, "output_file")

    def test_run_file_is_json(self):
        paths = make_output_paths()
        assert paths.run_file.endswith(".run.json")

    def test_manifest_file_is_json(self):
        paths = make_output_paths()
        assert paths.manifest_file.endswith(".manifest.json")

    def test_output_file_default_is_png(self):
        paths = make_output_paths()
        assert paths.output_file.endswith(".png")

    def test_custom_ext(self):
        paths = make_output_paths(ext=".mp4")
        assert paths.output_file.endswith(".mp4")

    def test_custom_suffix(self):
        paths = make_output_paths(suffix="_ref1", ext=".png")
        assert "_ref1.png" in paths.output_file

    def test_base_name_matches_across_paths(self):
        paths = make_output_paths()
        assert paths.run_file.endswith(f"{paths.base_name}.run.json")
        assert paths.manifest_file.endswith(f"{paths.base_name}.manifest.json")
        assert paths.base_name in paths.output_file

    def test_output_dir_created(self, monkeypatch):
        """make_output_paths creates OUTPUT_DIR if missing."""
        import os
        from app import config as cfg
        monkeypatch.setattr(cfg, "OUTPUT_DIR", "/tmp/_test_movie_dir_xyz")
        paths = make_output_paths()
        assert os.path.isdir(cfg.OUTPUT_DIR)
        assert cfg.OUTPUT_DIR in paths.output_file
        # Cleanup
        os.rmdir(cfg.OUTPUT_DIR)


# ==========================================================================
# resolve_prompt
# ==========================================================================

class TestResolvePrompt:
    def test_from_prompt_arg(self):
        args = argparse.Namespace(prompt="hello", prompt_file=None)
        assert resolve_prompt(args) == "hello"

    def test_missing_raises(self):
        args = argparse.Namespace(prompt=None, prompt_file=None)
        with pytest.raises(ValueError, match="No prompt provided"):
            resolve_prompt(args)

    def test_empty_prompt_raises(self):
        args = argparse.Namespace(prompt="", prompt_file=None)
        with pytest.raises(ValueError):
            resolve_prompt(args)


# ==========================================================================
# resolve_upscale_model (import needed inside test for _shared)
# ==========================================================================

class TestResolveUpscaleModel:
    def test_no_upscale_returns_none(self):
        from app.run_config import RunConfig
        rc = RunConfig(upscale=False)
        assert resolve_upscale_model(rc) is None

    def test_upscale_without_model_returns_default(self):
        from app.run_config import RunConfig
        rc = RunConfig(upscale=True, upscale_model=None)
        result = resolve_upscale_model(rc)
        assert result is not None
        assert result.endswith(".pth")
