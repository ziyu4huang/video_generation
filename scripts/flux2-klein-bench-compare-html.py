#!/usr/bin/env python3
"""Flux 2 Klein Bench — HTML Comparison Report Generator.

Part of the flux2-klein-character-profile-bench workflow.
  Workflow:  .claude/workflows/flux2-klein-character-profile-bench.js  (Report HTML phase)
  Siblings:  scripts/flux2-klein-bench-vlm-review.py                   (Review phase)
  Runner:    scripts/comfy_bench.py                                    (Run FP16/FP8 phases)

Reads metrics.json (and optional reviews.json) from each variant directory,
produces a self-contained HTML file with side-by-side images, quality scores,
performance metrics, and a migration recommendation.

Usage:
    python scripts/flux2-klein-bench-compare-html.py \
      --run-dir comfyui_data/output/bench_results/compare-2026-06-06_142530

    # Optional: embed images as base64 for sharing
    python scripts/flux2-klein-bench-compare-html.py \
      --run-dir ... --embed-images
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

# ── Discovery ───────────────────────────────────────────────────────────────────


def discover_variants(run_dir: Path) -> dict[str, Path]:
    """Find variant subdirectories containing metrics.json.

    Handles the double-nesting pattern:
        run_dir/fp16/bf16/metrics.json
        run_dir/fp8/fp8/metrics.json

    Also handles flat pattern:
        run_dir/fp16/metrics.json
        run_dir/fp8/metrics.json
    """
    variants: dict[str, Path] = {}

    # Try double-nested: tag/variant/sub_variant/
    for first in sorted(run_dir.iterdir()):
        if not first.is_dir():
            continue
        for second in sorted(first.iterdir()):
            if not second.is_dir():
                continue
            if (second / "metrics.json").exists():
                # first level is the variant name (fp16/fp8)
                variants[first.name] = second

    # Try flat: tag/variant/
    if not variants:
        for child in sorted(run_dir.iterdir()):
            if child.is_dir() and (child / "metrics.json").exists():
                variants[child.name] = child

    return variants


def load_variant_data(variant_dir: Path) -> dict:
    """Load metrics, optional reviews, and discover images for one variant."""
    data: dict = {"metrics": {}, "reviews": [], "images": {}}

    # Metrics
    metrics_path = variant_dir / "metrics.json"
    if metrics_path.exists():
        data["metrics"] = json.loads(metrics_path.read_text())

    # Reviews (optional)
    reviews_path = variant_dir / "reviews.json"
    if reviews_path.exists():
        try:
            data["reviews"] = json.loads(reviews_path.read_text())
        except json.JSONDecodeError:
            pass

    # Images — relative paths from run_dir parent, with metadata
    img_dir = variant_dir
    for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp"):
        for p in sorted(img_dir.glob(ext)):
            # Skip screenshots
            if "screenshot" in str(p):
                continue
            name = p.stem  # front, back, side, stitched
            file_size = p.stat().st_size
            data["images"][name] = {
                "path": p,
                "size_bytes": file_size,
                "size_kb": round(file_size / 1024),
            }
            # Try to get dimensions (PIL may not be installed)
            try:
                from PIL import Image
                with Image.open(p) as img:
                    data["images"][name]["width"] = img.width
                    data["images"][name]["height"] = img.height
            except ImportError:
                pass

    return data


def avg_review_scores(reviews: list[dict]) -> dict[str, float]:
    """Average numeric score fields across all reviews."""
    if not reviews:
        return {}
    dims = ["anatomy", "consistency", "quality", "background", "clothing", "overall"]
    result: dict[str, float] = {}
    for d in dims:
        vals = [r.get(d, 0) for r in reviews if isinstance(r.get(d), (int, float))]
        result[d] = sum(vals) / len(vals) if vals else 0
    return result


def image_to_data_url(path: Path) -> str:
    """Encode an image file as a data: URL."""
    ext = path.suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(ext, "image/png")
    b64 = base64.b64encode(path.read_bytes()).decode("utf-8")
    return f"data:{mime};base64,{b64}"


# ── HTML Generation ─────────────────────────────────────────────────────────────

STYLE = """\
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
       background: #1a1a2e; color: #e0e0e0; padding: 24px; max-width: 1400px; margin: auto; }
