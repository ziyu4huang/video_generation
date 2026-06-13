#!/usr/bin/env python3
"""A/B test: compare bf16 LoRA vs int8 quantized LoRA for ltx-2.3-distilled.

Runs the dev pipeline (two-stage: dev transformer + distilled LoRA) twice:
  1. Baseline — original bf16 LoRA
  2. Test     — int8 quantized LoRA

Compares outputs with:
  • Video-level SSIM/PSNR (all frames, via compare_videos_reference)
  • First/last frame image SSIM/PSNR + diff heatmaps
  • Audio track comparison (if present)
  • HTML report with side-by-side metrics + verdict

Usage:
    python/venv/bin/python scripts/ab_test_lora_int8.py [--frames 25] [--prompt "..."]

Output:
    output/ab_lora_int8/
        bf16.mp4         — baseline video
        int8.mp4         — test video
        report.html      — comparison report
"""

import argparse
import gc
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config as cfg

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

LORA_DIR = os.path.join(cfg.MODELS_DIR, "lora", "ltx-2.3-distilled")

# The two LoRA weight files
BF16_FILES = [
    "ltx-2.3-22b-distilled-lora-384.safetensors",
    "ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
]
INT8_FILES = [
    "ltx-2.3-22b-distilled-lora-384.int8.safetensors",
    "ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors",
]


def _rename_files(renames: list[tuple[str, str]]) -> None:
    """Rename files in LORA_DIR. (src, dst) tuples."""
    for src, dst in renames:
        src_path = os.path.join(LORA_DIR, src)
        if not os.path.exists(src_path):
            continue
        if dst is None:
            os.remove(src_path)
        else:
            dst_path = os.path.join(LORA_DIR, dst)
            os.rename(src_path, dst_path)


def _ensure_int8_disabled() -> None:
    """Rename .int8 files to .bak so the pipeline falls back to bf16."""
    for fn in INT8_FILES:
        src = os.path.join(LORA_DIR, fn)
        bak = os.path.join(LORA_DIR, fn + ".bak")
        if os.path.exists(src) and not os.path.exists(bak):
            os.rename(src, bak)


def _ensure_int8_enabled() -> None:
    """Restore .int8 files from .bak so the patch picks them."""
    for fn in INT8_FILES:
        bak = os.path.join(LORA_DIR, fn + ".bak")
        dst = os.path.join(LORA_DIR, fn)
        if os.path.exists(bak) and not os.path.exists(dst):
            os.rename(bak, dst)


def _cleanup_bak() -> None:
    """Remove any leftover .bak files."""
    for fn in INT8_FILES:
        bak = os.path.join(LORA_DIR, fn + ".bak")
        if os.path.exists(bak):
            os.remove(bak)


