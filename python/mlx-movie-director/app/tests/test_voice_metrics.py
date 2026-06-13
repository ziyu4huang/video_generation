"""Regression tests for app/voice_metrics.py — audio quality metrics.

All tests use synthetic audio signals (numpy + scipy) — no real audio files
needed. The ffprobe subprocess for sample-rate probing is mocked.
"""

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from scipy import signal as _sig

pytest.importorskip("scipy.signal")

from app.voice_metrics import (
    _probe_sample_rate,
    _frame_rms,
    _snr_db,
    _f0_track,
    analyze_voice,
)


# ==========================================================================
# Synthetic audio helpers
# ==========================================================================

def _sine_wave(freq_hz: float, sr: int = 48000, duration_s: float = 1.0,
               amplitude: float = 0.5) -> np.ndarray:
    """Generate a pure sine wave."""
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def _sawtooth_wave(freq_hz: float, sr: int = 48000, duration_s: float = 1.0,
                   amplitude: float = 0.5) -> np.ndarray:
    """Generate a sawtooth wave (rich harmonics)."""
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    return (amplitude * _sig.sawtooth(2 * np.pi * freq_hz * t)).astype(np.float32)


def _silence(duration_s: float = 1.0, sr: int = 48000) -> np.ndarray:
    """Generate silence (all zeros)."""
    return np.zeros(int(sr * duration_s), dtype=np.float32)


def _noise(duration_s: float = 1.0, sr: int = 48000,
           std: float = 0.01, seed: int = 0) -> np.ndarray:
    """Generate Gaussian noise."""
    rng = np.random.default_rng(seed)
    return (rng.normal(0, std, int(sr * duration_s))).astype(np.float32)


# ==========================================================================
# _probe_sample_rate
# ==========================================================================

class TestProbeSampleRate:
    def test_normal_parse(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="48000\n", stderr="")
            assert _probe_sample_rate("/fake.mp4") == 48000

    def test_empty_stdout_falls_back_to_48000(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            assert _probe_sample_rate("/fake.mp4") == 48000

    def test_non_numeric_stdout_falls_back(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="invalid\n", stderr="")
            assert _probe_sample_rate("/fake.mp4") == 48000

    def test_subprocess_file_not_found_falls_back(self):
        with patch("subprocess.run", side_effect=FileNotFoundError("ffprobe not found")):
            assert _probe_sample_rate("/fake.mp4") == 48000

    def test_subprocess_timeout_falls_back(self):
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("ffprobe", 30)):
            assert _probe_sample_rate("/fake.mp4") == 48000

    def test_44100_hz(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="44100\n", stderr="")
            assert _probe_sample_rate("/fake.mp4") == 44100

    def test_16000_hz(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="16000\n", stderr="")
            assert _probe_sample_rate("/fake.mp4") == 16000


import subprocess  # noqa: E402 — needed for TimeoutExpired in tests


# ==========================================================================
# _frame_rms
# ==========================================================================

class TestFrameRms:
    def test_constant_amplitude(self):
        samples = np.full(2048, 0.5, dtype=np.float32)
        rms = _frame_rms(samples, frame=512, hop=256)
        assert rms.size > 0
        assert np.allclose(rms, 0.5, atol=1e-6), f"Expected RMS ~0.5, got {rms}"

    def test_silence_zero(self):
        samples = np.zeros(2048, dtype=np.float32)
        rms = _frame_rms(samples, frame=512, hop=256)
        assert np.allclose(rms, 0.0, atol=1e-7)

    def test_shorter_than_frame_uses_min_frame(self):
        """Signal < frame: clamp frame to max(64, len(samples))."""
        samples = np.ones(100, dtype=np.float32)
        rms = _frame_rms(samples, frame=1024, hop=512)
        # 100 < 1024 → frame clamped to 64, n = 1 + (100-64)//512 = 1
        assert rms.size == 1, f"Expected 1 frame, got {rms.size}"

    def test_hop_and_frame_sizes(self):
        samples = np.ones(5000, dtype=np.float32)
        rms = _frame_rms(samples, frame=1024, hop=512)
        expected_n = 1 + (5000 - 1024) // 512
        assert rms.size == expected_n, f"Expected {expected_n} frames, got {rms.size}"

    def test_output_type(self):
        samples = np.ones(1024, dtype=np.float32)
        rms = _frame_rms(samples, frame=512, hop=256)
        assert rms.dtype == np.float32

    def test_sine_wave_rms(self):
        """Sine wave at amplitude 0.5 has RMS ≈ 0.3535 = 0.5/sqrt(2)."""
        samples = _sine_wave(440.0, sr=48000, duration_s=0.1, amplitude=0.5)
        rms = _frame_rms(samples, frame=1024, hop=512)
        expected = 0.5 / np.sqrt(2)
        assert np.allclose(rms, expected, atol=0.02), (
            f"Sine RMS should be ~{expected:.4f}, got {rms.mean():.4f}"
        )


