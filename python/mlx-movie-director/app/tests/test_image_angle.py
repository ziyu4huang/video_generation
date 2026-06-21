"""Tests for image-angle logic — pure helpers, no model loading.

Covers:
  1. _angle_to_text — non-rich byte-identical to the historical mapping + rich finer buckets
  2. ANGLE_PRESETS — every preset maps to its documented (azimuth, elevation)
  3. _resolve_effective_angle — precedence (explicit degrees > preset > builtin default)
  4. _clamp_ref_count — [1, 3] clamp with the over-conditioning ceiling
"""

import importlib
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../.."))


def _load_angle_mod():
    """Import image-angle module (hyphen in name requires importlib)."""
    return importlib.import_module("app.commands.image-angle")


# ---------------------------------------------------------------------------
# 1. _angle_to_text
# ---------------------------------------------------------------------------

class TestAngleToText:
    mod = _load_angle_mod()

    # Historical byte-identical values (non-rich). Same input ⇒ same phrase ⇒ same
    # prompt ⇒ reproducible image. Any change here is a reproducibility regression.
    @pytest.mark.parametrize("azimuth,elevation,expected", [
        (0, 0,   "front view"),
        (90, 0,  "right side profile"),
        (180, 0, "back view"),
        (270, 0, "left side profile"),
        (45, 0,  "front-right three-quarter view"),
        (22, 0,  "front view"),            # boundary: <22.5° still rounds to front (idx 0)
        (0, 30,  "front view, high angle shot (camera above, looking down)"),
        (0, -30, "front view, low angle shot (camera below, looking up)"),
        (0, 10,  "front view"),            # |elev| <= 20 → neutral
        (360, 0, "front view"),            # modulo normalization
        (-90, 0, "left side profile"),     # negative azimuth wraps
    ])
    def test_non_rich_byte_identical(self, azimuth, elevation, expected):
        assert self.mod._angle_to_text(azimuth, elevation, rich=False) == expected

    def test_rich_adds_birds_eye_and_worms_eye(self):
        # >60° elevation → birds-eye / worms-eye (only in rich mode)
        assert "birds-eye view" in self.mod._angle_to_text(0, 75, rich=True)
        assert "worms-eye view" in self.mod._angle_to_text(0, -75, rich=True)
        # Non-rich at the same angles stays in the high/low bucket (byte-identical)
        assert "high angle shot" in self.mod._angle_to_text(0, 75, rich=False)
        assert "low angle shot" in self.mod._angle_to_text(0, -75, rich=False)

    def test_rich_and_non_rich_agree_in_midrange(self):
        # In the 20-60° band both modes produce identical elevation text.
        for elev in (25, 45, 59, -25, -45, -59):
            assert (self.mod._angle_to_text(90, elev, rich=True)
                    == self.mod._angle_to_text(90, elev, rich=False))


# ---------------------------------------------------------------------------
# 2. ANGLE_PRESETS
# ---------------------------------------------------------------------------

class TestAnglePresets:
    mod = _load_angle_mod()

    def test_expected_keys_present(self):
        keys = set(self.mod.ANGLE_PRESETS)
        # 8-way compass + vertical variants
        assert {"front", "front-right", "right", "rear-right",
                "back", "rear-left", "left", "front-left"} <= keys
        assert {"front-high", "right-high", "back-high",
                "front-low", "right-low", "birds-eye", "worms-eye"} <= keys

    @pytest.mark.parametrize("name,az,elev", [
        ("front", 0, 0), ("right", 90, 0), ("back", 180, 0), ("left", 270, 0),
        ("front-high", 0, 45), ("birds-eye", 0, 75), ("worms-eye", 0, -75),
    ])
    def test_preset_values(self, name, az, elev):
        assert self.mod.ANGLE_PRESETS[name] == (az, elev)

    def test_all_presets_resolve_to_valid_text(self):
        # Every preset must produce a non-empty, finite angle phrase.
        for name, (az, elev) in self.mod.ANGLE_PRESETS.items():
            text = self.mod._angle_to_text(az, elev)
            assert text and isinstance(text, str), f"preset {name} → empty text"


# ---------------------------------------------------------------------------
# 3. _resolve_effective_angle (precedence)
# ---------------------------------------------------------------------------

class TestResolveEffectiveAngle:
    mod = _load_angle_mod()

    def test_bare_defaults_to_90_0(self):
        az, elev, preset = self.mod._resolve_effective_angle(SimpleNamespace())
        assert (az, elev, preset) == (90.0, 0.0, None)

    def test_preset_resolves(self):
        ns = SimpleNamespace(angle="front-high")
        az, elev, preset = self.mod._resolve_effective_angle(ns)
        assert (az, elev) == (0.0, 45.0)
        assert preset == "front-high"

    def test_explicit_azimuth_overrides_preset(self):
        # --angle back --azimuth 200 → explicit 200 wins, preset recorded as None
        ns = SimpleNamespace(angle="back", azimuth=200.0)
        az, elev, preset = self.mod._resolve_effective_angle(ns)
        assert (az, elev, preset) == (200.0, 0.0, None)

    def test_explicit_elevation_alone_overrides_preset(self):
        ns = SimpleNamespace(angle="front", elevation=-15.0)
        az, elev, preset = self.mod._resolve_effective_angle(ns)
        assert preset is None
        assert (az, elev) == (90.0, -15.0)  # azimuth falls back to default 90

    def test_unknown_preset_exits(self, capsys):
        ns = SimpleNamespace(angle="nonsense")
        with pytest.raises(SystemExit):
            self.mod._resolve_effective_angle(ns)
        err = capsys.readouterr().err
        assert "unknown --angle preset" in err


# ---------------------------------------------------------------------------
# 4. _clamp_ref_count
# ---------------------------------------------------------------------------

class TestClampRefCount:
    mod = _load_angle_mod()

    @pytest.mark.parametrize("inp,expected", [
        (1, 1), (2, 2), (3, 3),           # in-range passes through
        (4, 3), (9, 3), (100, 3),         # over-ceiling clamps to 3
        (0, 1), (-5, 1),                   # below 1 clamps up to 1
    ])
    def test_clamp(self, inp, expected, capsys):
        assert self.mod._clamp_ref_count(inp) == expected
        # Warning only when clamped down from >3
        warned = "clamping" in capsys.readouterr().out
        assert warned == (inp > 3)