def _run_generation(label: str, dest_path: str, args: argparse.Namespace) -> dict | None:
    """Run run.py video generate, find the generated video, and copy to dest_path."""
    runner_cmd = [sys.executable, "run.py", "video", "generate",
                  "--prompt", args.prompt,
                  "--frames", str(args.frames),
                  "--width", str(args.width),
                  "--height", str(args.height),
                  "--seed", str(args.seed)]
    if args.cfg_scale is not None:
        runner_cmd.extend(["--cfg-scale", str(args.cfg_scale)])
    if args.stg_scale is not None:
        runner_cmd.extend(["--stg-scale", str(args.stg_scale)])

    print(f"\n{'='*60}")
    print(f"[{label}] Running: {' '.join(runner_cmd)}")
    print(f"{'='*60}")

    t0 = time.time()
    result = subprocess.run(
        runner_cmd,
        capture_output=True,
        text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    elapsed = time.time() - t0

    stdout = result.stdout
    stderr = result.stderr

    # Print key output lines
    saved_path = None
    for line in (stdout + stderr).split("\n"):
        line = line.strip()
        if "[video] Saved:" in line:
            # Extract the path: "[video] Saved:    /path/to/output.mp4"
            parts = line.split()
            if parts:
                saved_path = parts[-1]
        if any(marker in line for marker in
               ["[video]", "ERROR", "error", "Traceback",
                "[LTXVideoPipeline]", "Saved", "RESULT"]):
            print(f"  {line}")

    print(f"\n[{label}] Completed in {elapsed:.1f}s (return code: {result.returncode})")

    if result.returncode != 0:
        err_lines = stderr.strip().split("\n")
        for line in err_lines[-10:]:
            print(f"  [STDERR] {line}")
        return None

    # Copy generated file to destination
    if saved_path and os.path.exists(saved_path):
        shutil.copy2(saved_path, dest_path)
        size = os.path.getsize(dest_path)
        print(f"[{label}] Copied: {saved_path} → {dest_path} ({size/1024**2:.0f} MB)")
        return {"output": dest_path, "source": saved_path, "size": size}

    # Fallback: scan output dir for most recent .mp4
    output_dir = cfg.OUTPUT_DIR
    if not os.path.isdir(output_dir):
        output_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                  "output")

    mp4_files = sorted([f for f in os.listdir(output_dir) if f.endswith(".mp4")],
                       key=lambda f: os.path.getmtime(os.path.join(output_dir, f)),
                       reverse=True)
    if mp4_files:
        latest = os.path.join(output_dir, mp4_files[0])
        shutil.copy2(latest, dest_path)
        size = os.path.getsize(dest_path)
        print(f"[{label}] Copied (fallback): {latest} → {dest_path} ({size/1024**2:.0f} MB)")
        return {"output": dest_path, "source": latest, "size": size}

    print(f"[{label}] Output not found.")
    return None


def _compare_videos(bf16_path: str, int8_path: str, output_dir: str) -> dict:
    """Compare two MP4 videos frame-by-frame using quality_metrics."""
    from app.quality_metrics import compare_videos_reference

    print(f"\n  Comparing videos…")
    t0 = time.time()

    result = compare_videos_reference(bf16_path, int8_path, sample_every=1)
    elapsed = time.time() - t0

    print(f"  Video comparison done in {elapsed:.1f}s")
    print(f"  Frames compared: {result.get('n_compared', 0)}")
    print(f"  SSIM (mean):     {result.get('ssim_mean', 0):.4f}")
    print(f"  PSNR (mean):     {result.get('psnr_mean', 0):.2f} dB")

    return result


def _extract_frames(video_path: str, output_dir: str, label: str) -> tuple[str | None, str | None]:
    """Extract first and last frames from a video as PNG images."""
    try:
        import cv2
    except ImportError:
        print("  [WARN] OpenCV not available — cannot extract frames")
        return None, None

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"  [WARN] Cannot open {video_path}")
        return None, None

    frames = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(frame)
    cap.release()

    if len(frames) == 0:
        return None, None

    first_path = os.path.join(output_dir, f"{label}_first.png")
    last_path = os.path.join(output_dir, f"{label}_last.png")
    cv2.imwrite(first_path, frames[0])
    cv2.imwrite(last_path, frames[-1])
    print(f"  Extracted {len(frames)} frames from {label}")
    return first_path, last_path


