"""quality_metrics — shared no-reference quality analysis for images and video frames.

Provides unified per-frame metric computation (7 metrics) and HTML report generation
used by both `image quality` and `video quality` commands.

Exports:
  analyze_frame(gray, bgr_frame) -> dict    — 7 no-reference metrics
  generate_html_report(data, ref_path)       — HTML report + Bun server launch
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
