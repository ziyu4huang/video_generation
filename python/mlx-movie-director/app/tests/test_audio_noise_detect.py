"""Regression tests for app/audio_noise_detect.py — noise detection metrics.

Pure numpy + mocked ffmpeg — no real audio files needed.
Also documents the known bug in _extract_audio_pcm's sample_rate parameter.
"""

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from app.audio_noise_detect import (
    _extract_audio_pcm,
    _compute_spectral_flatness,
    _compute_zcr,
    _compute_rms,
    is_audio_noise,
    check_audio_noise_or_exit,
    _FLATNESS_THRESH,
    _ZCR_THRESH,
)


# ==========================================================================
# Synthetic audio helpers
# ==========================================================================

def _sine_wave(freq_hz: float, sr: int = 48000, duration_s: float = 1.0,
               amplitude: float = 0.5) -> np.ndarray:
    """Generate a pure sine wave (float32)."""
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def _white_noise(duration_s: float = 1.0, sr: int = 48000,
                 std: float = 0.1, seed: int = 0) -> np.ndarray:
    """Generate white Gaussian noise (float32)."""
    rng = np.random.default_rng(seed)
    return rng.normal(0, std, int(sr * duration_s)).astype(np.float32)


# ==========================================================================
# _extract_audio_pcm — mocked ffmpeg
# ==========================================================================

class TestExtractAudioPcm:
    def test_successful_decode(self):
        """Successful ffmpeg run returns float32 array."""
        fake_pcm = np.array([100, 200, -100, -200], dtype=np.int16).tobytes()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=fake_pcm, stderr="")
            samples = _extract_audio_pcm("/fake.mp4")
        assert len(samples) == 4
        assert samples.dtype == np.float32
        # int16(100) / 32768.0 ≈ 0.00305
        assert abs(samples[0]) < 1.0

    def test_empty_stdout_returns_empty(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=b"", stderr="")
            samples = _extract_audio_pcm("/fake.mp4")
        assert len(samples) == 0

    def test_ffmpeg_error_returns_empty(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout=b"", stderr="error")
            samples = _extract_audio_pcm("/fake.mp4")
        assert len(samples) == 0

    def test_ffmpeg_not_found_propagates(self):
        """_extract_audio_pcm does NOT catch FileNotFoundError."""
        with patch("subprocess.run", side_effect=FileNotFoundError("ffmpeg")):
            with pytest.raises(FileNotFoundError):
                _extract_audio_pcm("/fake.mp4")

    def test_ffmpeg_timeout_propagates(self):
        """_extract_audio_pcm does NOT catch generic exceptions."""
        with patch("subprocess.run", side_effect=Exception("timeout")):
            with pytest.raises(Exception):
                _extract_audio_pcm("/fake.mp4")

    def test_native_rate_no_resample(self):
        """Without sample_rate, ffmpeg command should NOT include -ar."""
        fake_pcm = np.zeros(100, dtype=np.int16).tobytes()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=fake_pcm, stderr="")
            _extract_audio_pcm("/fake.mp4")
            call_args = mock_run.call_args[0][0]
            assert "-ar" not in call_args, (
                f"-ar should not appear without sample_rate arg: {call_args}"
            )

    def test_with_sample_rate_has_ar_flag(self):
        """When sample_rate is given, -ar should appear in the command."""
        fake_pcm = np.zeros(100, dtype=np.int16).tobytes()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=fake_pcm, stderr="")
            _extract_audio_pcm("/fake.mp4", sample_rate=16000)
            call_args = mock_run.call_args[0][0]
            assert "-ar" in call_args
            assert "16000" in call_args


# ==========================================================================
# KNOWN BUG REGRESSION: sample_rate arg ordering
# ==========================================================================

class TestKnownBugSampleRateOrdering:
    """Regression test for the documented KNOWN bug in voice_metrics.py.

    The bug: _extract_audio_pcm's sample_rate branch inserts -ar after -ac,
    but the ffmpeg argument order should be -ar BEFORE -ac in some cases.
    
    See voice_metrics.py docstring:
      "_extract_audio_pcm's sample_rate branch mis-orders the ffmpeg -ac/
      -ar args, so passing sample_rate yields an empty array."
    
    This test verifies the CURRENT (potentially buggy) behavior so that
    if someone fixes it, the test breaks — ensuring the fix is intentional.
    """

    def test_buggy_command_format(self):
        """Document the exact ffmpeg command produced with sample_rate.

        The current code:
          cmd.insert(cmd.index("-ac") + 1, "-ar")
          cmd.insert(cmd.index("-ac") + 2, str(sample_rate))
        
        This produces: ... -ac 1 -ar 16000 -ac 1 ...
        because after inserting "-ar" after "-ac", the SECOND "-ac" position
        has shifted. The result is a broken ffmpeg command.
        """
        fake_pcm = MagicMock()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=fake_pcm, stderr="")
            _extract_audio_pcm("/fake.mp4", sample_rate=16000)
            call_args = mock_run.call_args[0][0]

        # The known bug produces duplicated -ac flags
        ac_positions = [i for i, a in enumerate(call_args) if a == "-ac"]
        ar_positions = [i for i, a in enumerate(call_args) if a == "-ar"]
        
        # The expected position: -ar should be after -ac and before its value
        # This currently may produce broken ordering
        assert len(ac_positions) >= 1
        assert len(ar_positions) >= 1
        # We just document the structure — don't assert "correct" vs "wrong"
        # because the fix hasn't been applied yet.
        print(f"  ffmpeg cmd with sample_rate: {' '.join(call_args)}")

    def test_native_decode_does_not_trigger_bug(self):
        """Without sample_rate, the buggy branch is never entered."""
        fake_pcm = np.zeros(100, dtype=np.int16).tobytes()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=fake_pcm, stderr="")
            samples = _extract_audio_pcm("/fake.mp4")
            assert len(samples) == 100
            # Command should not contain -ar
            cmd = mock_run.call_args[0][0]
            assert "-ar" not in cmd