def _compare_images(img_a_path: str, img_b_path: str, label_a: str, label_b: str) -> dict:
    """Compare two images with SSIM/PSNR and generate diff heatmap."""
    try:
        from skimage.metrics import structural_similarity as ssim_fn
        from skimage.metrics import peak_signal_noise_ratio as psnr_fn
    except ImportError:
        print("  [WARN] skimage not available — skipping image comparison")
        return {}

    import cv2
    import numpy as np

    img_a = cv2.imread(img_a_path)
    img_b = cv2.imread(img_b_path)
    if img_a is None or img_b is None:
        print(f"  [WARN] Cannot read images for comparison")
        return {}

    # Resize b to match a if needed
    if img_a.shape != img_b.shape:
        img_b = cv2.resize(img_b, (img_a.shape[1], img_a.shape[0]))

    # SSIM on grayscale
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)
    ssim_val = ssim_fn(gray_a, gray_b, data_range=255)

    # PSNR on color
    mse = np.mean((img_a.astype(np.float64) - img_b.astype(np.float64)) ** 2)
    psnr_val = 20 * np.log10(255.0) - 10 * np.log10(max(mse, 1e-10))

    # Difference heatmap
    diff = np.abs(img_a.astype(np.float64) - img_b.astype(np.float64))
    diff_norm = (diff / diff.max() * 255).astype(np.uint8) if diff.max() > 0 else np.zeros_like(diff).astype(np.uint8)
    diff_path = os.path.join(os.path.dirname(img_a_path), f"diff_{label_a}_vs_{label_b}.png")
    cv2.imwrite(diff_path, diff_norm)

    print(f"  Image SSIM: {ssim_val:.4f}  PSNR: {psnr_val:.2f} dB  MSE: {mse:.4f}")
    return {
        "ssim": ssim_val,
        "psnr": psnr_val,
        "mse": float(mse),
        "diff_path": os.path.basename(diff_path),
    }


def _compare_audio(bf16_path: str, int8_path: str) -> dict:
    """Compare audio tracks from two MP4s using ffprobe metadata."""
    try:
        import subprocess as sp
    except ImportError:
        return {}

    def _get_audio_stats(path: str) -> dict | None:
        """Extract audio stats via ffprobe."""
        try:
            cmd = [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_streams", path,
            ]
            result = sp.run(cmd, capture_output=True, text=True)
            data = json.loads(result.stdout)
            for stream in data.get("streams", []):
                if stream.get("codec_type") == "audio":
                    return {
                        "codec": stream.get("codec_name", "?"),
                        "channels": stream.get("channels", 0),
                        "sample_rate": stream.get("sample_rate", "?"),
                        "duration": float(stream.get("duration", 0)),
                    }
            return None
        except Exception:
            return None

    stats_bf16 = _get_audio_stats(bf16_path)
    stats_int8 = _get_audio_stats(int8_path)

    if stats_bf16 is None and stats_int8 is None:
        return {"note": "No audio tracks found in either video"}

    result = {"bf16": stats_bf16, "int8": stats_int8}

    if stats_bf16 and stats_int8:
        for key in ["codec", "channels", "sample_rate"]:
            result[f"{key}_match"] = stats_bf16.get(key) == stats_int8.get(key)

    return result


