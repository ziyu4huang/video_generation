"""CPU-only tests for Z-Image manifest-driven quantization detection.

Covers ``app.pipeline._detect_transformer_quant`` — the resolver that
``image t2i`` and (after the i2i quant fix) ``image i2i`` use to pick the
right ``(bits, group_size)`` when loading a Z-Image transformer. The i2i
loader previously hardcoded ``4-bit/32`` and crashed on every mlx-8bit
transformer (the default ``moody-pro-mix`` included) with a
``t_embedder.linear1.weight`` shape mismatch; these tests guard the
manifest-driven detection that replaced it.

No model load, no GPU — the resolver only reads a ``manifest.json`` ``format``
field, with a backward-compatible ``(4, 32)`` fallback.
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

from app.pipeline import _detect_transformer_quant
from app import config as cfg


class TestDetectTransformerQuant:
    """``_detect_transformer_quant`` maps the manifest ``format`` -> (bits, gs)."""

    def _write_manifest(self, tmp_path, fmt):
        if fmt is not None:
            with open(os.path.join(tmp_path, "manifest.json"), "w") as f:
                json.dump({"format": fmt}, f)
        return str(tmp_path)

    def test_8bit(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-8bit")
        assert _detect_transformer_quant(d) == (8, 64)

    def test_4bit_gs32(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-4bit-gs32")
        assert _detect_transformer_quant(d) == (4, 32)

    def test_4bit_legacy(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-4bit")
        assert _detect_transformer_quant(d) == (4, 32)

    def test_fallback_missing_manifest(self, tmp_path):
        # No manifest.json at all -> backward-compatible 4-bit/32 default
        assert _detect_transformer_quant(str(tmp_path)) == (4, 32)

    def test_fallback_unknown_format(self, tmp_path):
        d = self._write_manifest(tmp_path, "mlx-16bit")
        assert _detect_transformer_quant(d) == (4, 32)

    def test_fallback_malformed_json(self, tmp_path):
        # A corrupt manifest must NOT crash loading — fall back + warn.
        with open(os.path.join(tmp_path, "manifest.json"), "w") as f:
            f.write("{not valid json")
        assert _detect_transformer_quant(str(tmp_path)) == (4, 32)

    def test_fallback_non_dict_manifest(self, tmp_path):
        # manifest.json that parses to a list/string must also fall back.
        with open(os.path.join(tmp_path, "manifest.json"), "w") as f:
            json.dump(["mlx-8bit"], f)
        assert _detect_transformer_quant(str(tmp_path)) == (4, 32)


class TestRealTransformerManifests:
    """Against the repo's actual model dirs, when present (skipped otherwise).

    Anchors the detection to reality: the default transformer and the
    luciddreamer-z variant shipped with this repo are both mlx-8bit, so they
    must resolve to (8, 64) — the case the old hardcoded 4-bit i2i loader broke.
    """

    @pytest.mark.parametrize("dirname", ["moody-pro-mix", "luciddreamer-z"])
    def test_default_is_8bit(self, dirname):
        d = os.path.join(cfg.MODELS_DIR, "transformer", dirname)
        if not os.path.isdir(d):
            pytest.skip(f"{dirname} model dir not present")
        bits, gs = _detect_transformer_quant(d)
        assert (bits, gs) == (8, 64), (
            f"{dirname} is the repo default/variant and must be 8-bit; "
            f"got ({bits}, {gs})"
        )
