"""Regression tests for app/lipsync_metrics.py — pure-numpy correlation math.

No real video/mediapipe/ffmpeg calls — synthetic mouth-ratio and audio-envelope
series, plus a fake landmark object for the ratio-from-landmarks helper.
"""

from types import SimpleNamespace

import numpy as np
import pytest

from app.lipsync_metrics import (
    _lagged_pearson,
    _mouth_open_ratio_from_landmarks,
    ADEQUATE_R_THRESHOLD,
    MIN_MOUTH_STD_THRESHOLD,
    extract_audio_envelope,
    measure_lipsync_precision,
)


def _landmark(x: float, y: float):
    return SimpleNamespace(x=x, y=y)


def _fake_landmarks(mouth_gap: float, interocular: float):
    """Build a 264-entry landmark list with the four indices lipsync_metrics reads set."""
    lms = [_landmark(0.0, 0.0)] * 264
    lms[13] = _landmark(0.5, 0.5)                     # mouth top
    lms[14] = _landmark(0.5, 0.5 + mouth_gap)          # mouth bottom
    lms[33] = _landmark(0.3, 0.4)                      # left eye outer
    lms[263] = _landmark(0.3 + interocular, 0.4)       # right eye outer
    return lms


# ==========================================================================
# _mouth_open_ratio_from_landmarks
# ==========================================================================

class TestMouthOpenRatio:
    def test_closed_mouth_near_zero(self):
        lms = _fake_landmarks(mouth_gap=0.0, interocular=0.2)
        assert _mouth_open_ratio_from_landmarks(lms) == pytest.approx(0.0, abs=1e-9)

    def test_open_mouth_positive_ratio(self):
        lms = _fake_landmarks(mouth_gap=0.04, interocular=0.2)
        ratio = _mouth_open_ratio_from_landmarks(lms)
        assert ratio == pytest.approx(0.2, abs=1e-6)  # 0.04 / 0.2

    def test_scale_invariant(self):
        """Same open fraction at 2x face scale gives the same ratio."""
        small = _fake_landmarks(mouth_gap=0.02, interocular=0.1)
        large = _fake_landmarks(mouth_gap=0.04, interocular=0.2)
        assert _mouth_open_ratio_from_landmarks(small) == pytest.approx(
            _mouth_open_ratio_from_landmarks(large), abs=1e-9
        )

    def test_zero_interocular_returns_none(self):
        lms = _fake_landmarks(mouth_gap=0.02, interocular=0.0)
        assert _mouth_open_ratio_from_landmarks(lms) is None

    def test_short_landmark_list_returns_none(self):
        assert _mouth_open_ratio_from_landmarks([_landmark(0, 0)]) is None


# ==========================================================================
# _lagged_pearson
# ==========================================================================

class TestLaggedPearson:
    def test_identical_series_perfect_correlation(self):
        rng = np.random.default_rng(0)
        a = rng.normal(size=100)
        r, lag = _lagged_pearson(a, a.copy(), max_lag=3)
        assert r == pytest.approx(1.0, abs=1e-6)
        assert lag == 0

    def test_shifted_series_finds_lag(self):
        rng = np.random.default_rng(1)
        a = rng.normal(size=200)
        shift = 2
        b = np.roll(a, shift)
        r, lag = _lagged_pearson(a, b, max_lag=4)
        assert abs(r) > 0.9
        assert abs(lag) == shift

    def test_uncorrelated_series_near_zero(self):
        rng = np.random.default_rng(2)
        a = rng.normal(size=500)
        b = rng.normal(size=500)
        r, _ = _lagged_pearson(a, b, max_lag=4)
        assert abs(r) < 0.3

    def test_inverted_series_negative_correlation(self):
        rng = np.random.default_rng(3)
        a = rng.normal(size=200)
        b = -a
        r, lag = _lagged_pearson(a, b, max_lag=2)
        assert r == pytest.approx(-1.0, abs=1e-6)

    def test_nan_frames_excluded(self):
        rng = np.random.default_rng(4)
        a = rng.normal(size=100)
        b = a.copy()
        b[10:20] = np.nan
        r, _ = _lagged_pearson(a, b, max_lag=2)
        assert r == pytest.approx(1.0, abs=1e-6)

    def test_too_short_returns_zero(self):
        r, lag = _lagged_pearson(np.array([1.0, 2.0]), np.array([1.0, 2.0]), max_lag=2)
        assert r == 0.0
        assert lag == 0

    def test_constant_series_returns_zero(self):
        """Zero-variance series can't correlate — must not raise or return NaN."""
        a = np.ones(50)
        b = np.random.default_rng(5).normal(size=50)
        r, lag = _lagged_pearson(a, b, max_lag=2)
        assert r == 0.0


# ==========================================================================
# extract_audio_envelope
# ==========================================================================