def _generate_html_report(
    video_result: dict,
    img_results: dict,
    audio_result: dict,
    bf16_path: str,
    int8_path: str,
    args: argparse.Namespace,
    output_dir: str,
) -> str:
    """Generate a self-contained HTML report."""
    ssim_v = video_result.get("ssim_mean", 0)
    psnr_v = video_result.get("psnr_mean", 0)

    # Determine verdict
    if ssim_v > 0.99 and psnr_v > 40:
        verdict = "✅ Near-lossless — Int8 LoRA produces visually identical output"
        verdict_class = "pass"
    elif ssim_v > 0.97 and psnr_v > 35:
        verdict = "✅ Excellent — Minor numerical differences, visually indistinguishable"
        verdict_class = "pass"
    elif ssim_v > 0.95 and psnr_v > 30:
        verdict = "⚠️ Good — Some numerical differences, likely not noticeable"
        verdict_class = "warn"
    else:
        verdict = "❌ Significant degradation — Int8 LoRA changes output noticeably"
        verdict_class = "fail"

    # File sizes
    bf16_size = os.path.getsize(bf16_path) / 1024**2 if os.path.exists(bf16_path) else 0
    int8_size = os.path.getsize(int8_path) / 1024**2 if os.path.exists(int8_path) else 0
    lora_bf16 = sum(
        os.path.getsize(os.path.join(LORA_DIR, f))
        for f in BF16_FILES
        if os.path.exists(os.path.join(LORA_DIR, f))
    ) / 1024**3
    lora_int8 = sum(
        os.path.getsize(os.path.join(LORA_DIR, f))
        for f in INT8_FILES
        if os.path.exists(os.path.join(LORA_DIR, f))
    ) / 1024**3

    # Frame comparison rows
    first_row = ""
    last_row = ""
    if "first" in img_results:
        r = img_results["first"]
        diff_img = r.get("diff_path", "")
        first_row = f"""
        <tr><td>First frame</td>
            <td class="{'positive' if r.get('ssim',0) > 0.97 else 'neutral' if r.get('ssim',0) > 0.95 else 'negative'}">{r.get('ssim', 0):.4f}</td>
            <td>{r.get('psnr', 0):.2f} dB</td>
            <td>{r.get('mse', 0):.4f}</td>
            <td><img src="{diff_img}" width="200"/></td>
        </tr>"""
    if "last" in img_results:
        r = img_results["last"]
        diff_img = r.get("diff_path", "")
        last_row = f"""
        <tr><td>Last frame</td>
            <td class="{'positive' if r.get('ssim',0) > 0.97 else 'neutral' if r.get('ssim',0) > 0.95 else 'negative'}">{r.get('ssim', 0):.4f}</td>
            <td>{r.get('psnr', 0):.2f} dB</td>
            <td>{r.get('mse', 0):.4f}</td>
            <td><img src="{diff_img}" width="200"/></td>
        </tr>"""

    # Audio rows
    audio_rows = ""
    if isinstance(audio_result, dict) and "note" not in audio_result:
        if audio_result.get("bf16"):
            a = audio_result["bf16"]
            audio_rows += f"<tr><td>bf16</td><td>{a.get('codec','?')}</td><td>{a.get('channels',0)}</td><td>{a.get('sample_rate','?')} Hz</td><td>{a.get('duration',0):.1f}s</td></tr>"
        if audio_result.get("int8"):
            a = audio_result["int8"]
            audio_rows += f"<tr><td>int8</td><td>{a.get('codec','?')}</td><td>{a.get('channels',0)}</td><td>{a.get('sample_rate','?')} Hz</td><td>{a.get('duration',0):.1f}s</td></tr>"
    else:
        audio_rows = '<tr><td colspan="5">No audio tracks found (T2V pipeline does not generate audio)</td></tr>'

    lora_save_pct = int((1 - lora_int8 / lora_bf16) * 100) if lora_bf16 > 0 else 0

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LoRA Int8 A/B Test Report</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 960px; margin: 2em auto; padding: 0 1em; background: #1a1a2e; color: #e0e0e0; }}
  h1, h2, h3 {{ color: #00d4aa; }}
  .verdict {{ padding: 1em; border-radius: 8px; font-size: 1.1em; margin: 1em 0; }}
  .pass {{ background: #1a3a2a; border: 1px solid #00d4aa; }}
  .warn {{ background: #3a3a1a; border: 1px solid #d4aa00; }}
  .fail {{ background: #3a1a1a; border: 1px solid #d44a00; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1em 0; }}
  th, td {{ padding: 0.5em; text-align: left; border-bottom: 1px solid #333; }}
  th {{ background: #16213e; color: #00d4aa; }}
  .positive {{ color: #00d4aa; font-weight: bold; }}
  .neutral {{ color: #d4aa00; }}
  .negative {{ color: #d44a00; }}
  .side-by-side {{ display: flex; gap: 1em; }}
  .side-by-side video {{ width: 48%; }}
  img {{ max-width: 100%; }}
</style>
</head>
<body>
<h1>LoRA Int8 A/B Test Report</h1>
<p>Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>
<p>Prompt: <code>{args.prompt[:80]}{'…' if len(args.prompt) > 80 else ''}</code></p>
<p>Frames: {args.frames} | Resolution: {args.width}×{args.height} | Seed: {args.seed}</p>

<div class="verdict {verdict_class}">
  <strong>{verdict}</strong>
</div>

<h2>File Size Savings</h2>
<table>
  <tr><th>Variant</th><th>LoRA Size</th><th>Video Output</th></tr>
  <tr><td>bf16 (baseline)</td><td>{lora_bf16:.1f} GB</td><td>{bf16_size:.0f} MB</td></tr>
  <tr><td>int8 (quantized)</td><td class="positive">{lora_int8:.1f} GB <strong>({lora_save_pct}% savings)</strong></td><td>{int8_size:.0f} MB</td></tr>
</table>

<h2>Video Comparison (all frames)</h2>
<table>
  <tr><th>Metric</th><th>Value</th><th>Interpretation</th></tr>
  <tr><td>SSIM (mean)</td>
      <td class="{'positive' if ssim_v > 0.97 else 'neutral' if ssim_v > 0.95 else 'negative'}">{ssim_v:.4f}</td>
      <td>{'> 0.97 = visually indistinguishable' if ssim_v > 0.97 else '> 0.95 = minor differences' if ssim_v > 0.95 else '< 0.95 = noticeable degradation'}</td></tr>
  <tr><td>PSNR (mean)</td>
      <td class="{'positive' if psnr_v > 35 else 'neutral' if psnr_v > 30 else 'negative'}">{psnr_v:.2f} dB</td>
      <td>{'> 35 dB = excellent' if psnr_v > 35 else '> 30 dB = good' if psnr_v > 30 else '< 30 dB = noticeable noise'}</td></tr>
  <tr><td>Frames compared</td><td>{video_result.get('n_compared', 0)}</td><td>All frames aligned</td></tr>
</table>

<h2>Frame Comparison (First / Last)</h2>
<table>
  <tr><th>Frame</th><th>SSIM</th><th>PSNR</th><th>MSE</th><th>Diff Heatmap</th></tr>
  {first_row}
  {last_row}
</table>

<h2>Side-by-Side Videos</h2>
<div class="side-by-side">
  <video controls width="48%"><source src="bf16.mp4" type="video/mp4"></video>
  <video controls width="48%"><source src="int8.mp4" type="video/mp4"></video>
</div>
<p style="text-align:center"><small>Left: bf16 (baseline) | Right: int8 (quantized)</small></p>

<h2>Audio Comparison</h2>
<table>
  <tr><th>Variant</th><th>Codec</th><th>Channels</th><th>Sample Rate</th><th>Duration</th></tr>
  {audio_rows}
</table>

<h2>Methodology</h2>
<ul>
  <li>Baseline: original bf16 LoRA (<code>ltx-2.3-22b-distilled-lora-384.safetensors</code>)</li>
  <li>Test: int8 quantized LoRA (<code>ltx-2.3-22b-distilled-lora-384.int8.safetensors</code>)</li>
  <li>Pipeline: dev transformer (two-stage) with distilled LoRA fused at Stage 2</li>
  <li>Video comparison via <code>compare_videos_reference()</code> — per-frame SSIM (grayscale) + PSNR (color)</li>
  <li>Frame comparison via skimage <code>structural_similarity</code> + manual PSNR</li>
</ul>
</body>
</html>"""
    report_path = os.path.join(output_dir, "report.html")
    with open(report_path, "w") as f:
        f.write(html)
    print(f"\n📊 Report: {report_path}")
    return report_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="A/B test int8 LoRA vs bf16 LoRA")
    parser.add_argument("--prompt", type=str,
                        default="A serene forest stream with gentle water flow, dappled sunlight through leaves, cinematic quality",
                        help="Video generation prompt")
    parser.add_argument("--frames", type=int, default=25,
                        help="Number of frames (25 ≈ 1 second)")
    parser.add_argument("--width", type=int, default=480,
                        help="Video width")
    parser.add_argument("--height", type=int, default=480,
                        help="Video height")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed")
    parser.add_argument("--cfg-scale", type=float, default=None,
                        help="CFG scale override")
    parser.add_argument("--stg-scale", type=float, default=None,
                        help="STG scale override")
    parser.add_argument("--output-dir", type=str, default=None,
                        help="Output directory (default: output/ab_lora_int8/)")
    args = parser.parse_args()

    # Output dir
    output_base = args.output_dir or os.path.join(cfg.OUTPUT_DIR, "ab_lora_int8")
    os.makedirs(output_base, exist_ok=True)

    # Clean up any leftover .bak files
    _cleanup_bak()

    bf16_output = os.path.join(output_base, "bf16.mp4")
    int8_output = os.path.join(output_base, "int8.mp4")

    # === Phase 1: Run with bf16 LoRA (disable int8 files) ===
    print("=" * 60)
    print("PHASE 1: Baseline — bf16 LoRA")
    print("=" * 60)
    _ensure_int8_disabled()
    bf16_result = _run_generation("bf16", bf16_output, args)

    # === Phase 2: Run with int8 LoRA (restore int8 files) ===
    print("\n" + "=" * 60)
    print("PHASE 2: Test — int8 LoRA")
    print("=" * 60)
    _ensure_int8_enabled()
    int8_result = _run_generation("int8", int8_output, args)

    # === Cleanup .bak ===
    _cleanup_bak()

    # === Verify both outputs exist ===
    if not os.path.exists(bf16_output):
        print(f"\n❌ bf16 output not found: {bf16_output}")
        sys.exit(1)
    if not os.path.exists(int8_output):
        print(f"\n❌ int8 output not found: {int8_output}")
        sys.exit(1)

    # === Phase 3: Compare ===
    print("\n" + "=" * 60)
    print("PHASE 3: Comparison")
    print("=" * 60)

    # Video comparison
    video_result = _compare_videos(bf16_output, int8_output, output_base)

    # Frame extraction + comparison
    print("\n  Extracting frames…")
    bf16_first, bf16_last = _extract_frames(bf16_output, output_base, "bf16")
    int8_first, int8_last = _extract_frames(int8_output, output_base, "int8")

    img_results = {}
    if bf16_first and int8_first:
        print("\n  Comparing first frame…")
        img_results["first"] = _compare_images(bf16_first, int8_first, "bf16", "int8")
    if bf16_last and int8_last:
        print("\n  Comparing last frame…")
        img_results["last"] = _compare_images(bf16_last, int8_last, "bf16", "int8")

    # Audio comparison
    print("\n  Checking audio…")
    audio_result = _compare_audio(bf16_output, int8_output)

    # HTML report
    print("\n  Generating report…")
    report_path = _generate_html_report(
        video_result, img_results, audio_result,
        bf16_output, int8_output, args, output_base,
    )

    # Summary — compute LoRA sizes
    lora_bf16_gb = sum(
        os.path.getsize(os.path.join(LORA_DIR, f))
        for f in BF16_FILES
        if os.path.exists(os.path.join(LORA_DIR, f))
    ) / 1024**3
    lora_int8_gb = sum(
        os.path.getsize(os.path.join(LORA_DIR, f))
        for f in INT8_FILES
        if os.path.exists(os.path.join(LORA_DIR, f))
    ) / 1024**3
    lora_save_pct = int((1 - lora_int8_gb / lora_bf16_gb) * 100) if lora_bf16_gb > 0 else 0

    ssim_v = video_result.get("ssim_mean", 0)
    psnr_v = video_result.get("psnr_mean", 0)
    print(f"\n{'='*60}")
    print(f"RESULTS")
    print(f"{'='*60}")
    print(f"  Video SSIM:       {ssim_v:.4f}")
    print(f"  Video PSNR:       {psnr_v:.2f} dB")
    print(f"  Frames:           {video_result.get('n_compared', 0)}")
    if "first" in img_results:
        print(f"  First frame SSIM: {img_results['first'].get('ssim', 0):.4f}")
        print(f"  Last frame SSIM:  {img_results['last'].get('ssim', 0):.4f}")
    print(f"  LoRA disk:        {lora_bf16_gb:.1f} GB → {lora_int8_gb:.1f} GB ({lora_save_pct}% savings)")
    print(f"\n  📊 Report: {report_path}")


if __name__ == "__main__":
    main()
