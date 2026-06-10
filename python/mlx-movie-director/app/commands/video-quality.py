"""video-quality — No-reference video quality analysis with self-test modes.

Measures 7 per-frame spatial metrics + 3 temporal metrics using shared
app.quality_metrics (pure OpenCV + NumPy). No AI models needed.

Spatial metrics (per-frame, shared with image quality):
  sharpness, edge_density, contrast, noise_sigma, snr_db, blockiness, saturation_std

Temporal metrics (video-only):
  flicker_mean, flicker_max, consistency_ncc (frame-to-frame NCC)

Sub-actions:
  analyze (default)       — Analyze one or more existing videos or manifest.json
  self-test default       — Generate distilled (8 steps) vs HQ (15 steps), compare
  self-test steps-sweep   — Generate at 4/8/12/16 stage1_steps, validate quality trends
  self-test degradation   — Apply per-frame blur/noise/JPEG/downscale, validate metrics
  self-test restore-loop  — Degrade clean baseline → restore → SSIM/PSNR vs ground truth

Usage:
  run.py video quality --quality-inputs video.mp4
  run.py video quality --quality-inputs A.mp4 B.mp4 --quality-labels "Baseline,LoRA"
  run.py video quality --quality-inputs video.manifest.json
  run.py video quality --self-test --test-prompt forest-hiker
  run.py video quality --self-test steps-sweep --test-prompt forest-hiker
  run.py video quality --self-test degradation --quality-inputs output/video.mp4

Metric Limitations:
  - Sharpness (Laplacian σ²) measures total HF energy. Noise inflates it massively.
    Cross-check with noise_sigma/SNR before interpreting high sharpness as "good".
  - JPEG blockiness is unreliable at high resolution (≥2MP).
  - JPEG sharpness is unreliable on video: ringing increases Laplacian variance.
    Use edge_density for JPEG quality assessment instead.
  - Temporal flicker measures per-frame absolute difference — scene cuts will
    spike flicker values even in well-produced content.
  - Degradation self-test uses pairwise checks (not monotonic trends) because
    different degradation types aren't ordered by quality.

Self-test modes:
  default      — Distilled (8 steps, cfg=1.0) vs HQ (15 steps, cfg=5.0) (needs MLX + LTX-2.3)
  steps-sweep  — 4/8/12/16 steps with cfg=3.0, trend validation (needs MLX + LTX-2.3)
  degradation  — Synthetic Blur/Noise/JPEG/Downscale, 9 pairwise checks (no MLX needed)
  restore-loop — Closed-loop proof: clean baseline → realistic degrade → `video restore` →
                 full-reference SSIM/PSNR vs ground truth (needs MLX + LTX-2.3 + restore LoRAs).
                 PASS iff restored beats degraded on BOTH SSIM and PSNR against the clean baseline.

See docs/image-quality.md for full metric documentation and interpretation guide.

Exports: add_quality_args(), run_quality()
"""

import glob
import importlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import cv2
import numpy as np

from app import config as cfg
from app.quality_metrics import (
    analyze_frame, generate_html_report, validate_metric_trends, print_trend_validation,
    compare_videos_reference,
)
from app.test_prompts_video import get_test_prompt

