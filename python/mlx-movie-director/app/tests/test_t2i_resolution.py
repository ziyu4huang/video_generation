"""Regression tests for the --resolution tier system in app/commands/image-t2i.py.

The tier system decouples model-optimal resolution (training distribution) from
benchmark/self-learning resolution (larger, for Apple-Silicon rendering capacity).
Pure-logic tests — no GPU, no models. image-t2i.py has a hyphenated name so it is
loaded via importlib (matching image.py / schema-defaults.py).
"""

import importlib

import pytest

_t2i = importlib.import_module("app.commands.image-t2i")
_resolve_resolution = _t2i._resolve_resolution
_RESOLUTION_TIERS = _t2i._RESOLUTION_TIERS


# ==========================================================================
# Named tiers
# ==========================================================================

class TestNamedTiers:
    def test_model_tier_matches_historical_default(self):
        # model tier must equal the pre-existing training-optimal defaults
        assert _resolve_resolution("model", "zimage") == (640, 960)
        assert _resolve_resolution("model", "flux2-klein") == (640, 960)
        assert _resolve_resolution("model", "lens") == (1024, 1024)

    def test_benchmark_tier_is_larger_than_model(self):
        # the whole point: benchmark exercises more pixels than model-optimal
        for pipe in ("zimage", "flux2-klein"):
            mw, mh = _resolve_resolution("model", pipe)
            bw, bh = _resolve_resolution("benchmark", pipe)
            assert bw * bh > mw * mh, f"benchmark not larger for {pipe}"
        assert _resolve_resolution("benchmark", "zimage") == (1024, 1536)

    def test_large_tier_is_larger_than_benchmark(self):
        for pipe in ("zimage", "flux2-klein"):
            bp = _resolve_resolution("benchmark", pipe)
            lp = _resolve_resolution("large", pipe)
            assert lp[0] * lp[1] > bp[0] * bp[1]

    def test_all_tier_values_are_multiple_of_16(self):
        # Flux2 VAE /8 × patchify /2 → dims must be divisible by 16
        for tier in _RESOLUTION_TIERS.values():
            for pipe, (w, h) in tier.items():
                assert w % 16 == 0 and h % 16 == 0, f"{pipe} {w}x{h} not /16"


# ==========================================================================
# Explicit WxH / W:H + snapping
# ==========================================================================

class TestExplicitDims:
    def test_WxH_form(self):
        assert _resolve_resolution("1024x1536", "zimage") == (1024, 1536)

    def test_WH_colon_form(self):
        assert _resolve_resolution("1024:1536", "zimage") == (1024, 1536)

    def test_snaps_up_to_multiple_of_16(self):
        # 1000 → 1008 (next multiple of 16)
        assert _resolve_resolution("1000x1000", "zimage") == (1008, 1008)
        assert _resolve_resolution("970x1450", "zimage") == (976, 1456)

    def test_already_multiple_of_16_unchanged(self):
        assert _resolve_resolution("1280x1920", "zimage") == (1280, 1920)


# ==========================================================================
# Edge cases
# ==========================================================================

class TestEdgeCases:
    def test_none_returns_none(self):
        assert _resolve_resolution(None, "zimage") is None

    def test_empty_returns_none(self):
        assert _resolve_resolution("", "zimage") is None

    def test_bogus_tier_returns_none(self):
        assert _resolve_resolution("bogus", "zimage") is None

    def test_malformed_dims_return_none(self):
        for bad in ("1024x", "x768", "abc", "12x12x12", "-100x200"):
            assert _resolve_resolution(bad, "zimage") is None, f"{bad!r} should be None"

    def test_unknown_pipeline_falls_back_to_zimage_portrait(self):
        # tier lookup for an unrecognized pipeline uses the zimage portrait entry
        assert _resolve_resolution("benchmark", "unknown-pipeline") == (1024, 1536)
