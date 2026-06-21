"""CPU-only tests for SeedVR2 manifest-driven quantization detection.

Covers `_detect_quant_from_manifest` (the loader's precision resolver) and the
`seedvr2_dit_format` / `seedvr2_quant_resolved` audit fields added so 8-bit vs
4-bit-gs32 purify runs are distinguishable in the manifest. No model load, no
GPU — the resolver only reads a `manifest.json` `format` field.
"""

import json
import os

import pytest

try:
    import mlx.core as mx  # noqa: F401  (module import pulls mlx; function is pure)
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.pipeline import SeedVR2Upscaler, _detect_quant_from_manifest


class TestDetectQuantFromManifest:
    """`_detect_quant_from_manifest` maps the manifest `format` -> (bits, gs)."""

    def _write_manifest(self, tmp_path, fmt):
        if fmt is not None:
            with open(os.path.join(tmp_path, "manifest.json"), "w") as f:
                json.dump({"format": fmt}, f)
        return str(tmp_path)

    def test_8bit(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-8bit")
        assert _detect_quant_from_manifest(d) == (8, 64)

    def test_4bit_gs32(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-4bit-gs32")
        assert _detect_quant_from_manifest(d) == (4, 32)

    def test_4bit_legacy(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-4bit")
        assert _detect_quant_from_manifest(d) == (4, 32)

    def test_fallback_missing_manifest(self, tmp_path):
        # No manifest.json at all -> original 4-bit SeedVR2 default
        assert _detect_quant_from_manifest(str(tmp_path)) == (4, 32)

    def test_fallback_unknown_format(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-16bit")
        assert _detect_quant_from_manifest(d) == (4, 32)

    def test_fallback_malformed_json(self, tmp_path):
        with open(os.path.join(tmp_path, "manifest.json"), "w") as f:
            f.write("{not valid json")
        assert _detect_quant_from_manifest(str(tmp_path)) == (4, 32)


class TestUpscalerQuantConfig:
    """`quant_config` is exposed for the audit manifest (None until load)."""

    def test_default_none(self):
        u = SeedVR2Upscaler(model_size="7b")
        assert u.quant_config is None
        # last_timings parity (coexisting PR #34 field)
        assert u.last_timings == {}


class TestFingerprintRecordsFormat:
    """`collect_model_fingerprint_seedvr2` records the declared `format`."""

    def test_format_recorded(self, tmp_path, monkeypatch):
        from app import config as cfg
        from app.manifest import collect_model_fingerprint_seedvr2

        dit_dir = tmp_path / "dit"
        vae_dir = tmp_path / "vae"
        dit_dir.mkdir()
        vae_dir.mkdir()
        with open(dit_dir / "manifest.json", "w") as f:
            json.dump({"format": "mlx-8bit"}, f)

        monkeypatch.setattr(cfg, "SEEDVR2_DIT_DIR", str(dit_dir))
        monkeypatch.setattr(cfg, "SEEDVR2_VAE_DIR", str(vae_dir))
        monkeypatch.setattr(cfg, "SEEDVR2_POS_EMB", str(tmp_path / "pos.pt"))

        models = collect_model_fingerprint_seedvr2()
        # Static declared precision is recorded for audit.
        assert models["seedvr2_dit_format"] == "mlx-8bit"
        # Core keys still present (path may be a not-found error dict — that's fine;
        # this test only asserts the format audit field is wired through).
        for key in ("seedvr2_dit", "seedvr2_vae", "seedvr2_pos_emb"):
            assert key in models

    def test_format_none_when_no_manifest(self, tmp_path, monkeypatch):
        from app import config as cfg
        from app.manifest import collect_model_fingerprint_seedvr2

        dit_dir = tmp_path / "dit"  # no manifest.json
        vae_dir = tmp_path / "vae"
        dit_dir.mkdir()
        vae_dir.mkdir()
        monkeypatch.setattr(cfg, "SEEDVR2_DIT_DIR", str(dit_dir))
        monkeypatch.setattr(cfg, "SEEDVR2_VAE_DIR", str(vae_dir))
        monkeypatch.setattr(cfg, "SEEDVR2_POS_EMB", str(tmp_path / "pos.pt"))

        models = collect_model_fingerprint_seedvr2()
        assert models["seedvr2_dit_format"] is None
