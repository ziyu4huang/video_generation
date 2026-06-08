"""video-quality — No-reference video quality analysis using traditional signal processing.

Measures noise, sharpness, compression artifacts, and temporal stability
without any AI models. Uses pure OpenCV + NumPy.

Sub-actions:
  analyze (default) — Analyze one or more existing videos
  self-test         — Generate distilled + HQ videos, then compare

Usage:
  run.py video quality --quality-inputs video.mp4
  run.py video quality --quality-inputs A.mp4 B.mp4 --quality-labels "Baseline,LoRA"
  run.py video quality --quality-inputs video.manifest.json
  run.py video quality --self-test --test-prompt forest-hiker
  run.py video quality --self-test --test-prompt beach-walk --seed 99

Exports: add_quality_args(), run_quality()
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import types
from datetime import datetime, timezone

import cv2
import numpy as np

from app import config as cfg
from app.test_prompts_video import get_test_prompt, list_test_prompt_names

_RUN_PY = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "run.py")
)

_STATIC_TEMPLATE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "scripts", "quality-reporter-static.js",
)


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "No-reference video quality analysis (noise, sharpness, artifacts)",
    "description": (
        "Analyze video quality using traditional signal processing metrics.\n\n"
        "Metrics: sharpness, noise (σ), SNR, blockiness, temporal flicker.\n\n"
        "Modes:\n"
        "  analyze (default)  — Analyze existing video file(s)\n"
        "  self-test          — Generate distilled + HQ videos, then compare\n\n"
        "Examples:\n"
        "  run.py video quality --quality-inputs output/video.mp4\n"
        "  run.py video quality --quality-inputs A.mp4 B.mp4 --quality-labels 'Baseline,HQ'\n"
        "  run.py video quality --quality-inputs output/video.manifest.json\n"
        "  run.py video quality --self-test --test-prompt forest-hiker\n"
    ),
}


def add_quality_args(parser):
    """Register quality-specific CLI arguments."""
    # Video paths as option (not positional — avoids conflict with review_action positional)
    parser.add_argument(
        "--quality-inputs", nargs="+", default=[], metavar="VIDEO",
        help="Video file(s) or manifest.json(s) to analyze",
    )

    # Self-test mode (uses shared --test-prompt and --seed from generate args)
    parser.add_argument(
        "--self-test", action="store_true", default=False,
        help="Auto-generate distilled + HQ videos with same prompt/seed, then compare. "
             "Use --test-prompt NAME to select the built-in prompt (default: forest-hiker) "
             "and --seed N to control generation (default: 42).",
    )

    # Analysis options
    parser.add_argument(
        "--sample-every", type=int, default=1,
        help="Sample every Nth frame for faster analysis (default: 1 = all)",
    )
    parser.add_argument(
        "--quality-labels", type=str, default=None,
        help="Comma-separated labels for A/B comparison, e.g. 'Baseline,LoRA'",
    )
    parser.add_argument(
        "--quality-json", type=str, default=None, metavar="PATH",
        help="Save JSON report to file",
    )
    parser.add_argument(
        "--no-html", action="store_true", default=False,
        help="Write JSON metrics only — skip HTML report and browser auto-launch",
    )
    parser.add_argument(
        "--quality-lang", type=str, default="en",
        choices=["en", "zh_TW"],
        help="HTML report language (default: en)",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_quality(args):
    """Dispatch to analyze or self-test mode."""
    if getattr(args, "self_test", False):
        _run_self_test(args)
    else:
        videos = getattr(args, "quality_inputs", [])
        if not videos:
            print("ERROR: provide --quality-inputs or use --self-test", file=sys.stderr)
            print("Usage: run.py video quality --quality-inputs video.mp4 [video2.mp4 ...]", file=sys.stderr)
            print("       run.py video quality --self-test --test-prompt forest-hiker", file=sys.stderr)
            sys.exit(1)
        _run_analyze(args, videos)


# ---------------------------------------------------------------------------
# Analyze mode
# ---------------------------------------------------------------------------

def _run_analyze(args, video_paths: list[str]):
    """Analyze one or more existing videos."""
    # Resolve paths: manifests → .mp4
    resolved = []
    for p in video_paths:
        if p.endswith(".manifest.json"):
            mp4 = _resolve_manifest_to_mp4(p)
            if mp4:
                resolved.append(mp4)
            else:
                print(f"WARNING: could not find video for {p}, skipping", file=sys.stderr)
        else:
            if not os.path.exists(p):
                print(f"ERROR: file not found: {p}", file=sys.stderr)
                sys.exit(1)
            resolved.append(p)

    if not resolved:
        print("ERROR: no videos to analyze", file=sys.stderr)
        sys.exit(1)

    # Analyze each video
    sample_every = getattr(args, "sample_every", 1)
    results = []
    for vp in resolved:
        print(f"\n[quality] Analyzing: {os.path.basename(vp)}")
        report = analyze_video(vp, sample_every=sample_every)
        results.append(report)
        _print_single_report(report)

    # Labels
    labels_arg = getattr(args, "quality_labels", None)
    labels = _make_labels(labels_arg, len(results))

    # Attach labels
    for r, label in zip(results, labels):
        r["label"] = label

    # A/B comparison if multiple
    if len(results) > 1:
        _print_comparison(results)

    # JSON report
    json_path = getattr(args, "quality_json", None)
    if json_path:
        report_data = {
            "mode": "compare" if len(results) > 1 else "single",
            "lang": getattr(args, "quality_lang", "en"),
            "videos": results,
        }
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")
    else:
        report_data = {
            "mode": "compare" if len(results) > 1 else "single",
            "lang": getattr(args, "quality_lang", "en"),
            "videos": results,
        }

    # HTML report
    if not getattr(args, "no_html", False):
        _generate_html_report(report_data, resolved[0])


# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

_SELF_TEST_PIPELINES = [
    {
        "label": "Distilled",
        "flags": ["--distilled"],
        "cfg_scale": 1.0,
        "stage1_steps": 8,
    },
    {
        "label": "HQ",
        "flags": ["--hq"],
        "cfg_scale": 5.0,
        "stage1_steps": 15,
    },
]


def _run_self_test(args):
    """Generate distilled + HQ videos with same prompt/seed, then compare."""
    tp_name = getattr(args, "test_prompt", None) or "forest-hiker"
    seed = getattr(args, "seed", 42)
    sample_every = getattr(args, "sample_every", 1)

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]

    print(f"[quality] ═══ Self-Test: Distilled vs HQ ═══")
    print(f"[quality] Prompt: {tp_name} (seed={seed})")
    print(f"[quality] Prompt text: {prompt[:80]}…")

    # Generate videos sequentially
    manifest_paths = []
    for i, pcfg in enumerate(_SELF_TEST_PIPELINES):
        label = pcfg["label"]
        print(f"\n[quality] Generating {i+1}/{len(_SELF_TEST_PIPELINES)}: {label}…")

        before = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.manifest.json")))

        cmd = [
            sys.executable, _RUN_PY, "video", "generate",
            "--prompt", prompt,
            "--seed", str(seed),
            "--stage1-steps", str(pcfg["stage1_steps"]),
            "--cfg-scale", str(pcfg["cfg_scale"]),
            "--skip-gpu-lock",
            "--yes",
        ] + pcfg["flags"]

        result = subprocess.run(cmd, cwd=os.path.dirname(_RUN_PY))

        after = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.manifest.json")))
        new_manifests = sorted(after - before, key=os.path.getmtime)

        if result.returncode != 0 or not new_manifests:
            print(f"[quality] [{label}] FAILED (returncode={result.returncode})", file=sys.stderr)
            sys.exit(1)

        manifest_paths.append(new_manifests[-1])
        print(f"[quality] [{label}] OK — {os.path.basename(new_manifests[-1])}")

    # Analyze both
    results = []
    for mp, pcfg in zip(manifest_paths, _SELF_TEST_PIPELINES):
        mp4 = _resolve_manifest_to_mp4(mp)
        if not mp4:
            print(f"ERROR: could not find video for {mp}", file=sys.stderr)
            sys.exit(1)
        print(f"\n[quality] Analyzing {pcfg['label']}: {os.path.basename(mp4)}")
        report = analyze_video(mp4, sample_every=sample_every)
        report["label"] = pcfg["label"]
        results.append(report)
        _print_single_report(report)

    # Comparison
    _print_comparison(results)

    # Report data
    report_data = {
        "mode": "self-test",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": tp_name,
        "prompt": prompt,
        "seed": seed,
        "videos": results,
    }

    # JSON
    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    # HTML report
    if not getattr(args, "no_html", False):
        _generate_html_report(report_data, manifest_paths[0])


# ---------------------------------------------------------------------------
# Core metrics
# ---------------------------------------------------------------------------

def analyze_video(video_path: str, sample_every: int = 1) -> dict:
    """Analyze a single video and return quality metrics report."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"[quality]   {total_frames} frames, {width}×{height}, {fps:.1f}fps")
    if sample_every > 1:
        print(f"[quality]   Sampling every {sample_every} frames")

    # Collect per-frame metrics
    sharpness_list = []
    noise_sigma_list = []
    snr_db_list = []
    blockiness_list = []
    color_sat_std_list = []
    flicker_list = []
    consistency_list = []

    prev_gray = None
    frame_idx = 0
    analyzed = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_every == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float64)

            # 1. Sharpness — Laplacian variance
            lap = cv2.Laplacian(gray, cv2.CV_64F)
            sharpness = lap.var()
            sharpness_list.append(sharpness)

            # 2. Noise — MAD-based sigma estimation
            mad = np.median(np.abs(lap - np.median(lap))) * 1.4826
            noise_sigma_list.append(mad)

            # 3. SNR (dB)
            signal_mean = np.mean(gray)
            noise_est = mad if mad > 0 else 0.01
            snr = 20 * np.log10(signal_mean / noise_est) if signal_mean > 0 else 0
            snr_db_list.append(snr)

            # 4. Blockiness — 8×8 boundary artifacts
            h8 = (height // 8) * 8
            w8 = (width // 8) * 8
            if h8 >= 16 and w8 >= 16:
                blocks = gray[:h8, :w8].reshape(h8 // 8, 8, w8 // 8, 8)
                horiz_diff = np.abs(np.diff(blocks, axis=2)).mean()
                vert_diff = np.abs(np.diff(blocks, axis=1)).mean()
                blockiness_list.append(horiz_diff + vert_diff)
            else:
                blockiness_list.append(0)

            # 5. Color saturation std
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            color_sat_std_list.append(np.std(hsv[:, :, 1]))

            # 6. Temporal metrics (need previous frame)
            if prev_gray is not None:
                # Temporal flicker
                flicker = np.abs(gray - prev_gray).mean()
                flicker_list.append(flicker)

                # Temporal consistency (NCC)
                # Use a smaller region for matchTemplate (must be <= frame size)
                result = cv2.matchTemplate(
                    gray.astype(np.float32),
                    prev_gray.astype(np.float32),
                    cv2.TM_CCOEFF_NORMED,
                )
                consistency_list.append(float(result[0, 0]))

            prev_gray = gray.copy()
            analyzed += 1

            # Progress
            if analyzed % 10 == 0 or frame_idx == total_frames - 1:
                pct = min(100, int(frame_idx / max(1, total_frames) * 100))
                print(f"\r[quality]   Progress: {analyzed} frames analyzed ({pct}%)", end="", flush=True)

        frame_idx += 1

    cap.release()
    if analyzed > 0:
        print(f"\r[quality]   Done: {analyzed} frames analyzed          ")

    def _stats(values):
        if not values:
            return {"mean": 0, "min": 0, "max": 0}
        return {
            "mean": float(np.mean(values)),
            "min": float(np.min(values)),
            "max": float(np.max(values)),
        }

    return {
        "video": os.path.abspath(video_path),
        "video_basename": os.path.basename(video_path),
        "frames_total": total_frames,
        "frames_analyzed": analyzed,
        "sample_every": sample_every,
        "fps": fps,
        "resolution": [width, height],
        "per_frame": {
            "sharpness": {**_stats(sharpness_list), "values": sharpness_list},
            "noise_sigma": {**_stats(noise_sigma_list), "values": noise_sigma_list},
            "snr_db": {**_stats(snr_db_list), "values": snr_db_list},
            "blockiness": {**_stats(blockiness_list), "values": blockiness_list},
            "color_sat_std": {**_stats(color_sat_std_list), "values": color_sat_std_list},
        },
        "temporal": {
            "flicker_mean": float(np.mean(flicker_list)) if flicker_list else 0,
            "flicker_max": float(np.max(flicker_list)) if flicker_list else 0,
            "consistency_ncc": float(np.mean(consistency_list)) if consistency_list else 0,
            "flicker_values": flicker_list,
            "consistency_values": consistency_list,
        },
    }


# ---------------------------------------------------------------------------
# Terminal output
# ---------------------------------------------------------------------------

def _print_single_report(report: dict):
    """Print quality summary for a single video."""
    pf = report["per_frame"]
    tp = report["temporal"]

    print(f"  Per-frame averages:")
    print(f"    Sharpness (Laplacian σ²)  : {pf['sharpness']['mean']:>8.1f}  ↑ better")
    print(f"    Noise (Laplacian MAD σ)   : {pf['noise_sigma']['mean']:>8.2f}  ↓ better")
    print(f"    SNR (dB)                  : {pf['snr_db']['mean']:>8.1f}  ↑ better")
    print(f"    Blockiness (8×8)          : {pf['blockiness']['mean']:>8.1f}  ↓ better")
    print(f"    Color saturation σ        : {pf['color_sat_std']['mean']:>8.1f}  —")

    print(f"  Temporal:")
    print(f"    Flicker (mean)            : {tp['flicker_mean']:>8.1f}  ↓ better")
    print(f"    Flicker (max)             : {tp['flicker_max']:>8.1f}  ↓ better")
    print(f"    Frame consistency (NCC)   : {tp['consistency_ncc']:>8.3f}  ↑ better")


def _print_comparison(results: list[dict]):
    """Print side-by-side A/B comparison table."""
    labels = [r.get("label", chr(65 + i)) for i, r in enumerate(results)]
    n = len(results)

    # Determine winners for each metric
    metrics = [
        ("Sharpness", "sharpness", "higher"),
        ("Noise (MAD σ)", "noise_sigma", "lower"),
        ("SNR (dB)", "snr_db", "higher"),
        ("Blockiness", "blockiness", "lower"),
        ("Flicker (mean)", "flicker_mean", "lower"),
        ("Flicker (max)", "flicker_max", "lower"),
        ("Consistency (NCC)", "consistency_ncc", "higher"),
    ]

    # Header
    label_width = max(len(l) for l in labels) + 2
    metric_col = 22
    sep = "─" * metric_col + " " + ("─" * (label_width + 1)) * n + " " + "─" * 8

    header = f"  {'Metric':<{metric_col}}"
    for l in labels:
        header += f" {l:>{label_width}}"
    header += f" {'Winner':>8}"

    print(f"\n[quality] {'═' * 10} Comparison {'═' * 10}")
    print(header)
    print(f"  {sep}")

    for name, key, direction in metrics:
        row = f"  {name:<{metric_col}}"
        values = []
        for r in results:
            if key in r["per_frame"]:
                v = r["per_frame"][key]["mean"]
            else:
                v = r["temporal"][key]
            values.append(v)

        # Format values
        for v in values:
            if abs(v) < 10:
                row += f" {v:>{label_width}.2f}"
            else:
                row += f" {v:>{label_width}.1f}"

        # Determine winner
        if direction == "higher":
            best_idx = values.index(max(values))
        else:
            best_idx = values.index(min(values))
        winner = labels[best_idx]
        row += f" {winner:>8} ✓"

        print(row)

    print()


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------

def _generate_html_report(report_data: dict, reference_path: str):
    """Generate and launch HTML quality report."""
    if not os.path.exists(_STATIC_TEMPLATE):
        print(f"[quality] HTML template not found: {_STATIC_TEMPLATE}", file=sys.stderr)
        print("[quality] Skipping HTML report (run from project root)", file=sys.stderr)
        return

    out_dir = os.path.dirname(os.path.abspath(reference_path))
    if out_dir.endswith(".manifest.json") or out_dir.endswith(".mp4"):
        out_dir = os.path.dirname(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    mode = report_data.get("mode", "single")
    out_js = os.path.join(out_dir, f"quality-reporter-{mode}-{ts}.js")

    # Strip raw per-frame arrays for HTML (keep summary stats only)
    # HTML will inline the data for Chart.js
    html_data = _prepare_html_data(report_data)

    config_json = json.dumps(html_data, ensure_ascii=False, default=str)
    config_js = (
        f"// AUTO-GENERATED — regenerate with: run.py video quality ...\n"
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

    # Launch Bun server
    _start_server(out_js)


def _prepare_html_data(report_data: dict) -> dict:
    """Prepare data for HTML report — keep summary + per-frame values for charts."""
    videos = []
    for v in report_data.get("videos", []):
        vd = {
            "label": v.get("label", ""),
            "video_basename": v.get("video_basename", ""),
            "frames_analyzed": v.get("frames_analyzed", 0),
            "resolution": v.get("resolution", [0, 0]),
            "per_frame_summary": {},
            "per_frame_values": {},
            "temporal_summary": {},
        }
        # Per-frame summary (mean/min/max)
        for key, stats in v.get("per_frame", {}).items():
            vd["per_frame_summary"][key] = {
                "mean": stats["mean"],
                "min": stats["min"],
                "max": stats["max"],
            }
            vd["per_frame_values"][key] = stats.get("values", [])
        # Temporal summary
        tp = v.get("temporal", {})
        vd["temporal_summary"] = {
            "flicker_mean": tp.get("flicker_mean", 0),
            "flicker_max": tp.get("flicker_max", 0),
            "consistency_ncc": tp.get("consistency_ncc", 0),
            "flicker_values": tp.get("flicker_values", []),
            "consistency_values": tp.get("consistency_values", []),
        }
        videos.append(vd)

    return {
        "mode": report_data.get("mode", "single"),
        "lang": report_data.get("lang", "en"),
        "test_prompt": report_data.get("test_prompt"),
        "seed": report_data.get("seed"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "videos": videos,
    }


def _start_server(out_js: str):
    """Launch the Bun HTTP server and open browser."""
    bun = shutil.which("bun")
    if not bun:
        print("[quality] bun not found — install from https://bun.sh", file=sys.stderr)
        print(f"[quality] Run manually: bun run {out_js}", file=sys.stderr)
        return

    import tempfile
    import time

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
# Helpers
# ---------------------------------------------------------------------------

def _resolve_manifest_to_mp4(manifest_path: str) -> str | None:
    """Parse manifest.json to find the .mp4 file path."""
    if not os.path.exists(manifest_path):
        return None
    with open(manifest_path) as f:
        data = json.load(f)
    # Check output_files
    for of in (data.get("output_files") or []):
        p = of.get("path", "")
        if p.endswith(".mp4") and os.path.exists(p):
            return p
    # Fallback: same basename
    base = manifest_path.replace(".manifest.json", "")
    mp4 = base + ".mp4"
    if os.path.exists(mp4):
        return mp4
    return None


def _make_labels(labels_arg: str | None, n: int) -> list[str]:
    if labels_arg:
        parts = [p.strip() for p in labels_arg.split(",")]
        if len(parts) >= n:
            return parts[:n]
    return [chr(65 + i) for i in range(n)]
