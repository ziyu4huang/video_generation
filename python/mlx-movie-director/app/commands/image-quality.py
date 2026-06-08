"""image-quality — No-reference image quality analysis with self-test modes.

Measures 7 no-reference metrics (sharpness, edge density, contrast, noise, SNR,
blockiness, saturation) using shared app.quality_metrics (pure OpenCV + NumPy).
No AI models needed.

Sub-actions:
  analyze (default)       — Analyze one or more existing images
  self-test vae           — Generate with default VAE vs UltraFlux VAE, compare metrics
  self-test steps-sweep   — Generate at 4/8/14/20 steps, validate quality trends
  self-test degradation   — Apply blur/noise/JPEG/downscale, validate metrics detect them

Usage:
  run.py image quality --quality-inputs output/a.png
  run.py image quality --quality-inputs a.png b.png --quality-labels "Default,UltraFlux"
  run.py image quality --self-test --test-prompt portrait --seed 42
  run.py image quality --self-test steps-sweep --test-prompt portrait
  run.py image quality --self-test degradation --quality-inputs output/image.png

Metric Limitations:
  - Sharpness (Laplacian σ²) measures total HF energy. Noise inflates it massively.
    Cross-check with noise_sigma/SNR before interpreting high sharpness as "good".
  - JPEG blockiness is unreliable at high resolution (≥2MP).
  - For JPEG quality assessment, prefer edge_density over sharpness.
  - Degradation self-test uses pairwise checks (not monotonic trends) because
    different degradation types aren't ordered by quality.

Self-test modes:
  vae          — Default VAE vs UltraFlux VAE (needs MLX + UltraFlux VAE)
  steps-sweep  — 4/8/14/20 steps with trend validation (needs MLX)
  degradation  — Synthetic Blur/Noise/JPEG/Downscale, 10 pairwise checks (no MLX needed)

See docs/image-quality.md for full metric documentation and interpretation guide.

Exports: add_quality_args(), run_quality()
"""

import gc
import json
import os
import sys
from datetime import datetime, timezone

import cv2
import numpy as np

from app import config as cfg
from app.quality_metrics import analyze_frame, generate_html_report, validate_metric_trends, print_trend_validation
from app.test_prompts_image import get_test_prompt, list_test_prompt_names


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "No-reference image quality analysis (sharpness, edges, contrast, noise, SNR)",
    "description": (
        "Analyze image quality using traditional signal processing metrics.\n\n"
        "Metrics: sharpness, edge density, contrast, noise (σ), SNR, blockiness, saturation.\n\n"
        "Modes:\n"
        "  analyze (default)       — Analyze existing image file(s)\n"
        "  --self-test vae         — Generate with default VAE vs UltraFlux VAE, then compare\n"
        "  --self-test steps-sweep — Generate at 4/8/14/20 steps, validate quality trends\n"
        "  --self-test degradation — Apply blur/noise/JPEG to existing image, validate metrics\n\n"
        "Examples:\n"
        "  run.py image quality --quality-inputs output/image.png\n"
        "  run.py image quality --quality-inputs a.png b.png --quality-labels 'Default,UltraFlux'\n"
        "  run.py image quality --self-test --test-prompt portrait --seed 42\n"
        "  run.py image quality --self-test steps-sweep --test-prompt portrait\n"
        "  run.py image quality --self-test degradation --quality-inputs output/image.png\n"
    ),
}