_RUN_PY = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "run.py")
)


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "No-reference video quality analysis (noise, sharpness, artifacts)",
    "description": (
        "Analyze video quality using traditional signal processing metrics.\n\n"
        "Metrics: sharpness, edge density, contrast, noise (σ), SNR, blockiness, "
        "temporal flicker, frame consistency.\n\n"
        "Modes:\n"
        "  analyze (default)       — Analyze existing video file(s)\n"
        "  --self-test             — Generate distilled + HQ videos, then compare\n"
        "  --self-test steps-sweep — Generate at 4/8/12/16 steps, validate quality trends\n"
        "  --self-test degradation — Apply blur/noise/JPEG to existing video, validate metrics\n"
        "  --self-test restore-loop — Degrade clean baseline, restore it, SSIM/PSNR vs ground truth\n\n"
        "Examples:\n"
        "  run.py video quality --quality-inputs output/video.mp4\n"
        "  run.py video quality --quality-inputs A.mp4 B.mp4 --quality-labels 'Baseline,HQ'\n"
        "  run.py video quality --quality-inputs output/video.manifest.json\n"
        "  run.py video quality --self-test --test-prompt forest-hiker\n"
        "  run.py video quality --self-test steps-sweep --test-prompt forest-hiker\n"
        "  run.py video quality --self-test degradation --quality-inputs output/video.mp4\n"
        "  run.py video quality --self-test restore-loop --quality-inputs output/clean.mp4\n"
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
        "--self-test", nargs="?", const=True, default=False,
        dest="self_test",
        help="Run self-test. Modes: default (distilled vs HQ), "
             "steps-sweep (4/8/12/16 steps), degradation (synthetic), "
             "restore-loop (degrade→restore→SSIM/PSNR vs ground truth). "
             "Usage: --self-test [steps-sweep|degradation|restore-loop]. "
             "restore-loop needs --quality-inputs <clean.mp4>. "
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
    self_test_val = getattr(args, "self_test", False)
    if self_test_val:
        mode = self_test_val if isinstance(self_test_val, str) else "default"
        if mode == "default":
            _run_self_test(args)
        elif mode == "steps-sweep":
            _run_steps_sweep(args)
        elif mode == "degradation":
            _run_degradation_test(args)
        elif mode == "restore-loop":
            _run_restore_loop(args)
        else:
            print(f"ERROR: unknown self-test mode: {mode}", file=sys.stderr)
            print("Available modes: default, steps-sweep, degradation, restore-loop", file=sys.stderr)
            sys.exit(1)
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

    # Build report data
    report_data = {
        "mode": "compare" if len(results) > 1 else "single",
        "mediaType": "video",
        "lang": getattr(args, "quality_lang", "en"),
        "videos": results,
    }

    # JSON report
    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    # HTML report
    if not getattr(args, "no_html", False):
        html_data = _prepare_html_data(report_data)
        generate_html_report(html_data, resolved[0])


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
        "mediaType": "video",
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
        html_data = _prepare_html_data(report_data)
        generate_html_report(html_data, manifest_paths[0])


# ---------------------------------------------------------------------------
# Steps-sweep self-test (video)
# ---------------------------------------------------------------------------

_VIDEO_STEPS_SWEEP = [
    {"label": "4 steps",  "stage1_steps": 4,  "cfg_scale": 3.0},
    {"label": "8 steps",  "stage1_steps": 8,  "cfg_scale": 3.0},
    {"label": "12 steps", "stage1_steps": 12, "cfg_scale": 3.0},
    {"label": "16 steps", "stage1_steps": 16, "cfg_scale": 3.0},
]


def _run_steps_sweep(args):
    """Generate same video at multiple step counts, analyze quality trend."""
    tp_name = getattr(args, "test_prompt", None) or "forest-hiker"
    seed = getattr(args, "seed", 42)
    sample_every = getattr(args, "sample_every", 1)

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]

    print(f"[quality] ═══ Steps Sweep: {len(_VIDEO_STEPS_SWEEP)} variants ═══")
    print(f"[quality] Prompt: {tp_name} (seed={seed})")
    print(f"[quality] Steps: {', '.join(str(v['stage1_steps']) for v in _VIDEO_STEPS_SWEEP)}")
    print(f"[quality] Prompt text: {prompt[:80]}…")

    # Generate videos sequentially
    manifest_paths = []
    for i, pcfg in enumerate(_VIDEO_STEPS_SWEEP):
        label = pcfg["label"]
        print(f"\n[quality] Generating {i+1}/{len(_VIDEO_STEPS_SWEEP)}: {label}…")

        before = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.manifest.json")))

        cmd = [
            sys.executable, _RUN_PY, "video", "generate",
            "--prompt", prompt,
            "--seed", str(seed),
            "--stage1-steps", str(pcfg["stage1_steps"]),
            "--cfg-scale", str(pcfg["cfg_scale"]),
            "--skip-gpu-lock",
            "--yes",
        ]

        result = subprocess.run(cmd, cwd=os.path.dirname(_RUN_PY))

        after = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.manifest.json")))
        new_manifests = sorted(after - before, key=os.path.getmtime)

        if result.returncode != 0 or not new_manifests:
            print(f"[quality] [{label}] FAILED (returncode={result.returncode})", file=sys.stderr)
            sys.exit(1)

        manifest_paths.append(new_manifests[-1])
        print(f"[quality] [{label}] OK — {os.path.basename(new_manifests[-1])}")

    # Analyze all
    results = []
    labels = []
    for mp, pcfg in zip(manifest_paths, _VIDEO_STEPS_SWEEP):
        mp4 = _resolve_manifest_to_mp4(mp)
        if not mp4:
            print(f"ERROR: could not find video for {mp}", file=sys.stderr)
            sys.exit(1)
        label = pcfg["label"]
        labels.append(label)
        print(f"\n[quality] Analyzing {label}: {os.path.basename(mp4)}")
        report = analyze_video(mp4, sample_every=sample_every)
        report["label"] = label
        results.append(report)
        _print_single_report(report)

    # Comparison
    _print_comparison(results)

    # Trend validation (spatial metrics)
    spatial_metrics = [
        ("sharpness",    "higher"),
        ("edge_density", "higher"),
        ("contrast",     "higher"),
        ("noise_sigma",  "lower"),
        ("snr_db",       "higher"),
        ("blockiness",   "lower"),
        ("saturation_std", "neutral"),
    ]
    findings = validate_metric_trends(results, spatial_metrics, labels)
    print_trend_validation(findings, labels)

    # Report data
    report_data = {
        "mode": "self-test",
        "mediaType": "video",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": tp_name,
        "prompt": prompt,
        "seed": seed,
        "videos": results,
    }

    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    # HTML report
    if not getattr(args, "no_html", False):
        html_data = _prepare_html_data(report_data)
        generate_html_report(html_data, manifest_paths[0])


