"""quality_metrics — shared no-reference quality analysis for images and video frames.

Provides unified per-frame metric computation (7 metrics), HTML report generation,
and metric trend validation used by both `image quality` and `video quality` commands.

Exports:
  analyze_frame(gray, bgr_frame) -> dict          — 7 no-reference metrics
  generate_html_report(data, ref_path)             — HTML report + Bun server launch
  validate_metric_trends(results, metrics_def, labels) -> list  — monotonic trend checks
  print_trend_validation(findings, labels)         — pretty-print trend results

Metric Limitations (validated via degradation self-test):
  - Sharpness (Laplacian σ²) measures total HF energy, NOT just edge clarity.
    Adding Gaussian noise DRAMATICALLY increases sharpness (noise adds HF energy).
    Always cross-check with noise_sigma/SNR — high noise_sigma + high sharpness = noise.
  - JPEG blockiness is unreliable at high resolution (≥2MP): JPEG smoothing can
    *reduce* measured boundary differences at the 8px grid.
  - JPEG sharpness is unreliable on video: JPEG ringing increases Laplacian variance.
    Use edge_density for JPEG quality assessment instead.
  - JPEG compression smooths HF noise, so heavily compressed images may show *lower*
    noise_sigma than the original — this is correct behavior.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# Template path
# ---------------------------------------------------------------------------

_STATIC_TEMPLATE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "scripts", "quality-reporter-static.js",
)


# ---------------------------------------------------------------------------
# Core: per-frame analysis
# ---------------------------------------------------------------------------

def analyze_frame(gray: np.ndarray, bgr_frame: np.ndarray) -> dict:
    """Compute all 7 no-reference quality metrics on a single frame.

    Args:
        gray: float64 grayscale array (caller converts via cvtColor + astype).
        bgr_frame: original BGR uint8 frame (for HSV saturation).

    Returns:
        Dict with 7 metrics:
          sharpness, edge_density, contrast, noise_sigma,
          snr_db, blockiness, saturation_std
    """
    height, width = gray.shape[:2]

    # 1. Sharpness — Laplacian variance
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    sharpness = float(lap.var())

    # 2. Edge density — Sobel gradient magnitude mean
    sobel_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    edge_density = float(np.sqrt(sobel_x**2 + sobel_y**2).mean())

    # 3. Contrast — luminance standard deviation
    contrast = float(gray.std())

    # 4. Noise — MAD-based sigma estimation
    noise_sigma = float(np.median(np.abs(lap - np.median(lap))) * 1.4826)

    # 5. SNR (dB)
    signal_mean = float(np.mean(gray))
    noise_est = noise_sigma if noise_sigma > 0 else 0.01
    snr_db = float(20 * np.log10(signal_mean / noise_est)) if signal_mean > 0 else 0.0

    # 6. Blockiness — 8×8 boundary artifacts
    blockiness = _compute_blockiness(gray, height, width)

    # 7. Color saturation std
    hsv = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2HSV)
    saturation_std = float(np.std(hsv[:, :, 1]))

    return {
        "sharpness": sharpness,
        "edge_density": edge_density,
        "contrast": contrast,
        "noise_sigma": noise_sigma,
        "snr_db": snr_db,
        "blockiness": blockiness,
        "saturation_std": saturation_std,
    }


def _compute_blockiness(gray: np.ndarray, height: int, width: int) -> float:
    """Measure compression artifacts at 8×8 block boundaries."""
    h8 = (height // 8) * 8
    w8 = (width // 8) * 8
    if h8 < 16 or w8 < 16:
        return 0.0
    blocks = gray[:h8, :w8].reshape(h8 // 8, 8, w8 // 8, 8)
    horiz_diff = float(np.abs(np.diff(blocks, axis=2)).mean())
    vert_diff = float(np.abs(np.diff(blocks, axis=1)).mean())
    return horiz_diff + vert_diff


# ---------------------------------------------------------------------------
# HTML report generation (shared by image-quality and video-quality)
# ---------------------------------------------------------------------------

def generate_html_report(report_data: dict, reference_path: str):
    """Generate JS+HTML quality report file and launch Bun server.

    Args:
        report_data: dict with mode, mediaType, lang, videos/images, etc.
        reference_path: file path used to determine output directory.
    """
    if not os.path.exists(_STATIC_TEMPLATE):
        print(f"[quality] HTML template not found: {_STATIC_TEMPLATE}", file=__import__('sys').stderr)
        print("[quality] Skipping HTML report (run from project root)", file=__import__('sys').stderr)
        return

    out_dir = os.path.dirname(os.path.abspath(reference_path))
    if out_dir.endswith(".manifest.json") or out_dir.endswith(".mp4") or out_dir.endswith(".png"):
        out_dir = os.path.dirname(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    mode = report_data.get("mode", "single")
    media = report_data.get("mediaType", "video")
    out_js = os.path.join(out_dir, f"quality-reporter-{media}-{mode}-{ts}.js")

    config_json = json.dumps(report_data, ensure_ascii=False, default=str)
    config_js = (
        f"// AUTO-GENERATED — regenerate with: run.py {media} quality ...\n"
        f"// Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
        f"const CONFIG = {config_json};\n"
    )

    with open(_STATIC_TEMPLATE, encoding="utf-8") as f:
        static_js = f.read()

    with open(out_js, "w", encoding="utf-8") as f:
        f.write(config_js)
        f.write("\n\n")
        f.write(static_js)

    print(f"[quality] HTML report: {out_js}")

    _start_server(out_js)


def _start_server(out_js: str):
    """Launch the Bun HTTP server and open browser."""
    bun = shutil.which("bun")
    if not bun:
        print("[quality] bun not found — install from https://bun.sh", file=__import__('sys').stderr)
        print(f"[quality] Run manually: bun run {out_js}", file=__import__('sys').stderr)
        return

    log_fd, log_path = tempfile.mkstemp(prefix="quality-report-", suffix=".log")
    os.close(log_fd)
    proc = subprocess.Popen(
        [bun, "run", out_js],
        stdout=open(log_path, "w"),
        stderr=subprocess.STDOUT,
    )
    url = None
    for _ in range(50):
        time.sleep(0.1)
        with open(log_path) as f:
            for line in f:
                if "Serving at" in line:
                    url = line.strip().split()[-1]
                    break
        if url:
            break
    if url:
        subprocess.Popen(["open", url])
        print(f"[quality] Opened {url}")
        print(f"[quality] Log: {log_path}  (PID: {proc.pid})")
    else:
        print(f"[quality] Server started (PID: {proc.pid}), log: {log_path}")


# ---------------------------------------------------------------------------
# Metric trend validation (shared by image-quality and video-quality self-tests)
# ---------------------------------------------------------------------------

def validate_metric_trends(
    results: list,
    metrics_def: list,
    labels: list,
) -> list:
    """Validate metric trends across ordered results (index 0 = lowest quality).

    Args:
        results: Ordered list of metric dicts. For image: results[i]["metrics"].
                 For video: results[i]["per_frame"][key]["mean"].
        metrics_def: List of (key, direction) tuples.
                     direction: "higher" = better when higher, "lower" = better when lower.
        labels: Human-readable labels for each result (same order).

    Returns:
        List of finding dicts:
          {"metric": str, "direction": str, "expected": str, "trend": str,
           "values": list[float], "violations": int, "pass": bool|str}
    """
    findings = []

    for key, direction in metrics_def:
        # Extract values — handle both image format and video format
        values = []
        for r in results:
            if "metrics" in r:
                # Image format: flat metrics dict
                values.append(float(r["metrics"][key]))
            elif "per_frame" in r:
                # Video format: nested per_frame with stats
                values.append(float(r["per_frame"][key]["mean"]))
            else:
                values.append(0.0)

        # Compute consecutive differences
        diffs = [values[i + 1] - values[i] for i in range(len(values) - 1)]

        # Determine actual trend
        if all(d > 0 for d in diffs):
            trend = "increasing"
        elif all(d < 0 for d in diffs):
            trend = "decreasing"
        else:
            trend = "mixed"

        # Count violations against expected direction
        violations = 0
        for d in diffs:
            if direction == "higher" and d < 0:
                violations += 1
            elif direction == "lower" and d > 0:
                violations += 1

        # Pass determination
        if violations == 0:
            passed = True
        elif violations == 1:
            passed = "mostly"
        else:
            passed = False

        expected = "increasing" if direction == "higher" else "decreasing"

        findings.append({
            "metric": key,
            "direction": direction,
            "expected": expected,
            "trend": trend,
            "values": values,
            "violations": violations,
            "pass": passed,
        })

    return findings


def print_trend_validation(findings: list, labels: list):
    """Pretty-print trend validation results to terminal.

    Args:
        findings: Output from validate_metric_trends().
        labels: Labels for each variant.
    """
    print(f"\n[quality] {'═' * 10} Trend Validation {'═' * 10}")

    col_metric = 24
    label_width = max(len(str(l)) for l in labels) + 4

    # Header
    header = f"  {'Metric':<{col_metric}}"
    for l in labels:
        header += f" {str(l):>{label_width}}"
    header += f"  {'Trend':>12}  {'Expected':>10}  {'Result':>8}"
    print(header)
    print(f"  {'─' * col_metric}  " + f"{'─' * (label_width + 1)} " * len(labels) + f"{'─' * 12}  {'─' * 10}  {'─' * 8}")

    for f in findings:
        row = f"  {f['metric']:<{col_metric}}"
        for v in f["values"]:
            if abs(v) < 10:
                row += f" {v:>{label_width}.2f}"
            else:
                row += f" {v:>{label_width}.1f}"

        row += f"  {f['trend']:>12}  {f['expected']:>10}"

        if f["pass"] is True:
            row += f"  {'✓ PASS':>8}"
        elif f["pass"] == "mostly":
            row += f"  {'~ OK':>8}"
        else:
            row += f"  {'✗ FAIL':>8}"

        print(row)

    # Summary
    passed = sum(1 for f in findings if f["pass"] is True)
    mostly = sum(1 for f in findings if f["pass"] == "mostly")
    failed = sum(1 for f in findings if f["pass"] is False)
    total = len(findings)

    # Skip neutral metrics for summary
    checked = [f for f in findings if f["direction"] != "neutral"]
    checked_pass = sum(1 for f in checked if f["pass"] is True)
    checked_total = len(checked)

    print(f"\n  Summary: {checked_pass}/{checked_total} trends match expected direction", end="")
    if mostly:
        print(f"  ({mostly} mostly OK)", end="")
    if failed:
        print(f"  ({failed} FAILED)", end="")
    print()