def add_quality_args(parser):
    """Register image-quality-specific CLI arguments."""
    parser.add_argument(
        "--quality-inputs", nargs="+", default=[], metavar="IMAGE",
        help="Image file(s) to analyze",
    )
    # --self-test is registered in _shared.py (shared by controlnet, faceswap, quality)
    parser.add_argument(
        "--test-prompt", type=str, default="portrait",
        help=f"Built-in test prompt name for --self-test "
             f"(choices: {', '.join(list_test_prompt_names())}; default: portrait)",
    )
    parser.add_argument(
        "--quality-labels", type=str, default=None,
        help="Comma-separated labels for A/B comparison, e.g. 'Default,UltraFlux'",
    )
    parser.add_argument(
        "--quality-json", type=str, default=None, metavar="PATH",
        help="Save JSON report to file",
    )
    parser.add_argument(
        "--no-compare-png", action="store_true", default=False,
        help="Skip saving side-by-side comparison PNG",
    )
    parser.add_argument(
        "--no-html", action="store_true", default=False,
        help="Skip HTML report and browser auto-launch",
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
    self_test_val = getattr(args, "self_test", None)
    if self_test_val:
        mode = self_test_val if isinstance(self_test_val, str) else "vae"
        if mode == "vae":
            _run_self_test(args)
        elif mode == "steps-sweep":
            _run_steps_sweep(args)
        elif mode == "degradation":
            _run_degradation_test(args)
        else:
            print(f"ERROR: unknown self-test mode: {mode}", file=sys.stderr)
            print("Available modes: vae, steps-sweep, degradation", file=sys.stderr)
            sys.exit(1)
    else:
        images = getattr(args, "quality_inputs", [])
        if not images:
            print("ERROR: provide --quality-inputs or use --self-test", file=sys.stderr)
            print("Usage: run.py image quality --quality-inputs image.png [image2.png ...]",
                  file=sys.stderr)
            print("       run.py image quality --self-test --test-prompt portrait",
                  file=sys.stderr)
            sys.exit(1)
        _run_analyze(args, images)


# ---------------------------------------------------------------------------
# Analyze mode
# ---------------------------------------------------------------------------

def _run_analyze(args, image_paths: list):
    for p in image_paths:
        if not os.path.exists(p):
            print(f"ERROR: file not found: {p}", file=sys.stderr)
            sys.exit(1)

    labels_arg = getattr(args, "quality_labels", None)
    labels = _make_labels(labels_arg, len(image_paths))

    results = []
    for path, label in zip(image_paths, labels):
        print(f"\n[quality] Analyzing: {os.path.basename(path)}")
        report = analyze_image(path)
        report["label"] = label
        results.append(report)
        _print_single_report(report)

    if len(results) > 1:
        _print_comparison(results)
        if not getattr(args, "no_compare_png", False):
            _save_comparison_png(image_paths, labels, image_paths[0])

    # Build report data
    report_data = {
        "mode": "compare" if len(results) > 1 else "single",
        "mediaType": "image",
        "lang": getattr(args, "quality_lang", "en"),
        "images": results,
    }

    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    # HTML report
    if not getattr(args, "no_html", False):
        html_data = _prepare_html_data(report_data)
        generate_html_report(html_data, image_paths[0])


# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

def _run_self_test(args):
    """Generate same image with default VAE and UltraFlux VAE, then compare."""
    import mlx.core as mx
    from app.pipeline import ZImagePipeline
    from app.commands._shared import _stitch_horizontal, generate_base_name

    tp_name = getattr(args, "test_prompt", None) or "portrait"
    seed = getattr(args, "seed", 42) or 42

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]
    width = tp["width"]
    height = tp["height"]
    steps = getattr(args, "steps", None) or 9

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()

    print(f"[quality] ═══ Self-Test: Default VAE vs UltraFlux VAE ═══")
    print(f"[quality] Prompt: {tp_name!r} | seed={seed} | {width}×{height} | {steps} steps")
    print(f"[quality] Prompt text: {prompt[:80]}…")

    # Check UltraFlux VAE is available
    if not os.path.isdir(cfg.ULTRAFLUX_VAE_DIR):
        print(f"[quality] ERROR: UltraFlux VAE not found at {cfg.ULTRAFLUX_VAE_DIR}",
              file=sys.stderr)
        print(f"[quality] Download it first — see docs/ultraflux-vae.md", file=sys.stderr)
        sys.exit(1)

    vae_configs = [
        {"label": "Default VAE",   "vae_dir": None},
        {"label": "UltraFlux VAE", "vae_dir": cfg.ULTRAFLUX_VAE_DIR},
    ]

    image_paths = []
    timings_map = {}

    for vcfg in vae_configs:
        label = vcfg["label"]
        vae_dir = vcfg["vae_dir"]
        safe_label = label.lower().replace(" ", "_")
        out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_{safe_label}.png")

        print(f"\n[quality] {'─'*50}")
        print(f"[quality] Generating: {label}")
        print(f"[quality] {'─'*50}")

        pipeline = ZImagePipeline()
        result = pipeline.generate(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            vae_dir=vae_dir,
        )
        result.image.save(out_path)
        print(f"[quality] Saved: {out_path}")
        image_paths.append(out_path)
        timings_map[label] = result.timings

        del pipeline, result
        mx.clear_cache()
        gc.collect()

    # Analyze both
    labels = [vc["label"] for vc in vae_configs]
    results = []
    for path, label in zip(image_paths, labels):
        print(f"\n[quality] Analyzing {label}: {os.path.basename(path)}")
        report = analyze_image(path)
        report["label"] = label
        report["timings"] = timings_map.get(label, {})
        results.append(report)
        _print_single_report(report)

    _print_comparison(results)

    # Side-by-side comparison PNG
    if not getattr(args, "no_compare_png", False):
        compare_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_compare.png")
        _save_comparison_png(image_paths, labels, compare_path)

    # Report data
    report_data = {
        "mode": "self-test",
        "mediaType": "image",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": tp_name,
        "prompt": prompt,
        "seed": seed,
        "images": results,
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
        generate_html_report(html_data, image_paths[0])


# ---------------------------------------------------------------------------
# Steps-sweep self-test
# ---------------------------------------------------------------------------

_STEPS_SWEEP_VARIANTS = [
    {"label": "4 steps",  "steps": 4},
    {"label": "8 steps",  "steps": 8},
    {"label": "14 steps", "steps": 14},
    {"label": "20 steps", "steps": 20},
]


def _run_steps_sweep(args):
    """Generate same image at multiple step counts, analyze quality trend."""
    import mlx.core as mx
    from app.pipeline import ZImagePipeline
    from app.commands._shared import _stitch_horizontal, generate_base_name

    tp_name = getattr(args, "test_prompt", None) or "portrait"
    seed = getattr(args, "seed", 42) or 42

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]
    width = tp["width"]
    height = tp["height"]

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()

    variants = _STEPS_SWEEP_VARIANTS

    print(f"[quality] ═══ Steps Sweep: {len(variants)} variants ═══")
    print(f"[quality] Prompt: {tp_name!r} | seed={seed} | {width}×{height}")
    print(f"[quality] Steps: {', '.join(str(v['steps']) for v in variants)}")
    print(f"[quality] Prompt text: {prompt[:80]}…")

    image_paths = []
    for i, vcfg in enumerate(variants):
        label = vcfg["label"]
        steps = vcfg["steps"]
        safe_label = label.lower().replace(" ", "_")
        out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_{safe_label}.png")

        print(f"\n[quality] {'─'*50}")
        print(f"[quality] Generating {i+1}/{len(variants)}: {label}")
        print(f"[quality] {'─'*50}")

        pipeline = ZImagePipeline()
        result = pipeline.generate(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
        )
        result.image.save(out_path)
        print(f"[quality] Saved: {out_path}")
        image_paths.append(out_path)

        del pipeline, result
        mx.clear_cache()
        gc.collect()

    # Analyze all
    labels = [v["label"] for v in variants]
    results = []
    for path, label in zip(image_paths, labels):
        print(f"\n[quality] Analyzing {label}: {os.path.basename(path)}")
        report = analyze_image(path)
        report["label"] = label
        results.append(report)
        _print_single_report(report)

    # Comparison table
    _print_comparison(results)

    # Trend validation
    metrics_def = [
        ("sharpness",    "higher"),
        ("edge_density", "higher"),
        ("contrast",     "higher"),
        ("noise_sigma",  "lower"),
        ("snr_db",       "higher"),
        ("blockiness",   "lower"),
        ("saturation_std", "neutral"),
    ]
    findings = validate_metric_trends(results, metrics_def, labels)
    print_trend_validation(findings, labels)

    # Comparison PNG
    if not getattr(args, "no_compare_png", False):
        compare_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_steps_compare.png")
        _save_comparison_png(image_paths, labels, compare_path)

    # Report data
    report_data = {
        "mode": "self-test",
        "mediaType": "image",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": tp_name,
        "prompt": prompt,
        "seed": seed,
        "images": results,
    }

    json_path = getattr(args, "quality_json", None)
    if json_path:
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")

    # HTML report
    if not getattr(args, "no_html", False):
        html_data = _prepare_html_data(report_data)
        generate_html_report(html_data, image_paths[0])


