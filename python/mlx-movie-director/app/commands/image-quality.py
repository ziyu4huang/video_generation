"""image-quality — No-reference image quality analysis and VAE A/B self-test.

Measures sharpness, edge density, and contrast using traditional signal processing
(OpenCV + NumPy). No AI models needed for analysis.

Sub-actions:
  analyze (default) — Analyze one or more existing images
  self-test         — Generate same image with default VAE vs UltraFlux VAE, then compare

Usage:
  run.py image quality --quality-inputs output/a.png
  run.py image quality --quality-inputs a.png b.png --quality-labels "Default,UltraFlux"
  run.py image quality --self-test --test-prompt portrait --seed 42

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
from app.test_prompts_image import get_test_prompt, list_test_prompt_names


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "No-reference image quality analysis (sharpness, edges, contrast)",
    "description": (
        "Analyze image quality using traditional signal processing metrics.\n\n"
        "Metrics: sharpness (Laplacian σ²), edge density (Sobel), contrast (σ luminance).\n\n"
        "Modes:\n"
        "  analyze (default)  — Analyze existing image file(s)\n"
        "  self-test          — Generate with default VAE vs UltraFlux VAE, then compare\n\n"
        "Examples:\n"
        "  run.py image quality --quality-inputs output/image.png\n"
        "  run.py image quality --quality-inputs a.png b.png --quality-labels 'Default,UltraFlux'\n"
        "  run.py image quality --self-test --test-prompt portrait --seed 42\n"
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


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_quality(args):
    """Dispatch to analyze or self-test mode."""
    if getattr(args, "self_test", False):
        _run_self_test(args)
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

    json_path = getattr(args, "quality_json", None)
    if json_path:
        report_data = {"mode": "compare" if len(results) > 1 else "single", "images": results}
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")


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

    # JSON
    json_path = getattr(args, "quality_json", None)
    if json_path:
        report_data = {
            "mode": "self-test",
            "test_prompt": tp_name,
            "prompt": prompt,
            "seed": seed,
            "images": results,
        }
        with open(json_path, "w") as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\n[quality] JSON report: {json_path}")


# ---------------------------------------------------------------------------
# Core metrics
# ---------------------------------------------------------------------------

def analyze_image(image_path: str) -> dict:
    """Analyze a single image and return quality metrics dict."""
    img_bgr = cv2.imread(image_path)
    if img_bgr is None:
        print(f"ERROR: cannot open image: {image_path}", file=sys.stderr)
        sys.exit(1)

    height, width = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)

    # 1. Sharpness — Laplacian variance
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    sharpness = float(lap.var())

    # 2. Edge density — Sobel magnitude mean
    sobel_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    edge_density = float(np.sqrt(sobel_x**2 + sobel_y**2).mean())

    # 3. Contrast — luminance std dev
    contrast = float(gray.std())

    # 4. Color saturation std
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    saturation_std = float(np.std(hsv[:, :, 1]))

    # 5. Noise estimate — MAD of Laplacian
    mad = float(np.median(np.abs(lap - np.median(lap))) * 1.4826)

    return {
        "image": os.path.abspath(image_path),
        "image_basename": os.path.basename(image_path),
        "resolution": [width, height],
        "metrics": {
            "sharpness": sharpness,
            "edge_density": edge_density,
            "contrast": contrast,
            "saturation_std": saturation_std,
            "noise_mad": mad,
        },
    }


# ---------------------------------------------------------------------------
# Terminal output
# ---------------------------------------------------------------------------

def _print_single_report(report: dict):
    m = report["metrics"]
    w, h = report["resolution"]
    print(f"  Resolution: {w}×{h}")
    print(f"    Sharpness (Laplacian σ²) : {m['sharpness']:>10.1f}  ↑ better")
    print(f"    Edge density (Sobel mean): {m['edge_density']:>10.2f}  ↑ better")
    print(f"    Contrast (luminance σ)   : {m['contrast']:>10.2f}  ↑ better")
    print(f"    Noise (MAD σ)            : {m['noise_mad']:>10.2f}  ↓ better")
    print(f"    Saturation σ             : {m['saturation_std']:>10.2f}  —")


def _print_comparison(results: list):
    labels = [r.get("label", chr(65 + i)) for i, r in enumerate(results)]
    n = len(results)

    metrics_def = [
        ("Sharpness",       "sharpness",     "higher"),
        ("Edge density",    "edge_density",  "higher"),
        ("Contrast",        "contrast",      "higher"),
        ("Noise (MAD σ)",   "noise_mad",     "lower"),
        ("Saturation σ",    "saturation_std","—"),
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
