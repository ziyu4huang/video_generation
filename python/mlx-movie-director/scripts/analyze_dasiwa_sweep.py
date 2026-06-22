#!/usr/bin/env python3
"""analyze_dasiwa_sweep.py — aggregate quality_report.json files from a dasiwa parameter sweep.

Usage:
    python/venv/bin/python python/mlx-movie-director/scripts/analyze_dasiwa_sweep.py <SWEEP_ROOT>
    python/venv/bin/python python/mlx-movie-director/scripts/analyze_dasiwa_sweep.py <SWEEP_ROOT> --frames 5
    python/venv/bin/python python/mlx-movie-director/scripts/analyze_dasiwa_sweep.py <SWEEP_ROOT> --csv

Discovers all quality_report.json files under SWEEP_ROOT, extracts metrics, and prints:
  1. Markdown comparison table (audio + video quality + timing)
  2. Per-frame sharpness distribution (min/p25/median/p75/max) sampled from each mp4
  3. Optional voice_metrics (snr, f0, speech_activity) if scipy is available

SWEEP_ROOT layout (produced by sweep_dasiwa_params.sh):
  <SWEEP_ROOT>/<cell>/t2i2v_YYYYMMDD_HHMMSS/quality_report.json
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from typing import Any

# Allow importing from the mlx-movie-director package
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)


# ---------------------------------------------------------------------------
# Frame sampling — per-frame sharpness distribution from mp4
# ---------------------------------------------------------------------------

def _sample_frame_sharpness(mp4_path: str, n_frames: int = 5) -> dict[str, float] | None:
    """Sample n_frames evenly from mp4, return sharpness percentiles.

    Returns None if cv2 unavailable or mp4 not found.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None

    if not os.path.isfile(mp4_path):
        return None

    cap = cv2.VideoCapture(mp4_path)
    if not cap.isOpened():
        return None

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total < 1:
        cap.release()
        return None

    indices = [int(total * i / max(n_frames - 1, 1)) for i in range(n_frames)]
    indices = list(dict.fromkeys(min(i, total - 1) for i in indices))  # dedup + clamp

    sharpness_vals: list[float] = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(float)
        lap = cv2.Laplacian(gray, cv2.CV_64F)
        sharpness_vals.append(float(lap.var()))
    cap.release()

    if not sharpness_vals:
        return None

    v = sorted(sharpness_vals)
    n = len(v)
    return {
        "min":    round(v[0], 1),
        "p25":    round(v[max(0, n // 4)], 1),
        "median": round(v[n // 2], 1),
        "p75":    round(v[min(n - 1, 3 * n // 4)], 1),
        "max":    round(v[-1], 1),
        "n":      n,
    }


# ---------------------------------------------------------------------------
# Voice metrics (optional — needs scipy)
# ---------------------------------------------------------------------------

def _voice_metrics(mp4_path: str) -> dict[str, float] | None:
    try:
        from app.voice_metrics import compute_voice_metrics
        return compute_voice_metrics(mp4_path)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def _find_reports(sweep_root: str) -> list[tuple[str, str]]:
    """Return list of (cell_name, report_path) sorted by cell name."""
    pattern = os.path.join(sweep_root, "*", "t2i2v_*", "quality_report.json")
    found = []
    for path in sorted(glob.glob(pattern)):
        # cell name = immediate subdirectory of sweep_root
        rel = os.path.relpath(path, sweep_root)
        cell = rel.split(os.sep)[0]
        found.append((cell, path))
    return found


def _find_mp4(report_path: str) -> str | None:
    out_dir = os.path.dirname(report_path)
    mp4s = sorted(glob.glob(os.path.join(out_dir, "*.mp4")))
    return mp4s[0] if mp4s else None


def _timing_from_log(sweep_root: str, cell: str) -> str:
    """Read elapsed time from results_index.txt if available."""
    idx = os.path.join(sweep_root, "results_index.txt")
    if not os.path.isfile(idx):
        return "—"
    for line in open(idx):
        parts = line.strip().split("|")
        if len(parts) >= 3 and parts[1] == cell:
            return parts[2]
    return "—"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _safe(d: dict, *keys: str, default: Any = None) -> Any:
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k, default)
    return d


def analyze(sweep_root: str, n_frames: int = 5, with_voice: bool = False, csv_out: bool = False) -> None:
    reports = _find_reports(sweep_root)
    if not reports:
        print(f"No quality_report.json found under: {sweep_root}", file=sys.stderr)
        sys.exit(1)

    print(f"Sweep: {sweep_root}")
    print(f"Found {len(reports)} report(s)\n")

    rows: list[dict] = []
    frame_data: list[tuple[str, dict]] = []
    voice_data: list[tuple[str, dict]] = []

    for cell, rpath in reports:
        with open(rpath) as f:
            r = json.load(f)

        audio = r.get("audio_asr") or {}
        sig   = r.get("signal") or {}
        vlm   = r.get("vlm") or {}

        row = {
            "cell":            cell,
            "verdict":         r.get("verdict", "—"),
            "static":          "Y" if r.get("static_flag") else "N",
            # Audio
            "lang_ok":         "✓" if audio.get("lang_ok") else ("✗" if audio.get("lang_ok") is False else "?"),
            "content_match":   "✓" if audio.get("content_match") else ("✗" if audio.get("content_match") is False else "?"),
            "content_ratio":   f"{audio.get('content_ratio', 0):.2f}" if audio.get("content_ratio") is not None else "—",
            "transcript":      (audio.get("transcript") or "")[:40],
            # Signal (video frames)
            "sharpness":       f"{sig.get('sharpness_mean', 0):.0f}" if sig.get("sharpness_mean") is not None else "—",
            "snr_db":          f"{sig.get('snr_db_mean', 0):.1f}" if sig.get("snr_db_mean") is not None else "—",
            "flicker":         f"{sig.get('flicker_mean', 0):.1f}" if sig.get("flicker_mean") is not None else "—",
            "blockiness":      f"{sig.get('blockiness_mean', 0):.2f}" if sig.get("blockiness_mean") is not None else "—",
            # VLM
            "vlm_overall":     f"{vlm.get('overall', 0):.1f}" if vlm.get("overall") is not None else "—",
            "vlm_coherence":   f"{vlm.get('temporal_coherence', 0):.1f}" if vlm.get("temporal_coherence") is not None else "—",
            # Timing
            "time":            _timing_from_log(sweep_root, cell),
        }
        rows.append(row)

        # Frame sampling
        mp4 = _find_mp4(rpath)
        if mp4:
            fs = _sample_frame_sharpness(mp4, n_frames)
            if fs:
                frame_data.append((cell, fs))
            if with_voice:
                vm = _voice_metrics(mp4)
                if vm:
                    voice_data.append((cell, vm))

    # ── Markdown table ───────────────────────────────────────────────────────
    cols = [
        ("Cell",          "cell",          16),
        ("Verdict",       "verdict",        6),
        ("Static",        "static",         6),
        ("Lang✓",         "lang_ok",        6),
        ("Match✓",        "content_match",  7),
        ("Ratio",         "content_ratio",  5),
        ("Sharp",         "sharpness",      6),
        ("SNR(v)dB",      "snr_db",         8),
        ("Flicker",       "flicker",        7),
        ("Block",         "blockiness",     6),
        ("VLM",           "vlm_overall",    5),
        ("Coh",           "vlm_coherence",  5),
        ("Time",          "time",           8),
    ]

    header = " | ".join(f"{h:<{w}}" for h, _, w in cols)
    sep    = "-|-".join("-" * w for _, _, w in cols)
    print("## Quality Comparison Table\n")
    print(f"| {header} |")
    print(f"| {sep} |")
    for row in rows:
        line = " | ".join(f"{row[k]:<{w}}" for _, k, w in cols)
        print(f"| {line} |")

    print()
    print("> **Signal (video):** sharpness = Laplacian σ² (higher=sharper), SNR(v) = luminance SNR,")
    print("> flicker = mean inter-frame MAD, blockiness = 8×8 boundary artifacts.")
    print("> All signal metrics averaged over ALL decoded frames.")

    # ── Per-frame sharpness distribution ─────────────────────────────────────
    if frame_data:
        print(f"\n## Per-frame Sharpness Distribution (sampled {n_frames} frames)\n")
        hdr = f"{'Cell':<20} {'Min':>7} {'P25':>7} {'Median':>8} {'P75':>7} {'Max':>7} {'N':>3}"
        print(hdr)
        print("-" * len(hdr))
        for cell, fs in frame_data:
            print(f"{cell:<20} {fs['min']:>7.0f} {fs['p25']:>7.0f} {fs['median']:>8.0f} "
                  f"{fs['p75']:>7.0f} {fs['max']:>7.0f} {fs['n']:>3}")
        print()
        print("> Low median + high max = sharp edges but inconsistent motion or static frames.")
        print("> Low P25 = some blurry frames (motion blur or model instability).")

    # ── Voice metrics ────────────────────────────────────────────────────────
    if voice_data:
        print(f"\n## Voice Quality Metrics\n")
        vm_cols = [
            ("Cell",          "cell",            20),
            ("SNR_a(dB)",     "snr_db",           10),
            ("Speech%",       "speech_activity",  8),
            ("F0_mean(Hz)",   "f0_mean",           11),
            ("F0_st_std",     "f0_st_std",         9),
            ("DynRange",      "dynamic_range_db",  9),
            ("Onset/s",       "onset_rate",        8),
        ]
        hdr2 = " | ".join(f"{h:<{w}}" for h, _, w in vm_cols)
        sep2  = "-|-".join("-" * w for _, _, w in vm_cols)
        print(f"| {hdr2} |")
        print(f"| {sep2} |")
        for cell, vm in voice_data:
            vals = {"cell": cell}
            vals["snr_db"]           = f"{vm.get('snr_db', 0):.1f}"
            vals["speech_activity"]  = f"{vm.get('speech_activity', 0):.2f}"
            vals["f0_mean"]          = f"{vm.get('f0_mean', 0):.1f}"
            vals["f0_st_std"]        = f"{vm.get('f0_st_std', 0):.2f}"
            vals["dynamic_range_db"] = f"{vm.get('dynamic_range_db', 0):.1f}"
            vals["onset_rate"]       = f"{vm.get('onset_rate', 0):.2f}"
            line2 = " | ".join(f"{vals[k]:<{w}}" for _, k, w in vm_cols)
            print(f"| {line2} |")
        print()
        print("> SNR_a = audio SNR (speech vs noise floor); f0_st_std = pitch variation in semitones")
        print("> (low f0_st_std = monotone/robotic); speech_activity = fraction of voiced frames.")

    # ── CSV output ────────────────────────────────────────────────────────────
    if csv_out:
        csv_path = os.path.join(sweep_root, "sweep_results.csv")
        import csv
        fieldnames = [k for _, k, _ in cols]
        with open(csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nCSV saved: {csv_path}")

    # ── Decision helper ───────────────────────────────────────────────────────
    print("\n## Pass/Fail Summary\n")
    pass_cells = [r["cell"] for r in rows if r["lang_ok"] == "✓" and r["content_match"] == "✓"]
    fail_cells = [r["cell"] for r in rows if r["lang_ok"] == "✗" or r["content_match"] == "✗"]
    print(f"Audio PASS (lang_ok=✓ AND content_match=✓): {pass_cells or ['none']}")
    print(f"Audio FAIL:                                  {fail_cells or ['none']}")

    # Best sharpness among audio-passing cells
    passing_rows = [r for r in rows if r["cell"] in pass_cells]
    if passing_rows:
        try:
            best = max(passing_rows, key=lambda r: float(r["sharpness"]) if r["sharpness"] != "—" else 0)
            print(f"Highest sharpness among passing cells:       {best['cell']} ({best['sharpness']})")
        except (ValueError, TypeError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze dasiwa parameter sweep results")
    parser.add_argument("sweep_root", help="Root directory of the sweep (from sweep_dasiwa_params.sh)")
    parser.add_argument("--frames", type=int, default=5, help="Number of frames to sample per video (default: 5)")
    parser.add_argument("--voice", action="store_true", help="Include voice_metrics (requires scipy)")
    parser.add_argument("--csv", action="store_true", help="Write sweep_results.csv to sweep_root")
    args = parser.parse_args()

    analyze(args.sweep_root, n_frames=args.frames, with_voice=args.voice, csv_out=args.csv)


if __name__ == "__main__":
    main()