class TestExtractAudioEnvelope:
    def test_short_audio_returns_zeros(self, monkeypatch):
        monkeypatch.setattr(
            "app.lipsync_metrics._extract_audio_pcm",
            lambda path: np.zeros(10, dtype=np.float32),
        )
        env = extract_audio_envelope("/fake.mp4", n_samples=5)
        assert len(env) == 5
        assert np.all(env == 0.0)

    def test_resamples_to_requested_length(self, monkeypatch):
        rng = np.random.default_rng(6)
        samples = rng.normal(0, 0.1, 48000).astype(np.float32)
        monkeypatch.setattr("app.lipsync_metrics._extract_audio_pcm", lambda path: samples)
        monkeypatch.setattr("app.lipsync_metrics._probe_sample_rate", lambda path: 48000)
        env = extract_audio_envelope("/fake.mp4", n_samples=49)
        assert len(env) == 49
        assert np.all(np.isfinite(env))


# ==========================================================================
# measure_lipsync_precision — end-to-end with mocked series
# ==========================================================================

class TestMeasureLipsyncPrecision:
    def test_correlated_series_gives_adequate_verdict(self, monkeypatch):
        rng = np.random.default_rng(7)
        shared = np.abs(rng.normal(size=60)) + 0.1
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_mouth_open_series",
            lambda path: {"ratios": shared.copy(), "fps": 24.0, "n_frames": 60, "n_detected": 60},
        )
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_audio_envelope",
            lambda path, n_samples: shared.copy()[:n_samples],
        )
        result = measure_lipsync_precision("/fake.mp4")
        assert result["verdict"] == "adequate"
        assert abs(result["pearson_r"]) >= ADEQUATE_R_THRESHOLD

    def test_uncorrelated_series_gives_inadequate_verdict(self, monkeypatch):
        rng = np.random.default_rng(8)
        mouth = rng.normal(size=200)
        audio = rng.normal(size=200)
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_mouth_open_series",
            lambda path: {"ratios": mouth, "fps": 24.0, "n_frames": 200, "n_detected": 200},
        )
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_audio_envelope",
            lambda path, n_samples: audio[:n_samples],
        )
        result = measure_lipsync_precision("/fake.mp4")
        assert result["verdict"] == "inadequate"

    def test_no_face_detected_short_circuits(self, monkeypatch):
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_mouth_open_series",
            lambda path: {"ratios": np.array([np.nan] * 10), "fps": 24.0,
                          "n_frames": 10, "n_detected": 1},
        )
        result = measure_lipsync_precision("/fake.mp4")
        assert result["verdict"] == "no_face"

    def test_silent_audio_short_circuits(self, monkeypatch):
        ratios = np.abs(np.random.default_rng(9).normal(size=60)) + 0.1
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_mouth_open_series",
            lambda path: {"ratios": ratios, "fps": 24.0, "n_frames": 60, "n_detected": 60},
        )
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_audio_envelope",
            lambda path, n_samples: np.zeros(n_samples),
        )
        result = measure_lipsync_precision("/fake.mp4")
        assert result["verdict"] == "no_audio"

    def test_strong_negative_correlation_is_inadequate(self, monkeypatch):
        """Mouth opens when audio is quiet and closes when audio is loud — a real,
        strong |r| but the wrong direction. Not genuine lip-sync (found in
        production: line6 with a swapped portrait scored r=-0.53,
        mouth_ratio_std=0.02 — real motion, clearly anti-phase)."""
        rng = np.random.default_rng(11)
        base = rng.normal(size=80)
        ratios = -base * 0.02 + 0.05  # real variance, exactly anti-correlated
        audio = base.copy()
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_mouth_open_series",
            lambda path: {"ratios": ratios, "fps": 24.0, "n_frames": 80, "n_detected": 80},
        )
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_audio_envelope",
            lambda path, n_samples: audio[:n_samples],
        )
        result = measure_lipsync_precision("/fake.mp4")
        assert result["pearson_r"] <= -ADEQUATE_R_THRESHOLD
        assert result["mouth_ratio_std"] >= MIN_MOUTH_STD_THRESHOLD
        assert result["verdict"] == "inadequate"
        assert "caveat" in result

    def test_flat_mouth_with_spurious_correlation_is_inadequate(self, monkeypatch):
        """A near-motionless mouth (std below MIN_MOUTH_STD_THRESHOLD) that happens
        to correlate with audio by construction must NOT be called adequate —
        this is the exact false-positive shape found in production (line2 of the
        dialogue-scene proof-of-concept: r=0.31, mouth_ratio_std=0.0066)."""
        rng = np.random.default_rng(10)
        base = rng.normal(size=80)
        ratios = base * 0.0001 + 0.03  # tiny variance, but linearly tied to base
        audio = base.copy()
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_mouth_open_series",
            lambda path: {"ratios": ratios, "fps": 24.0, "n_frames": 80, "n_detected": 80},
        )
        monkeypatch.setattr(
            "app.lipsync_metrics.extract_audio_envelope",
            lambda path, n_samples: audio[:n_samples],
        )
        result = measure_lipsync_precision("/fake.mp4")
        assert abs(result["pearson_r"]) >= ADEQUATE_R_THRESHOLD
        assert result["mouth_ratio_std"] < MIN_MOUTH_STD_THRESHOLD
        assert result["verdict"] == "inadequate"
        assert "caveat" in result