# ---------------------------------------------------------------------------
# Degradation self-test (video — no MLX needed, pure OpenCV)
# ---------------------------------------------------------------------------

_VIDEO_DEGRADATION_VARIANTS = [
    {"label": "Original",     "type": "original"},
    {"label": "Blur σ=2",     "type": "blur",      "sigma": 2},
    {"label": "Noise σ=25",   "type": "noise",     "sigma": 25},
    {"label": "JPEG Q=5",     "type": "jpeg",      "quality": 5},
    {"label": "JPEG Q=40",    "type": "jpeg",      "quality": 40},
    {"label": "Downscale 2×", "type": "downscale", "factor": 2},
]


def _run_degradation_test(args):
    """Apply known degradations to a video and validate metrics detect them."""
    videos = getattr(args, "quality_inputs", [])
    if not videos:
        print("ERROR: --self-test degradation requires --quality-inputs <video>", file=sys.stderr)
        print("Usage: run.py video quality --self-test degradation --quality-inputs video.mp4",
              file=sys.stderr)
        sys.exit(1)

    src_path = videos[0]
    resolved = src_path
    if src_path.endswith(".manifest.json"):
        resolved = _resolve_manifest_to_mp4(src_path)
        if not resolved:
            print(f"ERROR: could not find video for {src_path}", file=sys.stderr)
            sys.exit(1)
    elif not os.path.exists(src_path):
        print(f"ERROR: file not found: {src_path}", file=sys.stderr)
        sys.exit(1)

    cap = cv2.VideoCapture(resolved)
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {resolved}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")

    print(f"[quality] ═══ Video Degradation Test ═══")
    print(f"[quality] Source: {os.path.basename(resolved)} ({width}×{height}, {total_frames} frames)")
    print(f"[quality] Variants: {len(_VIDEO_DEGRADATION_VARIANTS)}")

    # Read all frames
    frames = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(frame)
    cap.release()

    if not frames:
        print("ERROR: no frames read from video", file=sys.stderr)
        sys.exit(1)

    # Generate degraded variants
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    from app.commands._shared import generate_base_name
    base_name = generate_base_name()

    rng = np.random.default_rng(42)
    variant_paths = []
    labels = []
    results = []

    for vcfg in _VIDEO_DEGRADATION_VARIANTS:
        label = vcfg["label"]
        vtype = vcfg["type"]
        labels.append(label)

        # Apply degradation to each frame
        degraded_frames = []
        for f in frames:
            if vtype == "original":
                degraded_frames.append(f)
            elif vtype == "blur":
                degraded_frames.append(cv2.GaussianBlur(f, (0, 0), vcfg["sigma"]))
            elif vtype == "noise":
                noise = rng.normal(0, vcfg["sigma"], f.shape)
                degraded_frames.append(np.clip(f.astype(np.float64) + noise, 0, 255).astype(np.uint8))
            elif vtype == "jpeg":
                encode_param = [cv2.IMWRITE_JPEG_QUALITY, vcfg["quality"]]
                _, encoded = cv2.imencode(".jpg", f, encode_param)
                degraded_frames.append(cv2.imdecode(encoded, cv2.IMREAD_COLOR))
            elif vtype == "downscale":
                factor = vcfg["factor"]
                small = cv2.resize(f, (width // factor, height // factor), interpolation=cv2.INTER_AREA)
                degraded_frames.append(cv2.resize(small, (width, height), interpolation=cv2.INTER_CUBIC))

        # Write to temp mp4
        safe_label = label.lower().replace(" ", "_").replace("=", "").replace("×", "x")
        out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_{safe_label}.mp4")
        writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height))
        for df in degraded_frames:
            writer.write(df)
        writer.release()
        variant_paths.append(out_path)

        # Analyze
        sample_every = getattr(args, "sample_every", 1)
        print(f"\n[quality] Analyzing {label}: {os.path.basename(out_path)}")
        report = analyze_video(out_path, sample_every=sample_every)
        report["label"] = label
        results.append(report)
        _print_single_report(report)

    # Comparison
    _print_comparison(results)

    # Pairwise degradation checks (not trend validation — variants aren't ordered by quality)
    print(f"\n[quality] {'─'*10} Degradation Checks {'─'*10}")
    original = results[0]["per_frame"]
    blur_m = results[1]["per_frame"]
    noise_m = results[2]["per_frame"]
    jpeg5 = results[3]["per_frame"]
    jpeg40 = results[4]["per_frame"]
    downscale = results[5]["per_frame"]

    def _pf(metrics_dict, key):
        return metrics_dict[key]["mean"]

    checks = [
        # Blur checks
        ("Blur: sharpness < Original",
         _pf(blur_m, "sharpness") < _pf(original, "sharpness")),
        ("Blur: edge_density < Original",
         _pf(blur_m, "edge_density") < _pf(original, "edge_density")),
        # Noise checks
        ("Noise: noise_sigma > Original",
         _pf(noise_m, "noise_sigma") > _pf(original, "noise_sigma")),
        ("Noise: snr_db < Original",
         _pf(noise_m, "snr_db") < _pf(original, "snr_db")),
        # JPEG checks — edge_density is more reliable than sharpness for JPEG
        #   (JPEG ringing can increase Laplacian variance, making sharpness unreliable)
        ("JPEG Q=5: edge_density < Original",
         _pf(jpeg5, "edge_density") < _pf(original, "edge_density")),
        ("JPEG Q=5: edge_density < JPEG Q=40",
         _pf(jpeg5, "edge_density") < _pf(jpeg40, "edge_density")),
        ("JPEG Q=5: noise_sigma < Original (JPEG smooths HF)",
         _pf(jpeg5, "noise_sigma") < _pf(original, "noise_sigma")),
        # Downscale checks
        ("Downscale: sharpness < Original",
         _pf(downscale, "sharpness") < _pf(original, "sharpness")),
        ("Downscale: edge_density < Original",
         _pf(downscale, "edge_density") < _pf(original, "edge_density")),
    ]

    for desc, passed in checks:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"  {desc:.<50} {status}")

    total_checks = len(checks)
    passed_checks = sum(1 for _, p in checks if p)
    print(f"\n  Degradation checks: {passed_checks}/{total_checks} passed")

    # Report data
    report_data = {
        "mode": "self-test",
        "mediaType": "video",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": "degradation",
        "videos": results,
    }

    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    # HTML report
    if not getattr(args, "no_html", False):
        html_data = _prepare_html_data(report_data)
        generate_html_report(html_data, variant_paths[0])