h1 { font-size: 1.6rem; margin-bottom: 4px; color: #fff; }
.subtitle { color: #888; margin-bottom: 24px; font-size: 0.9rem; }
h2 { font-size: 1.2rem; margin: 32px 0 16px; color: #ccc; border-bottom: 1px solid #333; padding-bottom: 8px; }
.image-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
.image-card { background: #16213e; border-radius: 12px; overflow: hidden; }
.image-card .label { padding: 12px 16px; font-weight: 600; font-size: 0.95rem; }
.image-card img { width: 100%; display: block; }
.image-card .score-row { padding: 8px 16px 12px; display: flex; gap: 12px; flex-wrap: wrap; }
.score-badge { background: #0f3460; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; }
.score-badge.overall { background: #533483; }
table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
th { color: #aaa; font-weight: 500; font-size: 0.85rem; text-transform: uppercase; }
td { font-size: 0.9rem; }
.delta-pos { color: #4caf50; }
.delta-neg { color: #f44336; }
.delta-zero { color: #888; }
.recommendation { background: #16213e; border-radius: 12px; padding: 20px; margin-top: 24px; }
.recommendation h3 { margin-bottom: 8px; }
.recommendation p { line-height: 1.6; }
.tag-dim { font-size: 0.85rem; color: #888; margin-bottom: 16px; }
"""


def _delta_class(d: float) -> str:
    if d > 0.05:
        return "delta-pos"
    if d < -0.05:
        return "delta-neg"
    return "delta-zero"


def _fmt_delta(d: float) -> str:
    return f"+{d:.1f}" if d > 0 else f"{d:.1f}" if d < 0 else "0.0"


def build_html_report(
    run_dir: Path,
    variant_data: dict[str, dict],
    run_tag: str = "",
    seeds: str = "",
    embed_images: bool = False,
) -> str:
    """Generate a complete HTML report string."""
    # Determine variant keys — try fp16/fp8 naming, fall back to whatever was found
    keys = list(variant_data.keys())
    left_key = "fp16" if "fp16" in keys else keys[0] if keys else None
    right_key = "fp8" if "fp8" in keys else keys[1] if len(keys) > 1 else None

    if not left_key:
        return "<html><body><h1>No variant data found</h1></body></html>"

    left = variant_data[left_key]
    right = variant_data.get(right_key, {}) if right_key else {}

    left_scores = avg_review_scores(left.get("reviews", []))
    right_scores = avg_review_scores(right.get("reviews", []))
    left_metrics = left.get("metrics", {})
    right_metrics = right.get("metrics", {})

    # Relative image paths from run_dir
    def _img_src(img_info: dict) -> str:
        path = img_info["path"]
        if embed_images:
            return image_to_data_url(path)
        return str(path.relative_to(run_dir))

    def _img_meta(img_info: dict) -> str:
        """Return a metadata string like '1024×1024 · 874 KB'."""
        w = img_info.get("width", "?")
        h = img_info.get("height", "?")
        kb = img_info.get("size_kb", "?")
        return f"{w}×{h} &middot; {kb} KB"

    # ── Build HTML ──
    parts: list[str] = []

    parts.append("<!DOCTYPE html>")
    parts.append("<html lang='en'><head><meta charset='utf-8'>")
    parts.append(f"<title>FP8 vs FP16 Comparison — {run_tag}</title>")
    parts.append(f"<style>{STYLE}</style>")
    parts.append("</head><body>")
    parts.append(f"<h1>FP8 vs FP16 Comparison Report</h1>")
    parts.append(f"<div class='subtitle'>Run: {run_tag} &nbsp;|&nbsp; Seeds: {seeds}</div>")

    # ── Side-by-side images ──
    parts.append("<h2>Side-by-Side Images</h2>")

    left_images = left.get("images", {})
    right_images = right.get("images", {})
    all_views = sorted(set(list(left_images.keys()) + list(right_images.keys())))

    for view in all_views:
        parts.append(f"<div class='image-grid'>")

        # Left variant
        parts.append("<div class='image-card'>")
        parts.append(f"<div class='label' style='background:#1a3a5c'>{left_key.upper()} — {view}</div>")
        if view in left_images:
            src = _img_src(left_images[view])
            meta = _img_meta(left_images[view])
            parts.append(f"<img src='{src}' alt='{left_key} {view}'>")
            parts.append(f"<div class='tag-dim'>{meta}</div>")
        else:
            parts.append("<div style='padding:40px;text-align:center;color:#666'>No image</div>")

        if left_scores:
            ov = left_scores.get("overall", 0)
            parts.append(f"<div class='score-row'>")
            parts.append(f"<span class='score-badge overall'>overall: {ov:.1f}</span>")
            for d in ("anatomy", "quality", "consistency"):
                if d in left_scores:
                    parts.append(f"<span class='score-badge'>{d}: {left_scores[d]:.1f}</span>")
            parts.append("</div>")
        parts.append("</div>")

        # Right variant
        parts.append("<div class='image-card'>")
        parts.append(f"<div class='label' style='background:#3a1a5c'>{(right_key or '?').upper()} — {view}</div>")
        if right_key and view in right_images:
            src = _img_src(right_images[view])
            meta = _img_meta(right_images[view])
            parts.append(f"<img src='{src}' alt='{right_key} {view}'>")
            parts.append(f"<div class='tag-dim'>{meta}</div>")
        else:
            parts.append("<div style='padding:40px;text-align:center;color:#666'>No image</div>")

        if right_scores:
            ov = right_scores.get("overall", 0)
            parts.append(f"<div class='score-row'>")
            parts.append(f"<span class='score-badge overall'>overall: {ov:.1f}</span>")
            for d in ("anatomy", "quality", "consistency"):
                if d in right_scores:
                    parts.append(f"<span class='score-badge'>{d}: {right_scores[d]:.1f}</span>")
            parts.append("</div>")
        parts.append("</div>")

        parts.append("</div>")  # close image-grid

    # ── Quality scores table ──
    if left_scores or right_scores:
        parts.append("<h2>Quality Scores</h2>")
        parts.append("<table><tr><th>Dimension</th>")
        parts.append(f"<th>{left_key.upper()}</th>")
        if right_key:
            parts.append(f"<th>{right_key.upper()}</th><th>Delta</th>")
        parts.append("</tr>")

        for d in ("anatomy", "consistency", "quality", "background", "clothing", "overall"):
            ls = left_scores.get(d, 0)
            rs = right_scores.get(d, 0) if right_key else 0
            delta = rs - ls if right_key else 0
            marker = "★" if d == "overall" else " "
            parts.append(f"<tr><td>{marker} {d}</td>")
            parts.append(f"<td>{ls:.1f}</td>")
            if right_key:
                parts.append(f"<td>{rs:.1f}</td>")
                parts.append(f"<td class='{_delta_class(delta)}'>{_fmt_delta(delta)}</td>")
            parts.append("</tr>")
        parts.append("</table>")

    # ── Performance table ──
    parts.append("<h2>Performance</h2>")
    parts.append("<table><tr><th>Metric</th>")
    parts.append(f"<th>{left_key.upper()}</th>")
    if right_key:
        parts.append(f"<th>{right_key.upper()}</th><th>Delta</th>")
    parts.append("</tr>")

    l_wall = left_metrics.get("wall_time_sec", 0)
    r_wall = right_metrics.get("wall_time_sec", 0)
    parts.append(f"<tr><td>Wall Time (s)</td><td>{l_wall:.1f}</td>")
    if right_key:
        dw = r_wall - l_wall
        parts.append(f"<td>{r_wall:.1f}</td><td class='{_delta_class(-dw)}'>{_fmt_delta(dw)}</td>")
    parts.append("</tr>")

    l_rss = left_metrics.get("peak_rss_mb", 0)
    r_rss = right_metrics.get("peak_rss_mb", 0)
    parts.append(f"<tr><td>Peak RSS (MB)</td><td>{l_rss:,.0f}</td>")
    if right_key:
        dr = r_rss - l_rss
        parts.append(f"<td>{r_rss:,.0f}</td><td class='{_delta_class(-dr)}'>{_fmt_delta(dr)}</td>")
    parts.append("</tr>")

    l_disk = left_metrics.get("disk_output_bytes", 0)
    r_disk = right_metrics.get("disk_output_bytes", 0)
    parts.append(f"<tr><td>Output Size</td><td>{l_disk / 1024:.0f} KB</td>")
    if right_key:
        dd = r_disk - l_disk
        parts.append(f"<td>{r_disk / 1024:.0f} KB</td><td class='{_delta_class(-dd)}'>{_fmt_delta(dd / 1024)} KB</td>")
    parts.append("</tr>")
    parts.append("</table>")

    # ── Disk / Model size ──
    parts.append("<h2>Model Disk Usage</h2>")
    parts.append("<table>")
    parts.append("<tr><td>FP16 (bf16) model</td><td>~17.0 GB</td></tr>")
    parts.append("<tr><td>FP8 model</td><td>~8.8 GB</td></tr>")
    parts.append("<tr><td><strong>Savings</strong></td><td><strong>~8.2 GB (48%)</strong></td></tr>")
    parts.append("</table>")

    # ── Recommendation ──
    if left_scores and right_scores and right_key:
        overall_delta = right_scores.get("overall", 0) - left_scores.get("overall", 0)
        abs_delta = abs(overall_delta)

        parts.append("<div class='recommendation'>")
        parts.append("<h3>Migration Assessment</h3>")
        if abs_delta <= 0.3:
            parts.append(f"<p>Quality difference is minimal (Δoverall={_fmt_delta(overall_delta)}).")
            parts.append(f"<strong>RECOMMENDATION: fp8 is a viable replacement — saves 8.2 GB disk (48%).</strong></p>")
        elif overall_delta > 0:
            parts.append(f"<p>fp8 scores HIGHER than fp16 (Δoverall=+{overall_delta:.1f}).")
            parts.append(f"<strong>RECOMMENDATION: fp8 is equal or better — migrate with confidence.</strong></p>")
        else:
            parts.append(f"<p>fp8 scores LOWER than fp16 (Δoverall={overall_delta:.1f}).")
            parts.append(f"RECOMMENDATION: Quality loss may be noticeable. Evaluate if disk savings (48%) outweigh the difference.</p>")
        parts.append("</div>")

        # Issues & strengths
        l_issues = [r.get("issues", []) for r in left.get("reviews", []) if isinstance(r, dict)]
        r_issues = [r.get("issues", []) for r in right.get("reviews", []) if isinstance(r, dict)]
        l_strengths = [r.get("strengths", []) for r in left.get("reviews", []) if isinstance(r, dict)]
        r_strengths = [r.get("strengths", []) for r in right.get("reviews", []) if isinstance(r, dict)]

        all_l_issues = [i for sub in l_issues for i in sub]
        all_r_issues = [i for sub in r_issues for i in sub]
        all_l_strengths = [s for sub in l_strengths for s in sub]
        all_r_strengths = [s for sub in r_strengths for s in sub]

        if all_l_issues or all_r_issues:
            parts.append("<h2>Issues</h2>")
            parts.append("<table><tr><th>Variant</th><th>Issues</th></tr>")
            if all_l_issues:
                parts.append(f"<tr><td>{left_key.upper()}</td><td>{'<br>'.join(all_l_issues[:8])}</td></tr>")
            if all_r_issues:
                parts.append(f"<tr><td>{right_key.upper()}</td><td>{'<br>'.join(all_r_issues[:8])}</td></tr>")
            parts.append("</table>")

        if all_l_strengths or all_r_strengths:
            parts.append("<h2>Strengths</h2>")
            parts.append("<table><tr><th>Variant</th><th>Strengths</th></tr>")
            if all_l_strengths:
                parts.append(f"<tr><td>{left_key.upper()}</td><td>{'<br>'.join(all_l_strengths[:5])}</td></tr>")
            if all_r_strengths:
                parts.append(f"<tr><td>{right_key.upper()}</td><td>{'<br>'.join(all_r_strengths[:5])}</td></tr>")
            parts.append("</table>")

    parts.append("</body></html>")
    return "\n".join(parts)


# ── CLI ─────────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate FP8 vs FP16 comparison HTML report.")
    parser.add_argument("--run-dir", required=True, help="Path to the bench run directory")
    parser.add_argument("--output", default=None, help="Output HTML path (default: run-dir/comparison.html)")
    parser.add_argument("--embed-images", action="store_true", help="Embed images as base64 (for sharing)")
    parser.add_argument("--seeds", default="", help="Seed values to display")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.is_dir():
        print(f"ERROR: {run_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Discover variants
    variants = discover_variants(run_dir)
    if not variants:
        print(f"ERROR: no variant directories with metrics.json found in {run_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found variants: {', '.join(variants.keys())}", file=sys.stderr)

    # Load data
    data: dict[str, dict] = {}
    for vname, vdir in variants.items():
        data[vname] = load_variant_data(vdir)
        data[vname]["_dir"] = vdir
        n_img = len(data[vname]["images"])
        n_rev = len(data[vname]["reviews"])
        print(f"  {vname}: {n_img} images, {n_rev} reviews", file=sys.stderr)

    # Extract run tag and seeds from directory name or metrics
    run_tag = run_dir.name
    seeds = args.seeds

    html = build_html_report(run_dir, data, run_tag, seeds, args.embed_images)

    out_path = Path(args.output) if args.output else run_dir / "comparison.html"
    out_path.write_text(html)
    print(f"Wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