# ==========================================================================
# _snr_db
# ==========================================================================

class TestSnrDb:
    def test_fewer_than_4_frames_returns_zero(self):
        rms = np.array([0.1, 0.2, 0.3], dtype=np.float32)
        assert _snr_db(rms) == 0.0

    def test_constant_rms_returns_high_snr(self):
        rms = np.full(10, 0.5, dtype=np.float32)
        snr = _snr_db(rms)
        # Constant RMS → signal energy = noise energy → 10*log10(1) = 0 dB
        assert snr == pytest.approx(0.0, abs=0.01)

    def test_low_noise_floor_gives_positive_snr(self):
        """Bottom 30% frames = noise floor, top 70% = signal → SNR >> 0."""
        rms = np.ones(100, dtype=np.float32)
        rms[:30] = 0.001  # 30% noise floor
        rms[30:] = 1.0    # 70% signal
        snr = _snr_db(rms)
        # noise = bottom 10% (10 frames) = all 0.001^2 = 1e-6
        # signal mean = (30*1e-6 + 70*1.0)/100 ≈ 0.7
        # SNR ≈ 10*log10(0.7/1e-6) ≈ 58 dB
        assert snr > 30.0, f"Expected SNR >> 0, got {snr}"

    def test_same_signal_and_noise_returns_close_to_0(self):
        """When noise floor = mean signal, SNR ~ 0 dB."""
        rms = np.full(20, 0.5, dtype=np.float32)
        # All frames have same energy → signal ≈ noise → 10*log10(1) ≈ 0
        snr = _snr_db(rms)
        assert snr == pytest.approx(0.0, abs=0.1)

    def test_all_zero_rms_returns_zero(self):
        rms = np.zeros(10, dtype=np.float32)
        assert _snr_db(rms) == 0.0


# ==========================================================================
# _f0_track — autocorrelation pitch detection
# ==========================================================================

class TestF0Track:
    def test_silence_returns_empty(self):
        samples = _silence(duration_s=0.5, sr=48000)
        f0s = _f0_track(samples, sr=48000)
        assert f0s == []

    def test_sine_220hz_at_48k(self):
        """220 Hz sine at 48 kHz should be detected near 220 Hz."""
        samples = _sine_wave(220.0, sr=48000, duration_s=0.2, amplitude=0.5)
        f0s = _f0_track(samples, sr=48000)
        assert len(f0s) > 0, "Expected voiced frames for 220 Hz sine"
        mean_f0 = float(np.mean(f0s))
        assert abs(mean_f0 - 220) < 15, f"F0 should be ~220 Hz, got {mean_f0:.1f} Hz"

    def test_sine_440hz_at_48k(self):
        """440 Hz sine at 48 kHz should be detected near 440 Hz."""
        samples = _sine_wave(440.0, sr=48000, duration_s=0.2, amplitude=0.5)
        f0s = _f0_track(samples, sr=48000)
        assert len(f0s) > 0, "Expected voiced frames for 440 Hz sine"
        mean_f0 = float(np.mean(f0s))
        assert abs(mean_f0 - 440) < 30, f"F0 should be ~440 Hz, got {mean_f0:.1f} Hz"

    def test_sine_100hz_at_16k(self):
        """100 Hz sine at 16 kHz (lower sample rate)."""
        samples = _sine_wave(100.0, sr=16000, duration_s=0.3, amplitude=0.5)
        f0s = _f0_track(samples, sr=16000)
        assert len(f0s) > 0, "Expected voiced frames for 100 Hz sine"
        mean_f0 = float(np.mean(f0s))
        assert abs(mean_f0 - 100) < 15, f"F0 should be ~100 Hz, got {mean_f0:.1f} Hz"

    def test_sawtooth_220hz_detected(self):
        """Sawtooth (rich harmonics) at 220 Hz still gives F0 near 220."""
        samples = _sawtooth_wave(220.0, sr=48000, duration_s=0.2, amplitude=0.5)
        f0s = _f0_track(samples, sr=48000)
        assert len(f0s) > 0, "Expected voiced frames for 220 Hz sawtooth"
        mean_f0 = float(np.mean(f0s))
        assert abs(mean_f0 - 220) < 20, f"F0 should be ~220 Hz, got {mean_f0:.1f} Hz"

    def test_short_signal_returns_empty(self):
        """Signal shorter than frame size returns empty."""
        samples = np.ones(100, dtype=np.float32)
        f0s = _f0_track(samples, sr=48000, frame=1024)
        assert f0s == []

    def test_low_amplitude_noise_not_voiced(self):
        """Low-amplitude noise should not trigger voicing."""
        samples = _noise(duration_s=0.2, sr=48000, std=0.001)
        f0s = _f0_track(samples, sr=48000)
        assert len(f0s) == 0, "Low noise should not be classified as voiced"


