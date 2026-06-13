"""Regression tests for app/config.py — check_model_available and path constants.

Path constants are verified for structural validity (absolute paths, expected
directory structure) but NOT for existence on disk — models are ~90GB and
may not be downloaded in every environment.
"""

import json
import os

import pytest

from app import config as cfg


# ==========================================================================
# check_model_available
# ==========================================================================

class TestCheckModelAvailable:
    def test_valid_directory_returns_true(self, tmp_path):
        d = tmp_path / "models" / "transformer"
        d.mkdir(parents=True)
        assert cfg.check_model_available(str(d)) is True

    def test_missing_directory_returns_false(self, tmp_path):
        d = tmp_path / "nonexistent"
        assert cfg.check_model_available(str(d)) is False

    def test_removed_marker_returns_false(self, tmp_path):
        d = tmp_path / "removed_model"
        d.mkdir(parents=True)
        marker = d / "REMOVED"
        marker.write_text(json.dumps({"reason": "disk space", "reconvert_command": "convert.py --all"}))
        assert cfg.check_model_available(str(d)) is False

    def test_removed_marker_reason_in_output(self, tmp_path, capsys):
        d = tmp_path / "removed_model"
        d.mkdir(parents=True)
        marker = d / "REMOVED"
        marker.write_text(json.dumps({"reason": "disk space", "reconvert_command": "convert.py --all"}))
        cfg.check_model_available(str(d))
        out = capsys.readouterr().out
        assert "disk space" in out
        assert "convert.py" in out

    def test_removed_marker_invalid_json(self, tmp_path):
        """Invalid JSON in REMOVED file doesn't crash — returns False."""
        d = tmp_path / "removed_model"
        d.mkdir(parents=True)
        marker = d / "REMOVED"
        marker.write_text("{ not valid json")
        assert cfg.check_model_available(str(d)) is False

    def test_removed_marker_empty_json(self, tmp_path, capsys):
        d = tmp_path / "removed_model"
        d.mkdir(parents=True)
        marker = d / "REMOVED"
        marker.write_text("{}")
        assert cfg.check_model_available(str(d)) is False
        out = capsys.readouterr().out
        assert "unknown" in out

    def test_removed_marker_without_reason(self, tmp_path, capsys):
        d = tmp_path / "removed_model"
        d.mkdir(parents=True)
        marker = d / "REMOVED"
        marker.write_text(json.dumps({"reconvert_command": "convert.py"}))
        assert cfg.check_model_available(str(d)) is False
        out = capsys.readouterr().out
        assert "unknown" in out


# ==========================================================================
# Path constants — structural validation
# ==========================================================================

class TestPathConstants:
    """Verify path constants are well-formed and internally consistent.

    These tests do NOT check file existence (models may not be downloaded).
    They check structural invariants that would break after a refactor.
    """

    def test_app_dir_is_absolute(self):
        assert os.path.isabs(cfg.APP_DIR)

    def test_project_dir_is_above_app(self):
        assert cfg.PROJECT_DIR == os.path.dirname(cfg.APP_DIR)

    def test_repo_dir_is_two_levels_above_project(self):
        """REPO_DIR = PROJECT_DIR/../../ (the monorepo root)."""
        assert cfg.REPO_DIR == os.path.dirname(os.path.dirname(cfg.PROJECT_DIR))

    def test_models_dir_is_under_project(self):
        assert cfg.MODELS_DIR.startswith(cfg.PROJECT_DIR)

    def test_output_dir_is_under_project(self):
        assert cfg.OUTPUT_DIR.startswith(cfg.PROJECT_DIR)

    def test_output_dir_is_named_output(self):
        assert cfg.OUTPUT_DIR.endswith("output")

    def test_all_model_type_dirs_under_models(self):
        """Each model-type directory name starts with models/<type>/."""
        model_dirs = [
            cfg.TRANSFORMER_DIR,
            cfg.TEXT_ENCODER_DIR,
            cfg.TOKENIZER_DIR,
            cfg.VAE_DIR,
            cfg.ULTRAFLUX_VAE_DIR,
            cfg.KLEIN_9B_TRANSFORMER_DIR,
            cfg.KLEIN_9B_TEXT_ENCODER_DIR,
            cfg.KLEIN_9B_VAE_DIR,
            cfg.KLEIN_9B_TOKENIZER_DIR,
            cfg.LTX_TRANSFORMER_DIR,
            cfg.LTX_TEXT_ENCODER_DIR,
            cfg.LTX_VAE_DIR,
            cfg.LTX_AUDIO_DIR,
            cfg.SEEDVR2_DIT_DIR,
            cfg.SEEDVR2_VAE_DIR,
            cfg.CONTROLNET_DIR,
        ]
        for d in model_dirs:
            assert d.startswith(cfg.MODELS_DIR), f"{d} not under MODELS_DIR"

    def test_comfy_models_is_absolute(self):
        assert os.path.isabs(cfg.COMFY_MODELS)

    def test_transformer_config_has_required_keys(self):
        # Config has nheads (alias n_heads) and infers out_channels = in_channels.
        required = {"dim", "nheads", "n_layers", "in_channels", "axes_dims", "cap_feat_dim"}
        assert required.issubset(cfg.TRANSFORMER_CONFIG.keys())

    def test_ltx_mlx_dirs_under_ltx_mlx(self):
        assert cfg.LTX_MLX_DEV_DIR.startswith(cfg.LTX_MLX_DIR)
        assert cfg.LTX_MLX_DISTILLED_DIR.startswith(cfg.LTX_MLX_DIR)
        assert cfg.LTX_MLX_DASIWA_DIR.startswith(cfg.LTX_MLX_DIR)

    def test_transformer_config_nheads_vs_dim(self):
        """nheads must divide dim evenly (head_dim = dim // nheads)."""
        dim = cfg.TRANSFORMER_CONFIG["dim"]
        nheads = cfg.TRANSFORMER_CONFIG["nheads"]
        assert dim % nheads == 0, f"dim={dim} not divisible by nheads={nheads}"

    def test_klein_configs_are_distinct(self):
        """Klein 9B paths point to different dirs than ZImage paths."""
        assert cfg.KLEIN_9B_TRANSFORMER_DIR != cfg.TRANSFORMER_DIR
        assert cfg.KLEIN_9B_TEXT_ENCODER_DIR != cfg.TEXT_ENCODER_DIR

    def test_lut_dir_under_models(self):
        assert cfg.LUT_DIR.startswith(cfg.MODELS_DIR)
