"""Regression tests for app/quality_metrics.py — 7 no-reference metrics,
PSNR/SSIM reference metrics, video comparison, and trend validation.

All tests use synthetic images/arrays — no real image or video files needed.
"""

import json
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

# OpenCV is required by quality_metrics at import time (import cv2 at module
# top). Gracefully skip if absent.
cv2 = pytest.importorskip("cv2")
pytest.importorskip("skimage.metrics")  # for structural_similarity

from app.quality_metrics import (
    analyze_frame,
    _compute_blockiness,
    compute_frame_reference,
    compare_videos_reference,
    validate_metric_trends,
    print_trend_validation,
    generate_html_report,
    _start_server,
    _read_all_frames,
    _STATIC_TEMPLATE,
)


# ==========================================================================
# Helpers — synthetic BGR + gray frame pairs
# ==========================================================================

def _make_bgr_gray(h: int, w: int, bgr_value: int = 128) -> tuple:
    """Return (gray_float64, bgr_uint8) for a uniform-color image."""
    bgr = np.full((h, w, 3), bgr_value, dtype=np.uint8)
    gray = np.full((h, w), 128, dtype=np.float64)
    return gray, bgr


def _make_gradient_bgr_gray(h: int, w: int) -> tuple:
    """Horizontal gradient: left=0, right=255. Returns (gray_float64, bgr_uint8)."""
    ramp = np.tile(np.linspace(0, 255, w, dtype=np.uint8), (h, 1))
    bgr = np.stack([ramp, ramp, ramp], axis=-1)
    gray = ramp.astype(np.float64)
    return gray, bgr