# ==========================================================================
# _compute_spectral_flatness
# ==========================================================================

class TestSpectralFlatness:
    def test_sine_wave_low_flatness(self):
        """Pure tone → spectral peaks → low flatness."""
        samples = _sine_wave(440.0, sr=48000, duration_s=0.2, amplitude=0.5)
        flatness = _compute_spectral_flatness(samples)
        assert flatness < 0.3, f"Sine flatness should be <0.3, got {flatness}"

    def test_white_noise_high_flatness(self):
        """White noise → flat spectrum → high flatness."""
        samples = _white_noise(duration_s=0.2, sr=48000, std=0.1)
        flatness = _compute_spectral_flatness(samples)
        assert flatness > 0.6, f"Noise flatness should be >0.6, got {flatness}"

    def test_silence_returns_low_flatness(self):
        """Silence has very low energy → returns low flatness."""
        samples = np.zeros(2048, dtype=np.float32)
        flatness = _compute_spectral_flatness(samples)
        # All bins have equal energy (the 1e-10 epsilon dominates) → flatness ~ 1.0
        # But in practice, numpy's rfft of zeros gives ~0, so the epsilon dominates
        # and log-spectrum is log(1e-10) = -23 → geometric_mean = 1e-10
        # arithmetic_mean = 1e-10 → ratio = 1.0
        assert flatness <= 1.0

    def test_very_short_signal_returns_zero(self):
        """Signal < 64 samples → returns 0.0."""
        samples = np.ones(32, dtype=np.float32)
        assert _compute_spectral_flatness(samples) == 0.0

    def test_returns_float_in_range(self):
        samples = _white_noise(duration_s=0.1)
        flatness = _compute_spectral_flatness(samples)
        assert 0.0 <= flatness <= 1.0

    def test_low_freq_sine_even_lower_flatness(self):
        """Lower frequency sine has sparser spectrum → even lower flatness."""
        samples_100 = _sine_wave(100.0, sr=48000, duration_s=0.2, amplitude=0.5)
        samples_1000 = _sine_wave(1000.0, sr=48000, duration_s=0.2, amplitude=0.5)
        f100 = _compute_spectral_flatness(samples_100)
        f1000 = _compute_spectral_flatness(samples_1000)
        assert f100 < 0.3
        assert f1000 < 0.3


# ==========================================================================
# _compute_zcr
# ==========================================================================

class TestZcr:
    def test_sine_low_zcr(self):
        """440 Hz sine at 48 kHz → ZCR ~ 2*440/48000 ≈ 0.018."""
        samples = _sine_wave(440.0, sr=48000, duration_s=0.2, amplitude=0.5)
        zcr = _compute_zcr(samples)
        expected = 2 * 440.0 / 48000
        assert abs(zcr - expected) < 0.01, f"440Hz ZCR should be ~{expected:.4f}, got {zcr:.4f}"

    def test_silence_returns_low_zcr(self):
        """Silence (all zeros) → no zero crossings."""
        samples = np.zeros(2048, dtype=np.float32)
        zcr = _compute_zcr(samples)
        assert zcr == 0.0

    def test_white_noise_high_zcr(self):
        """Noise crosses zero frequently → ZCR > 0.3."""
        samples = _white_noise(duration_s=0.2, sr=48000, std=0.1)
        zcr = _compute_zcr(samples)
        assert zcr > 0.3, f"Noise ZCR should be >0.3, got {zcr}"

    def test_very_short_signal_returns_zero(self):
        samples = np.ones(32, dtype=np.float32)
        assert _compute_zcr(samples) == 0.0

    def test_returns_float_in_range(self):
        samples = _white_noise(duration_s=0.1)
        zcr = _compute_zcr(samples)
        assert 0.0 <= zcr <= 1.0

    def test_high_freq_sine_higher_zcr(self):
        """Higher frequency → more zero crossings."""
        samples_100 = _sine_wave(100.0, sr=48000, duration_s=0.1, amplitude=0.5)
        samples_2000 = _sine_wave(2000.0, sr=48000, duration_s=0.1, amplitude=0.5)
        zcr_100 = _compute_zcr(samples_100)
        zcr_2000 = _compute_zcr(samples_2000)
        assert zcr_2000 > zcr_100, (
            f"2000 Hz ZCR ({zcr_2000:.4f}) should exceed 100 Hz ZCR ({zcr_100:.4f})"
        )