# ---------------------------------------------------------------------------
# Restore-loop self-test (closed-loop full-reference proof)
# ---------------------------------------------------------------------------

def _run_restore_loop(args):
    """Closed-loop restoration proof using full-reference SSIM/PSNR vs ground truth.

    1. Prepare an LTX-conformant clean baseline (8k+1 frames, 64-multiple dims) so
       restore (scale 1.0) returns the same frame count + resolution → exact 1:1 alignment.
    2. Apply realistic degradation (watermark + subtitle burn-in + mild blur +
       low-bitrate H.264 compression) — the exact artifact classes the restore LoRA targets.
    3. Run `run.py video restore` on the degraded video via subprocess.
    4. Compute full-reference PSNR/SSIM of degraded-vs-clean and restored-vs-clean.
    5. PASS iff restored beats degraded on BOTH SSIM and PSNR (moved toward ground truth).
    """
    _restore = importlib.import_module("app.commands.video-restore")
    snap64 = _restore._snap_to_64
    snap8k1 = _restore._snap_to_8k1

    videos = getattr(args, "quality_inputs", [])
    if not videos:
        print("ERROR: --self-test restore-loop requires --quality-inputs <clean_video>", file=sys.stderr)
        print("Usage: run.py video quality --self-test restore-loop --quality-inputs clean.mp4",
              file=sys.stderr)
        sys.exit(1)

    src_path = videos[0]
    if src_path.endswith(".manifest.json"):
        src_path = _resolve_manifest_to_mp4(src_path) or ""
    if not src_path or not os.path.exists(src_path):
        print(f"ERROR: clean baseline not found: {videos[0]}", file=sys.stderr)
        sys.exit(1)

    seed = getattr(args, "seed", 42) or 42
    sample_every = getattr(args, "sample_every", 1)

    # Probe + read source frames
    cap = cv2.VideoCapture(src_path)
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {src_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames = []
    while True:
        ret, f = cap.read()
        if not ret:
            break
        frames.append(f)
    cap.release()
    if not frames:
        print("ERROR: no frames read from baseline", file=sys.stderr)
        sys.exit(1)

    # LTX-conformant target: 64-multiple dims, 8k+1 frames
    target_w = snap64(src_w)
    target_h = snap64(src_h)
    target_n = snap8k1(min(len(frames), 161))

    print(f"[quality] ═══ Restore-Loop Closed-Loop Test ═══")
    print(f"[quality] Source: {os.path.basename(src_path)} ({src_w}×{src_h}, {len(frames)} frames)")
    print(f"[quality] Ground-truth baseline: {target_w}×{target_h}, {target_n} frames @ {fps:.2f} fps")
    print(f"[quality] Seed: {seed}")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    from app.commands._shared import generate_base_name
    base = generate_base_name()
    clean_path    = os.path.join(cfg.OUTPUT_DIR, f"{base}_clean.mp4")
    degraded_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_degraded.mp4")
    restored_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_restored.mp4")

    # 1. Clean baseline — resize to target dims, trim/loop-pad to target frame count
    base_frames = [
        cv2.resize(frames[i % len(frames)], (target_w, target_h), interpolation=cv2.INTER_AREA)
        for i in range(target_n)
    ]
    _write_video(clean_path, base_frames, fps, target_w, target_h)
    print(f"[quality] [1/3] Clean baseline written: {os.path.basename(clean_path)}")

    # 2. Realistic degradation (watermark + subtitle + blur), then low-bitrate compression
    degraded_frames = [
        _degrade_frame_realistic(f.copy(), target_w, target_h) for f in base_frames
    ]
    _write_video(degraded_path, degraded_frames, fps, target_w, target_h)
    _compress_lowbitrate(degraded_path)
    print(f"[quality] [2/3] Degraded (watermark+subtitle+blur+compression): {os.path.basename(degraded_path)}")

    # 3. Restore via subprocess (scale 1.0 → same dims/frames → exact alignment)
    print(f"[quality] [3/3] Restoring (loads LTX-2.3 + IC-LoRAs; may take minutes)…")
    cmd = [
        sys.executable, _RUN_PY, "video", "restore",
        "--restore-input", degraded_path,
        "--restore-output", restored_path,
        "--restore-scale", "1.0",
        "--seed", str(seed),
        "--restore-no-audio",
    ]
    if getattr(args, "low_ram", False):
        cmd.append("--low-ram")
    result = subprocess.run(cmd, cwd=os.path.dirname(_RUN_PY))
    if result.returncode != 0 or not os.path.exists(restored_path):
        print(f"[quality] restore FAILED (returncode={result.returncode})", file=sys.stderr)
        sys.exit(1)

    # 4. Full-reference comparison vs ground truth (informational — context only)
    print(f"\n[quality] Computing full-reference metrics vs ground truth…")
    ref_deg = compare_videos_reference(clean_path, degraded_path, sample_every=sample_every)
    ref_res = compare_videos_reference(clean_path, restored_path, sample_every=sample_every)
    d_ssim = ref_res["ssim_mean"] - ref_deg["ssim_mean"]
    d_psnr = ref_res["psnr_mean"] - ref_deg["psnr_mean"]

    # 5. No-reference 3-way table
    results = []
    for path, label in [(clean_path, "Clean (GT)"), (degraded_path, "Degraded"), (restored_path, "Restored")]:
        print(f"\n[quality] Analyzing {label}: {os.path.basename(path)}")
        report = analyze_video(path, sample_every=sample_every)
        report["label"] = label
        results.append(report)
        _print_single_report(report)
    _print_comparison(results)

    # 6. Verdict — generative models are judged by no-reference quality improvement,
    #    NOT pixel-level SSIM/PSNR (which always favor the degraded video because
    #    degraded ≈ original+noise, while restored is AI-regenerated content).
    #    PASS = restored beats degraded on all 3 perceptual quality checks.
    clean_r, deg_r, res_r = results[0], results[1], results[2]
    noise_pass = res_r["per_frame"]["noise_sigma"]["mean"] < deg_r["per_frame"]["noise_sigma"]["mean"]
    snr_pass   = res_r["per_frame"]["snr_db"]["mean"]    > deg_r["per_frame"]["snr_db"]["mean"]
    ncc_pass   = res_r["temporal"]["consistency_ncc"]    > deg_r["temporal"]["consistency_ncc"]
    noref_pass = noise_pass and snr_pass and ncc_pass

    _print_reference_verdict(ref_deg, ref_res, d_ssim, d_psnr,
                             noise_pass, snr_pass, ncc_pass, noref_pass,
                             deg_r, res_r)

    reference_block = {
        "degraded": {
            "ssim": ref_deg["ssim_mean"], "psnr": ref_deg["psnr_mean"],
            "n_compared": ref_deg["n_compared"], "aligned": ref_deg["aligned"],
        },
        "restored": {
            "ssim": ref_res["ssim_mean"], "psnr": ref_res["psnr_mean"],
            "n_compared": ref_res["n_compared"], "aligned": ref_res["aligned"],
        },
        "delta_ssim": d_ssim, "delta_psnr": d_psnr, "pass": noref_pass,
        "noref_checks": {"noise": noise_pass, "snr": snr_pass, "ncc": ncc_pass},
    }

    report_data = {
        "mode": "self-test",
        "mediaType": "video",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": "restore-loop",
        "seed": seed,
        "videos": results,
        "reference": reference_block,
    }

    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    if not getattr(args, "no_html", False):
        html_data = _prepare_html_data(report_data)
        html_data["reference"] = reference_block
        generate_html_report(html_data, clean_path)


def _write_video(path: str, frames: list, fps: float, w: int, h: int) -> None:
    """Write BGR frames to an mp4v video file."""
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(path, fourcc, fps, (w, h))
    for f in frames:
        writer.write(f)
    writer.release()


def _degrade_frame_realistic(frame: np.ndarray, w: int, h: int) -> np.ndarray:
    """Realistic degradation: mild blur + semi-transparent diagonal watermark +
    bottom subtitle bar. Text is rendered with cv2.putText (drawtext unavailable —
    ffmpeg build lacks libfreetype). Deterministic across frames; compression added
    separately by _compress_lowbitrate."""
    font = cv2.FONT_HERSHEY_SIMPLEX

    # Mild blur (deblur target)
    frame = cv2.GaussianBlur(frame, (0, 0), 1.0)

    # Watermark — semi-transparent centered text (watermark-removal target)
    overlay = frame.copy()
    wm = "SAMPLE (c) PREVIEW"
    wm_scale = max(0.8, w / 700.0)
    wm_th = max(1, int(wm_scale * 2))
    (tw, th), _ = cv2.getTextSize(wm, font, wm_scale, wm_th)
    org = ((w - tw) // 2, (h + th) // 2)
    cv2.putText(overlay, wm, org, font, wm_scale, (255, 255, 255), wm_th, cv2.LINE_AA)
    frame = cv2.addWeighted(overlay, 0.45, frame, 0.55, 0)

    # Subtitle — white text on translucent black bar at bottom (subtitle-removal target)
    sub = "Sample subtitle line to be removed"
    sub_scale = max(0.6, w / 900.0)
    sub_th = max(1, int(sub_scale * 2))
    (_, sth), _ = cv2.getTextSize(sub, font, sub_scale, sub_th)
    bar = frame.copy()
    cv2.rectangle(bar, (0, h - sth - 24), (w, h), (0, 0, 0), -1)
    frame = cv2.addWeighted(bar, 0.5, frame, 0.5, 0)
    (stw, _), _ = cv2.getTextSize(sub, font, sub_scale, sub_th)
    cv2.putText(frame, sub, ((w - stw) // 2, h - 14), font, sub_scale,
                (255, 255, 255), sub_th, cv2.LINE_AA)
    return frame


def _compress_lowbitrate(path: str) -> None:
    """Re-encode in place at high CRF to introduce real H.264 compression artifacts."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("[quality]   WARNING: ffmpeg not found, skipping compression step", file=sys.stderr)
        return
    tmp = path + ".tmp.mp4"
    result = subprocess.run(
        [ffmpeg, "-y", "-i", path, "-c:v", "libx264", "-crf", "40",
         "-preset", "ultrafast", "-pix_fmt", "yuv420p", tmp],
        capture_output=True, timeout=300,
    )
    if result.returncode == 0 and os.path.exists(tmp):
        shutil.move(tmp, path)
    else:
        print("[quality]   WARNING: compression re-encode failed, using uncompressed degraded",
              file=sys.stderr)
        if os.path.exists(tmp):
            os.unlink(tmp)


def _print_reference_verdict(ref_deg: dict, ref_res: dict, d_ssim: float,
                             d_psnr: float, noise_pass: bool, snr_pass: bool,
                             ncc_pass: bool, noref_pass: bool,
                             deg_r: dict, res_r: dict) -> None:
    """Print the combined verdict: no-reference quality checks (PASS/FAIL) +
    full-reference SSIM/PSNR as informational context."""

    # --- No-reference quality checks (the actual PASS criterion) ---
    print(f"\n[quality] {'═'*8} Restoration Quality Verdict {'═'*8}")
    print(f"  Generative models are judged by perceptual quality gains, not pixel fidelity.")
    print(f"  PASS = restored beats degraded on all 3 no-reference quality checks.\n")

    def _pf(report, key, src):
        if src == "per_frame":
            return report["per_frame"][key]["mean"]
        return report["temporal"][key]

    checks = [
        ("Noise σ (lower=cleaner)",
         _pf(deg_r,"noise_sigma","per_frame"), _pf(res_r,"noise_sigma","per_frame"),
         noise_pass, "lower"),
        ("SNR dB (higher=better)",
         _pf(deg_r,"snr_db","per_frame"),      _pf(res_r,"snr_db","per_frame"),
         snr_pass,   "higher"),
        ("NCC consistency (higher=stable)",
         _pf(deg_r,"consistency_ncc","temporal"), _pf(res_r,"consistency_ncc","temporal"),
         ncc_pass,   "higher"),
    ]
    print(f"  {'Check':<32}{'Degraded':>10}{'Restored':>10}  {'Result':>8}")
    print(f"  {'─'*32}{'─'*10}{'─'*10}  {'─'*8}")
    for name, d_val, r_val, ok, dir_ in checks:
        arrow = "↓" if dir_ == "lower" else "↑"
        delta = r_val - d_val
        sign = "+" if delta >= 0 else ""
        tag = "✓ PASS" if ok else "✗ FAIL"
        print(f"  {name:<32}{d_val:>10.3f}{r_val:>10.3f}  {tag}")

    verdict = ("✓ PASS — restoration improved video quality"
               if noref_pass else
               "✗ FAIL — restoration did not improve all quality checks")
    print(f"\n  {verdict}")

    # --- Full-reference table (informational context) ---
    print(f"\n[quality] {'─'*8} SSIM/PSNR vs Ground Truth (informational) {'─'*8}")
    print(f"  NOTE: LTX-2.3 is a generative model — it regenerates content rather than")
    print(f"  reconstructing pixels. Pixel-level SSIM/PSNR always favour the degraded")
    print(f"  video (which shares most pixels with the original). Low SSIM/PSNR for")
    print(f"  the restored video is EXPECTED and does NOT mean restoration failed.")
    print(f"\n  {'Comparison':<24}{'SSIM ↑':>12}{'PSNR dB ↑':>13}{'frames':>9}")
    print(f"  {'─'*24}{'─'*12}{'─'*13}{'─'*9}")
    print(f"  {'Degraded vs Clean':<24}{ref_deg['ssim_mean']:>12.4f}{ref_deg['psnr_mean']:>13.2f}{ref_deg['n_compared']:>9}")
    print(f"  {'Restored vs Clean':<24}{ref_res['ssim_mean']:>12.4f}{ref_res['psnr_mean']:>13.2f}{ref_res['n_compared']:>9}")
    print(f"  {'Δ (restored−degraded)':<24}{d_ssim:>+12.4f}{d_psnr:>+13.2f}")
    if not ref_res["aligned"] or not ref_deg["aligned"]:
        print(f"  NOTE: frame counts not 1:1 — evenly-sampled alignment (approximate)")


# ---------------------------------------------------------------------------
# Core video analysis (per-frame via shared module + temporal metrics)
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

    # Accumulators for 7 per-frame metrics + temporal
    per_frame_acc = {k: [] for k in (
        "sharpness", "edge_density", "contrast", "noise_sigma",
        "snr_db", "blockiness", "saturation_std",
    )}
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

            # Shared per-frame metrics (7 metrics)
            metrics = analyze_frame(gray, frame)
            for k, v in metrics.items():
                per_frame_acc[k].append(v)

            # Temporal metrics (video-only)
            if prev_gray is not None:
                flicker = float(np.abs(gray - prev_gray).mean())
                flicker_list.append(flicker)

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
            k: {**_stats(v), "values": v} for k, v in per_frame_acc.items()
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
# HTML data preparation
# ---------------------------------------------------------------------------

def _prepare_html_data(report_data: dict) -> dict:
    """Prepare data for HTML report — keep summary + per-frame values for charts."""
    videos = []
    for v in report_data.get("videos", []):
        vd = {
            "label": v.get("label", ""),
            "video_path": v.get("video", ""),
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
        "mediaType": "video",
        "lang": report_data.get("lang", "en"),
        "test_prompt": report_data.get("test_prompt"),
        "seed": report_data.get("seed"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "videos": videos,
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
    print(f"    Edge density (Sobel)      : {pf['edge_density']['mean']:>8.2f}  ↑ better")
    print(f"    Contrast (luminance σ)    : {pf['contrast']['mean']:>8.2f}  ↑ better")
    print(f"    Noise (MAD σ)             : {pf['noise_sigma']['mean']:>8.2f}  ↓ better")
    print(f"    SNR (dB)                  : {pf['snr_db']['mean']:>8.1f}  ↑ better")
    print(f"    Blockiness (8×8)          : {pf['blockiness']['mean']:>8.1f}  ↓ better")
    print(f"    Color saturation σ        : {pf['saturation_std']['mean']:>8.1f}  —")

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
        ("Sharpness",       "sharpness",      "per_frame", "higher"),
        ("Edge density",    "edge_density",   "per_frame", "higher"),
        ("Contrast",        "contrast",        "per_frame", "higher"),
        ("Noise (MAD σ)",   "noise_sigma",    "per_frame", "lower"),
        ("SNR (dB)",        "snr_db",          "per_frame", "higher"),
        ("Blockiness",      "blockiness",      "per_frame", "lower"),
        ("Flicker (mean)",  "flicker_mean",    "temporal",  "lower"),
        ("Flicker (max)",   "flicker_max",     "temporal",  "lower"),
        ("Consistency",     "consistency_ncc", "temporal",  "higher"),
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

    for name, key, source, direction in metrics:
        row = f"  {name:<{metric_col}}"
        values = []
        for r in results:
            if source == "per_frame":
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
