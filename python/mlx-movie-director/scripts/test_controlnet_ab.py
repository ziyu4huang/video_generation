#!/usr/bin/env python3
"""Compare ControlNet BF16 vs 4-bit MLX using the pipeline's own _execute_generation."""

import gc
import os
import sys
import time
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from PIL import Image
from app import config as cfg
from app.commands.image import _controlnet as cnet

try:
    from skimage.metrics import structural_similarity as ssim
    from skimage.metrics import peak_signal_noise_ratio as psnr
    HAS_SKIMAGE = True
except ImportError:
    HAS_SKIMAGE = False

import mlx.core as mx


def main():
    prompt = "A young woman standing in a sunlit garden, soft focus background, cinematic lighting, photorealistic portrait"
    seed = 42
    out_w, out_h = 640, 960
    steps = 9
    strength = 0.8

    bf16_dir = cfg.CONTROLNET_DIR
    mlx_dir = os.path.join(cfg.MODELS_DIR, "controlnet",
                           "zimage-turbo-fun-union-2.1-mlx")

    # Step 1: Create a reference image for ControlNet preprocessing
    # (A simple gradient image with a visible edge pattern)
    ref_path = os.path.join(cfg.OUTPUT_DIR, "cnet_test_ref.png")
    if not os.path.exists(ref_path):
        ref_arr = np.zeros((out_h, out_w, 3), dtype=np.uint8)
        # Vertical gradient + diagonal line pattern for canny edge detection
        for y in range(out_h):
            for x in range(out_w):
                val = int(128 + 64 * np.sin(x / 40) + 64 * np.cos(y / 30))
                ref_arr[y, x] = [val, val, min(255, val + 30)]
        Image.fromarray(ref_arr).save(ref_path)
        print(f"[test] Created reference: {ref_path}")
    else:
        print(f"[test] Using cached reference: {ref_path}")

    # Step 2: Run with BF16 ControlNet
    print(f"\n{'='*60}")
    print("  BF16 ControlNet")
    print(f"{'='*60}")
    orig_dir = cfg.CONTROLNET_DIR
    cfg.CONTROLNET_DIR = bf16_dir
    try:
        t0 = time.time()
        img_bf16 = cnet._execute_generation(
            prompt, ref_path, "canny", strength,
            skip_preprocess=False, blur_ref=None, remove_outlines=False,
            out_w=out_w, out_h=out_h, steps=steps, seed=seed,
        )
        t_bf16 = time.time() - t0
    finally:
        cfg.CONTROLNET_DIR = orig_dir

    bf16_path = os.path.join(cfg.OUTPUT_DIR, "cnet_compare_bf16.png")
    img_bf16.save(bf16_path)
    print(f"  BF16 done in {t_bf16:.0f}s → {bf16_path}")

    # Cleanup
    del img_bf16
    gc.collect()
    mx.metal.clear_cache()

    # Step 3: Run with 4-bit MLX ControlNet
    print(f"\n{'='*60}")
    print("  4-bit MLX ControlNet")
    print(f"{'='*60}")
    cfg.CONTROLNET_DIR = mlx_dir
    try:
        t0 = time.time()
        img_mlx = cnet._execute_generation(
            prompt, ref_path, "canny", strength,
            skip_preprocess=False, blur_ref=None, remove_outlines=False,
            out_w=out_w, out_h=out_h, steps=steps, seed=seed,
        )
        t_mlx = time.time() - t0
    finally:
        cfg.CONTROLNET_DIR = orig_dir

    mlx_path = os.path.join(cfg.OUTPUT_DIR, "cnet_compare_4bit.png")
    img_mlx.save(mlx_path)
    print(f"  4-bit done in {t_mlx:.0f}s → {mlx_path}")

    # Step 4: Compare
    print(f"\n{'='*60}")
    print("  Similarity Metrics")
    print(f"{'='*60}")
    a = np.array(Image.open(bf16_path).convert("RGB")).astype(np.float64)
    b = np.array(Image.open(mlx_path).convert("RGB")).astype(np.float64)

    metrics = {"mse": float(np.mean((a - b) ** 2))}
    if HAS_SKIMAGE:
        metrics["ssim"] = float(ssim(a, b, channel_axis=2, data_range=255))
        metrics["psnr"] = float(psnr(a, b, data_range=255))
    else:
        mse_v = metrics["mse"]
        metrics["ssim"] = None
        metrics["psnr"] = float("inf") if mse_v == 0 else float(20 * np.log10(255.0) - 10 * np.log10(mse_v))

    diff = np.abs(a - b)
    dmax = float(diff.max())
    if dmax > 0:
        diff_norm = (diff / dmax * 255).clip(0, 255).astype(np.uint8)
    else:
        diff_norm = np.zeros_like(diff, dtype=np.uint8)
    diff_path = os.path.join(cfg.OUTPUT_DIR, "cnet_compare_diff.png")
    Image.fromarray(diff_norm, "RGB").save(diff_path)

    ssim_s = f"{metrics['ssim']*100:.4f}%" if metrics.get("ssim") else "N/A"
    print(f"  SSIM: {ssim_s}")
    print(f"  PSNR: {metrics['psnr']:.2f} dB")
    print(f"  MSE:  {metrics['mse']:.4f}")
    print(f"  Max pixel diff: {dmax:.1f}/255")

    # File sizes
    bf16_mb = os.path.getsize(os.path.join(bf16_dir, "model.safetensors")) / 1048576
    mlx_mb = os.path.getsize(os.path.join(mlx_dir, "model.safetensors")) / 1048576

    # Verdict
    if metrics.get("ssim") and metrics["ssim"] > 0.99:
        verdict = "Near-lossless"
        vicon = "✅"
    elif metrics.get("ssim") and metrics["ssim"] > 0.95:
        verdict = "Minor degradation"
        vicon = "⚠️"
    else:
        verdict = "Significant differences"
        vicon = "❓"

    # HTML
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ControlNet A/B Test — BF16 vs MLX 4-bit</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e; color: #e0e0e0; padding: 24px; max-width: 1400px; margin: 0 auto;
  }}
  h1 {{ font-size: 24px; margin-bottom: 8px; color: #fff; }}
  .subtitle {{ color: #aaa; margin-bottom: 24px; }}
  .section {{ margin-bottom: 32px; }}
  .section-title {{ font-size: 16px; font-weight: 600; padding-bottom: 6px; border-bottom: 1px solid #333; color: #ccc; margin-bottom: 12px; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }}
  .card {{ background: #16213e; border-radius: 12px; overflow: hidden; border: 1px solid #0f3460; }}
  .card img {{ width: 100%; display: block; }}
  .card-label {{ padding: 8px 12px; font-weight: 600; font-size: 13px; background: #0f3460; display: flex; justify-content: space-between; }}
  .card-label .size {{ color: #888; font-weight: 400; }}
  .metrics-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }}
  .metric-card {{ background: #16213e; border-radius: 10px; padding: 16px; text-align: center; border: 1px solid #0f3460; }}
  .metric-value {{ font-size: 28px; font-weight: 700; color: #4ecca3; }}
  .metric-label {{ font-size: 12px; color: #888; text-transform: uppercase; margin-top: 4px; }}
  .metric-note {{ font-size: 11px; color: #666; margin-top: 4px; }}
  table {{ width: 100%; border-collapse: collapse; background: #16213e; border-radius: 10px; overflow: hidden; }}
  th, td {{ padding: 10px 14px; border-bottom: 1px solid #0f3460; font-size: 13px; text-align: left; }}
  th {{ background: #0f3460; color: #ccc; }}
  .verdict {{ background: #16213e; border-radius: 10px; padding: 16px; border: 1px solid #0f3460; }}
  .verdict h3 {{ color: #4ecca3; }} .verdict p {{ color: #aaa; font-size: 14px; line-height: 1.6; margin-top: 8px; }}
</style>
</head>
<body>
<h1>ControlNet A/B Test</h1>
<p class="subtitle">BF16 ({bf16_mb:.0f} MB) vs MLX 4-bit GS32 ({mlx_mb:.0f} MB) &mdash; {((1-mlx_mb/bf16_mb)*100):.0f}% size reduction</p>

<div class="section">
  <div class="section-title">Side-by-Side Output</div>
  <div class="grid">
    <div class="card">
      <div class="card-label">BF16 ControlNet <span class="size">{bf16_mb:.0f} MB</span></div>
      <img src="cnet_compare_bf16.png" alt="BF16">
    </div>
    <div class="card">
      <div class="card-label">4-bit MLX <span class="size">{mlx_mb:.0f} MB</span></div>
      <img src="cnet_compare_4bit.png" alt="4-bit">
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Similarity Metrics</div>
  <div class="metrics-grid">
    <div class="metric-card"><div class="metric-value">{ssim_s}</div><div class="metric-label">SSIM</div><div class="metric-note">100% = identical</div></div>
    <div class="metric-card"><div class="metric-value">{metrics['psnr']:.2f} dB</div><div class="metric-label">PSNR</div><div class="metric-note">&gt;40 dB = near identical</div></div>
    <div class="metric-card"><div class="metric-value">{metrics['mse']:.4f}</div><div class="metric-label">MSE</div><div class="metric-note">0 = identical</div></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Difference Heatmap (max diff: {dmax:.1f}/255)</div>
  <div class="card"><img src="cnet_compare_diff.png" alt="diff" style="width:100%;"></div>
  <p style="color:#888;font-size:12px;margin-top:8px;">Brighter = larger difference. Black = identical pixels.</p>
</div>

<div class="section">
  <div class="section-title">Model Stats</div>
  <table>
    <tr><th>Metric</th><th>BF16</th><th>4-bit</th><th>Delta</th></tr>
    <tr><td>Weight file</td><td>{bf16_mb:.0f} MB</td><td>{mlx_mb:.0f} MB</td><td>-{bf16_mb-mlx_mb:.0f} MB</td></tr>
    <tr><td>Generation</td><td>{t_bf16:.0f}s</td><td>{t_mlx:.0f}s</td><td>{t_mlx-t_bf16:.0f}s</td></tr>
  </table>
</div>

<div class="section">
  <div class="section-title">Verdict</div>
  <div class="verdict">
    <h3>{vicon} 4-bit quantization: {verdict}</h3>
    <p>SSIM: {ssim_s} | PSNR: {metrics['psnr']:.2f} dB | MSE: {metrics['mse']:.4f}</p>
    <p>ControlNet uses exclusively Linear layers (152 total) &mdash; ideal for MLX 4-bit quantization.<br>
    Model size reduced from {bf16_mb:.0f} MB to {mlx_mb:.0f} MB ({((1-mlx_mb/bf16_mb)*100):.0f}% savings).</p>
  </div>
</div>
</body>
</html>"""

    html_path = os.path.join(cfg.OUTPUT_DIR, "cnet_ab_test.html")
    with open(html_path, "w") as f:
        f.write(html)
    print(f"\nHTML report: {html_path}")
    subprocess.run(["open", html_path])
    print("Browser opened.")


if __name__ == "__main__":
    main()