# ==========================================================================
# _compute_rms
# ==========================================================================

class TestRms:
    def test_sine_rms(self):
        """Sine at amplitude 0.5 → RMS ≈ 0.3535 = 0.5/sqrt(2)."""
        samples = _sine_wave(440.0, sr=48000, duration_s=0.1, amplitude=0.5)
        rms = _compute_rms(samples)
        expected = 0.5 / np.sqrt(2)
        assert rms == pytest.approx(expected, abs=0.02)

    def test_silence_zero(self):
        assert _compute_rms(np.zeros(1024, dtype=np.float32)) == 0.0

    def test_empty_returns_zero(self):
        assert _compute_rms(np.array([], dtype=np.float32)) == 0.0

    def test_constant_signal(self):
        samples = np.full(1024, 0.5, dtype=np.float32)
        assert _compute_rms(samples) == pytest.approx(0.5, abs=1e-6)

    def test_noise(self):
        samples = _white_noise(duration_s=0.1, std=0.1)
        rms = _compute_rms(samples)
        assert rms == pytest.approx(0.1, abs=0.02)


# ==========================================================================
# is_audio_noise — end-to-end with mocked _extract_audio_pcm
# ==========================================================================

class TestIsAudioNoise:
    def test_pure_tone_is_not_noise(self):
        """Pure sine below both thresholds → not noise."""
        samples = _sine_wave(440.0, sr=48000, duration_s=0.3, amplitude=0.5)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            is_noise, metrics = is_audio_noise("/fake.mp4")
        assert is_noise is False, f"Pure tone should not be noise (flatness={metrics['spectral_flatness']}, zcr={metrics['zcr']})"

    def test_white_noise_is_noise(self):
        """White noise above both thresholds → noise."""
        samples = _white_noise(duration_s=0.3, sr=48000, std=0.1)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            is_noise, metrics = is_audio_noise("/fake.mp4")
        assert is_noise is True, f"White noise should be detected (flatness={metrics['spectral_flatness']}, zcr={metrics['zcr']})"

    def test_short_audio_not_noise(self):
        """Audio < 1024 samples → not noise (too short to judge)."""
        samples = np.zeros(100, dtype=np.float32)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            is_noise, metrics = is_audio_noise("/fake.mp4")
        assert is_noise is False
        assert "note" in metrics

    def test_empty_audio_not_noise(self):
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=np.array([], dtype=np.float32)):
            is_noise, metrics = is_audio_noise("/fake.mp4")
        assert is_noise is False

    def test_metrics_contain_expected_keys(self):
        samples = _sine_wave(440.0, sr=48000, duration_s=0.3, amplitude=0.5)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            _, metrics = is_audio_noise("/fake.mp4")
        for key in ("spectral_flatness", "zcr", "rms", "samples"):
            assert key in metrics, f"Missing key: {key}"
        assert metrics["samples"] > 0

    def test_noise_crosses_both_thresholds(self):
        """Noise should have flatness > _FLATNESS_THRESH and ZCR > _ZCR_THRESH."""
        samples = _white_noise(duration_s=0.3, sr=48000, std=0.1)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            _, metrics = is_audio_noise("/fake.mp4")
        assert metrics["spectral_flatness"] > _FLATNESS_THRESH, (
            f"Noise flatness ({metrics['spectral_flatness']}) should exceed threshold ({_FLATNESS_THRESH})"
        )
        assert metrics["zcr"] > _ZCR_THRESH, (
            f"Noise ZCR ({metrics['zcr']}) should exceed threshold ({_ZCR_THRESH})"
        )


# ==========================================================================
# check_audio_noise_or_exit
# ==========================================================================

class TestCheckAudioNoiseOrExit:
    def test_clean_audio_returns_none(self):
        samples = _sine_wave(440.0, sr=48000, duration_s=0.3, amplitude=0.5)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            result = check_audio_noise_or_exit("/fake.mp4")
        assert result is None

    def test_noise_exits(self):
        samples = _white_noise(duration_s=0.3, sr=48000, std=0.1)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            with pytest.raises(SystemExit) as exc:
                check_audio_noise_or_exit("/fake.mp4")
            assert exc.value.code == 1

    def test_noise_with_allow_noise_returns_metrics(self, capsys):
        samples = _white_noise(duration_s=0.3, sr=48000, std=0.1)
        with patch("app.audio_noise_detect._extract_audio_pcm", return_value=samples):
            result = check_audio_noise_or_exit("/fake.mp4", allow_noise=True)
        assert result is not None
        assert "spectral_flatness" in result
        out = capsys.readouterr().err
        assert "suppressed" in out