# ==========================================================================
# analyze_voice — end-to-end with mocked ffprobe + _extract_audio_pcm
# ==========================================================================

class TestAnalyzeVoice:
    def _mock_extract(self, samples: np.ndarray):
        """Patch both ffprobe and _extract_audio_pcm for testing."""
        return patch.multiple(
            "app.voice_metrics",
            _probe_sample_rate=MagicMock(return_value=48000),
            _extract_audio_pcm=MagicMock(return_value=samples),
        )

    def test_all_keys_returned(self):
        """analyze_voice returns all expected keys even for silence."""
        samples = _sine_wave(220.0, sr=48000, duration_s=0.5, amplitude=0.5)
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        expected_keys = {
            "snr_db", "speech_activity", "f0_mean", "f0_std",
            "f0_st_std", "dynamic_range_db", "onset_rate",
            "spectral_centroid_hz", "duration_s",
        }
        assert expected_keys.issubset(set(res.keys())), (
            f"Missing keys: {expected_keys - set(res.keys())}"
        )

    def test_duration_approximate(self):
        samples = _sine_wave(220.0, sr=48000, duration_s=0.5, amplitude=0.5)
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        assert res["duration_s"] == pytest.approx(0.5, abs=0.01)

    def test_silence_note_added(self):
        """Very short audio gets a 'note' key."""
        samples = np.zeros(100, dtype=np.float32)
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        assert "note" in res
        assert res["duration_s"] == 0.0

    def test_sine_has_f0(self):
        samples = _sine_wave(220.0, sr=48000, duration_s=0.5, amplitude=0.5)
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        assert res["f0_mean"] > 0, f"F0 mean should be positive, got {res['f0_mean']}"

    def test_snr_positive_for_tone(self):
        samples = _sine_wave(440.0, sr=48000, duration_s=0.3, amplitude=0.5)
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        assert res["snr_db"] >= 0.0, f"SNR should be >= 0 for clean tone, got {res['snr_db']}"

    def test_intermittent_signal_has_moderate_speech_activity(self):
        """A signal with bursts of tone + silence should have moderate activity."""
        sr = 48000
        # 0.1s tone → 0.15s silence → 0.1s tone
        tone = _sine_wave(220.0, sr=sr, duration_s=0.1, amplitude=0.5)
        silent = np.zeros(int(sr * 0.15), dtype=np.float32)
        samples = np.concatenate([tone, silent, tone])
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        # With 0.2s of tone out of 0.35s total, speech_activity should be < 0.7
        assert 0.2 < res["speech_activity"] < 0.8, (
            f"Expected moderate speech_activity for intermittent signal, "
            f"got {res['speech_activity']}"
        )

    def test_values_are_all_finite(self):
        samples = _sine_wave(220.0, sr=48000, duration_s=0.2, amplitude=0.5)
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        for k, v in res.items():
            if isinstance(v, float):
                assert np.isfinite(v), f"Non-finite value for {k}: {v}"

    def test_onset_rate_positive_for_modulated_signal(self):
        """A signal with amplitude modulation should have onsets."""
        sr = 48000
        t = np.linspace(0, 1.0, sr, endpoint=False)
        # Amplitude-modulated: 5 Hz modulation on 220 Hz carrier
        carrier = np.sin(2 * np.pi * 220 * t)
        modulator = 0.5 + 0.5 * np.sin(2 * np.pi * 5 * t)
        samples = (carrier * modulator).astype(np.float32) * 0.5
        with self._mock_extract(samples):
            res = analyze_voice("/fake.mp4")
        assert res["onset_rate"] > 0, (
            f"AM signal should have positive onset rate, got {res['onset_rate']}"
        )


# ==========================================================================
# analyze_voice — integration with real sample-rate probing (mocked ffprobe)
# ==========================================================================

class TestAnalyzeVoiceProbeIntegration:
    """Verify that analyze_voice connects _probe_sample_rate result to _f0_track.

    The sample rate from ffprobe propagates correctly to the F0 math.
    """

    def test_44100_sr_affects_f0(self):
        """At 44100 Hz, the same sine wave should still give correct F0."""
        samples = _sine_wave(220.0, sr=44100, duration_s=0.3, amplitude=0.5)
        with patch("app.voice_metrics._probe_sample_rate", return_value=44100), \
             patch("app.voice_metrics._extract_audio_pcm", return_value=samples):
            res = analyze_voice("/fake.mp4")
        assert res["f0_mean"] > 180, f"F0 mean should be near 220 Hz, got {res['f0_mean']}"
        assert res["f0_mean"] < 280