# ---------------------------------------------------------------------------
# Degradation self-test (no MLX needed — pure OpenCV)
# ---------------------------------------------------------------------------

_DEGRADATION_VARIANTS = [
    {"label": "Original",   "type": "original"},
    {"label": "Blur σ=3",   "type": "blur",    "sigma": 3},
    {"label": "Noise σ=30", "type": "noise",   "sigma": 30},
    {"label": "JPEG Q=5",   "type": "jpeg",    "quality": 5},
    {"label": "JPEG Q=40",  "type": "jpeg",    "quality": 40},
    {"label": "Downscale 2×", "type": "downscale", "factor": 2},
]


def _run_degradation_test(args):
    """Apply known degradations to an image and validate metrics detect them."""
    images = getattr(args, "quality_inputs", [])
    if not images:
        print("ERROR: --self-test degradation requires --quality-inputs <image>", file=sys.stderr)
        print("Usage: run.py image quality --self-test degradation --quality-inputs photo.png",
              file=sys.stderr)
        sys.exit(1)

    src_path = images[0]
    if not os.path.exists(src_path):
        print(f"ERROR: file not found: {src_path}", file=sys.stderr)
        sys.exit(1)

    img_bgr = cv2.imread(src_path)
    if img_bgr is None:
        print(f"ERROR: cannot open image: {src_path}", file=sys.stderr)
        sys.exit(1)

    h, w = img_bgr.shape[:2]

    print(f"[quality] ═══ Degradation Test ═══")
    print(f"[quality] Source: {os.path.basename(src_path)} ({w}×{h})")
    print(f"[quality] Variants: {len(_DEGRADATION_VARIANTS)}")

    # Generate degraded variants
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    from app.commands._shared import generate_base_name
    base_name = generate_base_name()

    variant_paths = []
    labels = []
    results = []

    for vcfg in _DEGRADATION_VARIANTS:
        label = vcfg["label"]
        vtype = vcfg["type"]
        labels.append(label)

        # Apply degradation
        if vtype == "original":
            degraded = img_bgr.copy()
        elif vtype == "blur":
            degraded = cv2.GaussianBlur(img_bgr, (0, 0), vcfg["sigma"])
        elif vtype == "noise":
            noise = np.random.default_rng(42).normal(0, vcfg["sigma"], img_bgr.shape)
            degraded = np.clip(img_bgr.astype(np.float64) + noise, 0, 255).astype(np.uint8)
        elif vtype == "jpeg":
            encode_param = [cv2.IMWRITE_JPEG_QUALITY, vcfg["quality"]]
            _, encoded = cv2.imencode(".jpg", img_bgr, encode_param)
            degraded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        elif vtype == "downscale":
            factor = vcfg["factor"]
            small = cv2.resize(img_bgr, (w // factor, h // factor), interpolation=cv2.INTER_AREA)
            degraded = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
        else:
            degraded = img_bgr.copy()

        # Save variant
        safe_label = label.lower().replace(" ", "_").replace("=", "").replace("×", "x")
        out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_{safe_label}.png")
        cv2.imwrite(out_path, degraded)
        variant_paths.append(out_path)

        # Analyze
        gray = cv2.cvtColor(degraded, cv2.COLOR_BGR2GRAY).astype(np.float64)
        metrics = analyze_frame(gray, degraded)
        report = {
            "image": os.path.abspath(out_path),
            "image_basename": os.path.basename(out_path),
            "resolution": list(degraded.shape[:2][::-1]),
            "metrics": metrics,
            "label": label,
        }
        results.append(report)
        print(f"\n[quality] {label}:")
        _print_single_report(report)

    # Comparison table
    _print_comparison(results)

    # Pairwise degradation checks (not trend validation — variants aren't ordered by quality)
    print(f"\n[quality] {'─'*10} Degradation Checks {'─'*10}")
    original = results[0]["metrics"]
    blur_m = results[1]["metrics"]
    noise_m = results[2]["metrics"]
    jpeg5 = results[3]["metrics"]
    jpeg40 = results[4]["metrics"]
    downscale = results[5]["metrics"]

    checks = [
        # Blur checks
        ("Blur: sharpness < Original",
         blur_m["sharpness"] < original["sharpness"]),
        ("Blur: edge_density < Original",
         blur_m["edge_density"] < original["edge_density"]),
        ("Blur: contrast < Original",
         blur_m["contrast"] < original["contrast"]),
        # Noise checks
        ("Noise: noise_sigma > Original",
         noise_m["noise_sigma"] > original["noise_sigma"]),
        ("Noise: snr_db < Original",
         noise_m["snr_db"] < original["snr_db"]),
        # JPEG checks — Q=5 should show stronger degradation than Q=40
        ("JPEG Q=5: sharpness < Original",
         jpeg5["sharpness"] < original["sharpness"]),
        ("JPEG Q=5: sharpness < JPEG Q=40",
         jpeg5["sharpness"] < jpeg40["sharpness"]),
        ("JPEG Q=5: edge_density < Original",
         jpeg5["edge_density"] < original["edge_density"]),
        # Downscale checks
        ("Downscale: sharpness < Original",
         downscale["sharpness"] < original["sharpness"]),
        ("Downscale: edge_density < Original",
         downscale["edge_density"] < original["edge_density"]),
    ]

    for desc, passed in checks:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"  {desc:.<50} {status}")

    total_checks = len(checks)
    passed_checks = sum(1 for _, p in checks if p)
    print(f"\n  Degradation checks: {passed_checks}/{total_checks} passed")

    # Comparison PNG
    if not getattr(args, "no_compare_png", False):
        compare_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_degradation_compare.png")
        _save_comparison_png(variant_paths, labels, compare_path)

    # Report data
    report_data = {
        "mode": "self-test",
        "mediaType": "image",
        "lang": getattr(args, "quality_lang", "en"),
        "test_prompt": "degradation",
        "images": results,
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
# Core image analysis (uses shared analyze_frame)
# ---------------------------------------------------------------------------

def analyze_image(image_path: str) -> dict:
    """Analyze a single image and return quality metrics dict."""
    img_bgr = cv2.imread(image_path)
    if img_bgr is None:
        print(f"ERROR: cannot open image: {image_path}", file=sys.stderr)
        sys.exit(1)

    height, width = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)

    # Use shared per-frame analysis (7 metrics)
    metrics = analyze_frame(gray, img_bgr)

    return {
        "image": os.path.abspath(image_path),
        "image_basename": os.path.basename(image_path),
        "resolution": [width, height],
        "metrics": metrics,
    }


# ---------------------------------------------------------------------------
# HTML data preparation
# ---------------------------------------------------------------------------

def _prepare_html_data(report_data: dict) -> dict:
    """Prepare image data for HTML report — adapt to chart-compatible format."""
    images = []
    for img in report_data.get("images", []):
        m = img.get("metrics", {})
        w, h = img.get("resolution", [0, 0])
        # Wrap into same shape as video per_frame_summary for chart compatibility
        images.append({
            "label": img.get("label", ""),
            "image_basename": img.get("image_basename", ""),
            "resolution": [w, h],
            "frames_analyzed": 1,
            "per_frame_summary": {
                k: {"mean": v, "min": v, "max": v}
                for k, v in m.items()
            },
            "per_frame_values": {},  # single frame — no arrays
            "temporal_summary": {},  # no temporal for images
        })

    return {
        "mode": report_data.get("mode", "single"),
        "mediaType": "image",
        "lang": report_data.get("lang", "en"),
        "test_prompt": report_data.get("test_prompt"),
        "seed": report_data.get("seed"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "images": images,
    }


# ---------------------------------------------------------------------------
# Terminal output
# ---------------------------------------------------------------------------

def _print_single_report(report: dict):
    m = report["metrics"]
    w, h = report["resolution"]
    print(f"  Resolution: {w}×{h}")
    print(f"    Sharpness (Laplacian σ²)  : {m['sharpness']:>10.1f}  ↑ better")
    print(f"    Edge density (Sobel)      : {m['edge_density']:>10.2f}  ↑ better")
    print(f"    Contrast (luminance σ)    : {m['contrast']:>10.2f}  ↑ better")
    print(f"    Noise (MAD σ)             : {m['noise_sigma']:>10.2f}  ↓ better")
    print(f"    SNR (dB)                  : {m['snr_db']:>10.1f}  ↑ better")
    print(f"    Blockiness (8×8)          : {m['blockiness']:>10.1f}  ↓ better")
    print(f"    Saturation σ              : {m['saturation_std']:>10.2f}  —")


def _print_comparison(results: list):
    labels = [r.get("label", chr(65 + i)) for i, r in enumerate(results)]
    n = len(results)

    metrics_def = [
        ("Sharpness",       "sharpness",      "higher"),
        ("Edge density",    "edge_density",   "higher"),
        ("Contrast",        "contrast",       "higher"),
        ("Noise (MAD σ)",   "noise_sigma",    "lower"),
        ("SNR (dB)",        "snr_db",         "higher"),
        ("Blockiness",      "blockiness",     "lower"),
        ("Saturation σ",    "saturation_std",  "neutral"),
    ]

    label_width = max(len(l) for l in labels) + 2
    metric_col = 24
    sep = "─" * metric_col + " " + ("─" * (label_width + 2)) * n + "─" * 10

    header = f"  {'Metric':<{metric_col}}"
    for l in labels:
        header += f" {l:>{label_width}}"
    header += f"  {'Winner':>8}"

    print(f"\n[quality] {'═'*10} Comparison {'═'*10}")
    print(header)
    print(f"  {sep}")

    for name, key, direction in metrics_def:
        row = f"  {name:<{metric_col}}"
        values = [r["metrics"][key] for r in results]

        for v in values:
            if abs(v) < 10:
                row += f" {v:>{label_width}.2f}"
            else:
                row += f" {v:>{label_width}.1f}"

        if direction == "higher":
            best_idx = values.index(max(values))
            winner = labels[best_idx]
            row += f"  {winner:>8} ✓"
        elif direction == "lower":
            best_idx = values.index(min(values))
            winner = labels[best_idx]
            row += f"  {winner:>8} ✓"
        else:
            row += f"  {'—':>8}"

        print(row)

    print()


# ---------------------------------------------------------------------------
# Side-by-side comparison PNG
# ---------------------------------------------------------------------------

def _save_comparison_png(image_paths: list, labels: list, output_path: str):
    """Stitch images horizontally and save comparison PNG."""
    from PIL import Image
    from app.commands._shared import _stitch_horizontal

    images = [Image.open(p).convert("RGB") for p in image_paths]
    compare = _stitch_horizontal(images, gap=4, labels=labels)
    compare.save(output_path)
    print(f"[quality] Comparison PNG: {output_path}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_labels(labels_arg: str | None, n: int) -> list:
    if labels_arg:
        parts = [p.strip() for p in labels_arg.split(",")]
        if len(parts) >= n:
            return parts[:n]
    return [chr(65 + i) for i in range(n)]