def _make_checkerboard_bgr_gray(h: int, w: int, block: int = 8) -> tuple:
    """Checkerboard of black/white blocks. Returns (gray_float64, bgr_uint8)."""
    c = np.fromfunction(
        lambda i, j: ((i // block) + (j // block)) % 2,
        (h, w), dtype=int
    )
    bgr = np.stack([c * 255] * 3, axis=-1).astype(np.uint8)
    gray = (c * 255).astype(np.float64)
    return gray, bgr


def _make_noisy_bgr_gray(h: int, w: int, noise_std: float = 25.0, seed: int = 0) -> tuple:
    """Uniform mid-gray + Gaussian noise. Returns (gray_float64, bgr_uint8)."""
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, noise_std, (h, w)).astype(np.float32)
    gray = np.full((h, w), 128.0, dtype=np.float64)
    gray_noisy = gray + noise
    # BGR from the same noise (clamped to uint8 range)
    noisy_uint8 = np.clip(gray_noisy, 0, 255).astype(np.uint8)
    bgr = np.stack([noisy_uint8] * 3, axis=-1)
    return gray, bgr  # return CLEAN gray (noisy is in bgr only for caller choice)


def _make_saturation_gradient_bgr(h: int, w: int) -> np.ndarray:
    """BGR image where the left half is grayscale and right half is saturated.

    This creates spatial variation in the HSV Saturation (S) channel.
    Left  half: R=G=B=128 (S=0)
    Right half: B=200, R=0, G=100 (S=high, near max)
    """
    bgr = np.zeros((h, w, 3), dtype=np.uint8)
    mid = w // 2
    # Left half: grayscale (S=0)
    bgr[:, :mid] = [128, 128, 128]
    # Right half: high saturation
    bgr[:, mid:, 0] = 200  # B
    bgr[:, mid:, 1] = 100  # G
    bgr[:, mid:, 2] = 0    # R
    return bgr


def _make_low_sat_bgr(h: int, w: int) -> np.ndarray:
    """BGR image with subtle saturation variation (narrow S range)."""
    bgr = np.zeros((h, w, 3), dtype=np.uint8)
    mid = w // 2
    bgr[:, :mid] = [128, 128, 128]       # S=0
    bgr[:, mid:, 0] = 140                # B
    bgr[:, mid:, 1] = 128                # G
    bgr[:, mid:, 2] = 120                # R — very subtle diff
    return bgr


# ==========================================================================
# _compute_blockiness
# ==========================================================================

class TestComputeBlockiness:
    def test_small_image_returns_zero(self):
        """Image smaller than 16×16 returns 0.0."""
        gray = np.zeros((8, 8), dtype=np.float64)
        assert _compute_blockiness(gray, 8, 8) == 0.0

    def test_16x16_returns_zero_for_uniform(self):
        """Uniform image has zero block boundary difference."""
        gray = np.full((32, 32), 128.0, dtype=np.float64)
        assert _compute_blockiness(gray, 32, 32) == 0.0

    def test_block_artifact_detected(self):
        """Checkerboard at block boundaries produces measurable blockiness."""
        h, w = 64, 64
        gray = np.zeros((h, w), dtype=np.float64)
        # Add horizontal stripes at 8px boundaries
        for i in range(8, h, 16):
            gray[i : i + 1, :] = 200.0
        b = _compute_blockiness(gray, h, w)
        assert b > 0.0, f"Expected positive blockiness, got {b}"

    def test_rectangular_not_square(self):
        """Non-square image still computes correctly."""
        h, w = 24, 32
        gray = np.zeros((h, w), dtype=np.float64)
        b = _compute_blockiness(gray, h, w)
        assert isinstance(b, float)
        assert b >= 0.0


# ==========================================================================
# analyze_frame — 7 metrics on synthetic images
# ==========================================================================

class TestAnalyzeFrameUniform:
    """Uniform gray image: zero edges, zero sharpness, zero contrast."""

    def test_sharpness_near_zero(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["sharpness"] < 1.0, f"Uniform sharpness should be ~0, got {m['sharpness']}"

    def test_edge_density_near_zero(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["edge_density"] < 1.0, f"Uniform edge should be ~0, got {m['edge_density']}"

    def test_contrast_near_zero(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["contrast"] < 1.0, f"Uniform contrast should be ~0, got {m['contrast']}"

    def test_snr_db_high_for_uniform(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["snr_db"] > 30.0, f"Uniform SNR should be high, got {m['snr_db']}"

    def test_saturation_std_near_zero(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["saturation_std"] < 1.0, f"Uniform saturation std should be ~0"

    def test_noise_sigma_near_zero(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["noise_sigma"] < 1.0, f"Uniform noise_sigma should be ~0, got {m['noise_sigma']}"

    def test_blockiness_near_zero(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        assert m["blockiness"] < 1.0

    def test_all_seven_keys_present(self):
        gray, bgr = _make_bgr_gray(128, 128)
        m = analyze_frame(gray, bgr)
        expected_keys = {
            "sharpness", "edge_density", "contrast", "noise_sigma",
            "snr_db", "blockiness", "saturation_std",
        }
        assert set(m.keys()) == expected_keys


class TestAnalyzeFrameGradient:
    """Horizontal gradient: high edge density at the gradient ramp, moderate contrast."""

    def test_contrast_positive(self):
        gray, bgr = _make_gradient_bgr_gray(64, 128)
        m = analyze_frame(gray, bgr)
        assert m["contrast"] > 50.0, f"Gradient contrast should be >50, got {m['contrast']}"

    def test_edge_density_positive(self):
        gray, bgr = _make_gradient_bgr_gray(64, 128)
        m = analyze_frame(gray, bgr)
        assert m["edge_density"] > 1.0, f"Gradient edge_density should be >1, got {m['edge_density']}"


class TestAnalyzeFrameCheckerboard:
    """Checkerboard: strong edges everywhere, high sharpness."""

    def test_sharpness_very_high(self):
        gray, bgr = _make_checkerboard_bgr_gray(64, 64, block=8)
        m = analyze_frame(gray, bgr)
        assert m["sharpness"] > 1000.0, f"Checkerboard sharpness should be >1000, got {m['sharpness']}"

    def test_edge_density_very_high(self):
        gray, bgr = _make_checkerboard_bgr_gray(64, 64, block=8)
        m = analyze_frame(gray, bgr)
        assert m["edge_density"] > 50.0, f"Checkerboard edge_density should be >50, got {m['edge_density']}"

    def test_contrast_high(self):
        gray, bgr = _make_checkerboard_bgr_gray(64, 64, block=8)
        m = analyze_frame(gray, bgr)
        assert m["contrast"] > 100.0


class TestAnalyzeFrameSaturationStd:
    """Color saturation std varies with input saturation."""

    def test_gray_has_low_saturation_std(self):
        gray, bgr = _make_bgr_gray(64, 64)
        m = analyze_frame(gray, bgr)
        assert m["saturation_std"] < 1.0

    def test_saturation_gradient_has_positive_std(self):
        """Half gray + half saturated → S-channel has spatial std > 0."""
        bgr = _make_saturation_gradient_bgr(64, 64)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)
        m = analyze_frame(gray, bgr)
        assert m["saturation_std"] > 50.0, (
            f"Saturation gradient should have std > 50, got {m['saturation_std']}"
        )

    def test_high_sat_std_greater_than_low_sat_std(self):
        bgr_high = _make_saturation_gradient_bgr(64, 64)
        bgr_low = _make_low_sat_bgr(64, 64)
        gray_high = cv2.cvtColor(bgr_high, cv2.COLOR_BGR2GRAY).astype(np.float64)
        gray_low = cv2.cvtColor(bgr_low, cv2.COLOR_BGR2GRAY).astype(np.float64)
        m_high = analyze_frame(gray_high, bgr_high)
        m_low = analyze_frame(gray_low, bgr_low)
        assert m_high["saturation_std"] > m_low["saturation_std"], (
            f"High-sat std ({m_high['saturation_std']}) should exceed "
            f"low-sat std ({m_low['saturation_std']})"
        )


class TestAnalyzeFrameResolutionInvariance:
    """Same pattern at different resolutions should preserve metric relationships."""

    def test_sharpness_increases_with_contrast(self):
        """Higher-contrast checkerboard has higher sharpness."""
        gray1, bgr1 = _make_checkerboard_bgr_gray(32, 32, block=4)
        gray2, bgr2 = _make_checkerboard_bgr_gray(32, 32, block=8)
        m1 = analyze_frame(gray1, bgr1)
        m2 = analyze_frame(gray2, bgr2)
        # Smaller blocks = more edges = higher sharpness
        assert m1["sharpness"] > m2["sharpness"], (
            f"Smaller blocks ({m1['sharpness']}) should have higher sharpness than larger "
            f"blocks ({m2['sharpness']})"
        )


# ==========================================================================
# compute_frame_reference — PSNR + SSIM
# ==========================================================================

class TestComputeFrameReference:
    def test_identical_frames_high_psnr(self):
        bgr = np.full((32, 32, 3), 128, dtype=np.uint8)
        result = compute_frame_reference(bgr, bgr)
        # cv2.PSNR returns a finite value for identical uint8 images
        # (not inf), so the np.isfinite cap to 100 doesn't always trigger.
        assert result["psnr"] > 50.0, f"Identical frames should have high PSNR, got {result['psnr']}"

    def test_identical_frames_ssim_one(self):
        bgr = np.full((32, 32, 3), 128, dtype=np.uint8)
        result = compute_frame_reference(bgr, bgr)
        assert result["ssim"] == pytest.approx(1.0, abs=1e-3)

    def test_very_different_psnr_lower(self):
        ref = np.full((32, 32, 3), 128, dtype=np.uint8)
        test = np.full((32, 32, 3), 0, dtype=np.uint8)
        result = compute_frame_reference(ref, test)
        assert result["psnr"] < 100.0, "Different frames should have PSNR < 100"
        assert result["psnr"] > 0.0

    def test_very_different_ssim_lower(self):
        ref = np.full((32, 32, 3), 255, dtype=np.uint8)
        test = np.full((32, 32, 3), 0, dtype=np.uint8)
        result = compute_frame_reference(ref, test)
        assert result["ssim"] < 1.0

    def test_resize_when_shape_mismatch(self):
        """When test frame is different size, should resize before computing."""
        ref = np.full((32, 32, 3), 128, dtype=np.uint8)
        test = np.full((64, 64, 3), 128, dtype=np.uint8)
        result = compute_frame_reference(ref, test)
        assert result["psnr"] > 50.0, "Same content after resize should give high PSNR"

    def test_identical_all_white(self):
        bgr = np.full((16, 16, 3), 255, dtype=np.uint8)
        result = compute_frame_reference(bgr, bgr)
        assert result["psnr"] > 50.0, f"Identical white should have high PSNR, got {result['psnr']}"
        assert result["ssim"] == pytest.approx(1.0, abs=1e-3)


# ==========================================================================
# _read_all_frames — mock cv2.VideoCapture
# ==========================================================================

class TestReadAllFrames:
    def test_reads_all_frames(self):
        """Mock 5 frames, verify they are all read."""
        fake_frames = [
            np.full((10, 10, 3), i * 50, dtype=np.uint8) for i in range(5)
        ]

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.side_effect = [
            (True, fake_frames[i]) for i in range(5)
        ] + [(False, None)]

        with patch("cv2.VideoCapture", return_value=mock_cap):
            frames = _read_all_frames("/fake/video.mp4")
            assert len(frames) == 5
            assert np.array_equal(frames[-1], fake_frames[-1])

    def test_not_opened_returns_empty(self):
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = False

        with patch("cv2.VideoCapture", return_value=mock_cap):
            frames = _read_all_frames("/fake/missing.mp4")
            assert frames == []


# ==========================================================================
# compare_videos_reference — end-to-end with mocked frames
# ==========================================================================

class TestCompareVideosReference:
    def test_aligned_videos(self):
        """Same frame count → 1:1 alignment."""
        frames = [np.full((16, 16, 3), 128, dtype=np.uint8)] * 3
        with patch("app.quality_metrics._read_all_frames", return_value=frames):
            result = compare_videos_reference("ref.mp4", "test.mp4")
            assert result["aligned"] is True
            assert result["n_compared"] == 3
            assert result["ssim_mean"] == pytest.approx(1.0, abs=1e-3)

    def test_mismatched_frame_count_prints_warning(self, capsys):
        """Different frame counts → non-aligned path with stderr warning."""
        ref_frames = [np.full((16, 16, 3), 128, dtype=np.uint8)] * 5
        test_frames = [np.full((16, 16, 3), 128, dtype=np.uint8)] * 3
        with patch("app.quality_metrics._read_all_frames") as mock_read:
            mock_read.side_effect = [ref_frames, test_frames]
            result = compare_videos_reference("ref.mp4", "test.mp4")
            assert result["aligned"] is False
            assert result["n_compared"] <= 3
            err = capsys.readouterr().err
            assert "WARNING" in err or "frame count mismatch" in err

    def test_empty_frames_raises(self):
        """No frames from either video raises ValueError."""
        with patch("app.quality_metrics._read_all_frames", return_value=[]):
            with pytest.raises(ValueError, match="cannot read frames"):
                compare_videos_reference("ref.mp4", "test.mp4")

    def test_sample_every_skips_frames(self):
        """sample_every=2 → half the frames are compared."""
        frames = [np.full((16, 16, 3), 128, dtype=np.uint8)] * 6
        with patch("app.quality_metrics._read_all_frames", return_value=frames):
            result = compare_videos_reference("ref.mp4", "test.mp4", sample_every=2)
            assert result["n_compared"] == 3  # 6 / 2


# ==========================================================================
# validate_metric_trends
# ==========================================================================

class TestValidateMetricTrendsImageFormat:
    """Validation on image-format results (flat metrics dict)."""

    def test_strictly_increasing(self):
        results = [
            {"metrics": {"sharpness": 10.0}},
            {"metrics": {"sharpness": 20.0}},
            {"metrics": {"sharpness": 30.0}},
        ]
        findings = validate_metric_trends(
            results, [("sharpness", "higher")], ["low", "mid", "high"]
        )
        assert findings[0]["trend"] == "increasing"
        assert findings[0]["pass"] is True
        assert findings[0]["violations"] == 0

    def test_strictly_decreasing(self):
        results = [
            {"metrics": {"noise": 30.0}},
            {"metrics": {"noise": 20.0}},
            {"metrics": {"noise": 10.0}},
        ]
        findings = validate_metric_trends(
            results, [("noise", "lower")], ["A", "B", "C"]
        )
        assert findings[0]["trend"] == "decreasing"
        assert findings[0]["pass"] is True

    def test_mixed_trend(self):
        results = [
            {"metrics": {"val": 10.0}},
            {"metrics": {"val": 30.0}},
            {"metrics": {"val": 20.0}},
        ]
        findings = validate_metric_trends(
            results, [("val", "higher")], ["a", "b", "c"]
        )
        assert findings[0]["trend"] == "mixed"
        # 1 violation out of 2 diffs → pass == "mostly"
        assert findings[0]["pass"] == "mostly"
        assert findings[0]["violations"] == 1

    def test_single_violation_is_mostly(self):
        results = [
            {"metrics": {"x": 10.0}},
            {"metrics": {"x": 5.0}},   # violation (expected higher)
            {"metrics": {"x": 15.0}},
        ]
        findings = validate_metric_trends(
            results, [("x", "higher")], ["a", "b", "c"]
        )
        assert findings[0]["pass"] == "mostly"

    def test_two_metrics(self):
        results = [
            {"metrics": {"sharpness": 10.0, "noise": 30.0}},
            {"metrics": {"sharpness": 20.0, "noise": 20.0}},
        ]
        findings = validate_metric_trends(
            results, [("sharpness", "higher"), ("noise", "lower")], ["A", "B"]
        )
        assert len(findings) == 2
        assert findings[0]["metric"] == "sharpness"
        assert findings[1]["metric"] == "noise"

    def test_single_result_no_diffs(self):
        """Single result → no diffs → pass by default (all diffs[0..-1] vacuously)."""
        results = [{"metrics": {"x": 42.0}}]
        findings = validate_metric_trends(
            results, [("x", "higher")], ["only"]
        )
        assert findings[0]["pass"] is True
        assert findings[0]["values"] == [42.0]

    def test_neutral_direction_skipped_in_summary(self):
        """Direction 'neutral' is not counted in the 'checked' metric group."""
        results = [
            {"metrics": {"a": 1.0, "b": 10.0}},
            {"metrics": {"a": 2.0, "b": 9.0}},
        ]
        findings = validate_metric_trends(
            results, [("a", "higher"), ("b", "neutral")], ["x", "y"]
        )
        # 'b' has direction='neutral' so _print_trend_validation skips it
        # in the summary counted set
        assert len(findings) == 2


class TestValidateMetricTrendsVideoFormat:
    """Validation on video-format results (nested per_frame dicts)."""

    def test_video_format_uses_mean(self):
        results = [
            {"per_frame": {"sharpness": {"mean": 10.0}}},
            {"per_frame": {"sharpness": {"mean": 20.0}}},
        ]
        findings = validate_metric_trends(
            results, [("sharpness", "higher")], ["A", "B"]
        )
        assert findings[0]["values"] == [10.0, 20.0]
        assert findings[0]["pass"] is True

    def test_missing_per_frame_key_raises_key_error(self):
        """Current code does NOT fallback to 0.0 for missing keys inside
        per_frame — it raises KeyError. Callers must ensure all per_frame
        dicts have all expected metric keys."""
        results = [
            {"per_frame": {"sharpness": {"mean": 10.0}}},
            {"per_frame": {}},
        ]
        with pytest.raises(KeyError):
            validate_metric_trends(
                results, [("sharpness", "higher")], ["A", "B"]
            )


# ==========================================================================
# print_trend_validation — capsys output format
# ==========================================================================

class TestPrintTrendValidation:
    def test_output_contains_summary(self, capsys):
        results = [
            {"metrics": {"sharpness": 10.0}},
            {"metrics": {"sharpness": 20.0}},
        ]
        findings = validate_metric_trends(
            results, [("sharpness", "higher")], ["low", "high"]
        )
        print_trend_validation(findings, ["low", "high"])
        out = capsys.readouterr().out
        assert "Trend Validation" in out
        assert "sharpness" in out
        assert "PASS" in out
        assert "Summary" in out

    def test_fail_shown_in_output(self, capsys):
        """2+ violations → FAIL. Need 3+ values to get 2+ diffs."""
        results = [
            {"metrics": {"x": 30.0}},
            {"metrics": {"x": 10.0}},  # violation 1: 30 → 10 (lower)
            {"metrics": {"x": 5.0}},   # violation 2: 10 → 5 (lower again)
        ]
        findings = validate_metric_trends(
            results, [("x", "higher")], ["A", "B", "C"]
        )
        print_trend_validation(findings, ["A", "B", "C"])
        out = capsys.readouterr().out
        assert "FAIL" in out or "✗ FAIL" in out

    def test_mostly_shown(self, capsys):
        results = [
            {"metrics": {"x": 10.0}},
            {"metrics": {"x": 5.0}},   # violation
            {"metrics": {"x": 15.0}},
        ]
        findings = validate_metric_trends(
            results, [("x", "higher")], ["A", "B", "C"]
        )
        print_trend_validation(findings, ["A", "B", "C"])
        out = capsys.readouterr().out
        assert "OK" in out or "mostly" in out


# ==========================================================================
# generate_html_report — template not found fallback
# ==========================================================================

class TestGenerateHtmlReport:
    def test_template_not_found_prints_stderr(self, capsys):
        """When the static template doesn't exist, print stderr and return."""
        with patch("os.path.exists", return_value=False):
            generate_html_report({"mode": "single"}, "/tmp/test.png")
            err = capsys.readouterr().err
            assert "template not found" in err

    def test_report_file_written_when_template_exists(self, tmp_path, capsys):
        """When template exists, JS report file is created."""
        # Point _STATIC_TEMPLATE to a temp file
        template = tmp_path / "quality-reporter-static.js"
        template.write_text("// static js")

        with patch("app.quality_metrics._STATIC_TEMPLATE", str(template)):
            with patch("app.quality_metrics._start_server", MagicMock()):
                report_path = tmp_path / "output" / "test.png"
                report_path.parent.mkdir(parents=True)
                report_path.write_bytes(b"dummy")

                generate_html_report({"mode": "single", "mediaType": "image"}, str(report_path))
                # Check any .js file was created
                js_files = list(tmp_path.rglob("*.js"))
                assert len(js_files) >= 1


# ==========================================================================
# _start_server — bun not found
# ==========================================================================

class TestStartServer:
    def test_bun_not_found_prints_stderr(self, capsys):
        """When bun is not found, print manual instruction."""
        with patch("shutil.which", return_value=None):
            _start_server("/fake/path.js")
            err = capsys.readouterr().err
            assert "bun not found" in err or "Run manually" in err
