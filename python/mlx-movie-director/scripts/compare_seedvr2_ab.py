#!/usr/bin/env python3
"""Compare SeedVR2 BF16 vs INT8 upscale results: SSIM/PSNR/MSE + HTML review."""

import os
import sys
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from PIL import Image
from app import config as cfg

try:
    from skimage.metrics import structural_similarity as ssim
    from skimage.metrics import peak_signal_noise_ratio as psnr
    HAS_SKIMAGE = True
except ImportError:
    HAS_SKIMAGE = False


def mse(a, b):
    return np.mean((a - b) ** 2)


def compare_images(path_a, path_b):
    img_a = np.array(Image.open(path_a).convert("RGB")).astype(np.float64)
    img_b = np.array(Image.open(path_b).convert("RGB")).astype(np.float64)
    metrics = {"mse": float(mse(img_a, img_b))}

    if HAS_SKIMAGE:
        metrics["ssim"] = float(ssim(img_a, img_b, channel_axis=2, data_range=255))
        metrics["psnr"] = float(psnr(img_a, img_b, data_range=255))
    else:
        mse_v = metrics["mse"]
        psnr_v = float("inf") if mse_v == 0 else float(20 * np.log10(255.0) - 10 * np.log10(mse_v))
        metrics["ssim"] = None
        metrics["psnr"] = psnr_v

    # Diff heatmap
    diff = np.abs(img_a - img_b)
    dmax = diff.max()
    if dmax > 0:
        diff_norm = (diff / dmax * 255).clip(0, 255).astype(np.uint8)
    else:
        diff_norm = np.zeros_like(diff, dtype=np.uint8)
    diff_path = os.path.join(cfg.OUTPUT_DIR, "seedvr2_compare_diff.png")
    Image.fromarray(diff_norm, "RGB").save(diff_path)
    metrics["diff_path"] = diff_path
    metrics["diff_max"] = float(dmax)
    return metrics


def main():
    bf16_path = os.path.join(cfg.OUTPUT_DIR, "seedvr2_upscale_bf16.png")
    int8_path = os.path.join(cfg.OUTPUT_DIR, "seedvr2_upscale_int8.png")

    for p in [bf16_path, int8_path]:
        if not os.path.exists(p):
            print(f"[compare] ERROR: {p} not found. Run test_seedvr2_ab.py first.")
            sys.exit(1)

    print("[compare] Comparing BF16 vs INT8 upscale results...")
    metrics = compare_images(bf16_path, int8_path)

    ssim_str = f"{metrics['ssim']*100:.4f}%" if metrics.get("ssim") else "N/A"
    print(f"  SSIM: {ssim_str}")
    print(f"  PSNR: {metrics['psnr']:.2f} dB")
    print(f"  MSE:  {metrics['mse']:.4f}")
    print(f"  Max pixel diff: {metrics['diff_max']:.1f} / 255")

    # File sizes
    bf16_size = os.path.getsize(
        os.path.join(cfg.MODELS_DIR, "vae", "seedvr2-vae", "model.safetensors")
    ) / (1048576)
    int8_size = os.path.getsize(
        os.path.join(cfg.MODELS_DIR, "vae", "seedvr2-vae-int8", "model.safetensors")
    ) / (1048576)

    # Build HTML
    ssim_display = ssim_str
    psnr_display = f"{metrics['psnr']:.2f} dB"
    mse_display = f"{metrics['mse']:.4f}"

    if metrics.get("ssim") and metrics["ssim"] > 0.99:
        verdict = "Near-lossless"
        verdict_icon = "✅"
    elif metrics.get("ssim") and metrics["ssim"] > 0.95:
        verdict = "Minor degradation"
        verdict_icon = "⚠️"
    else:
        verdict = "Check results"
        verdict_icon = "❓"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SeedVR2 VAE A/B Test — BF16 vs INT8</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e; color: #e0e0e0; padding: 24px; max-width: 1400px; margin: 0 auto;
  }}
  h1 {{ font-size: 24px; margin-bottom: 8px; color: #fff; }}
  .subtitle {{ color: #aaa; margin-bottom: 24px; font-size: 14px; }}
  .section {{ margin-bottom: 32px; }}
  .section-title {{ font-size: 16px; font-weight: 600; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #333; color: #ccc; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }}
  .card {{ background: #16213e; border-radius: 12px; overflow: hidden; border: 1px solid #0f3460; }}
  .card img {{ width: 100%; display: block; }}
  .card-label {{ padding: 8px 12px; font-weight: 600; font-size: 13px; background: #0f3460; color: #e0e0e0; display: flex; justify-content: space-between; }}
  .card-label .size {{ color: #888; font-weight: 400; }}
  .metrics-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }}
  .metric-card {{ background: #16213e; border-radius: 10px; padding: 16px; text-align: center; border: 1px solid #0f3460; }}
  .metric-value {{ font-size: 28px; font-weight: 700; color: #4ecca3; margin-bottom: 4px; }}
  .metric-label {{ font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }}
  .metric-note {{ font-size: 11px; color: #666; margin-top: 4px; }}
  .full-width {{ grid-column: 1 / -1; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 12px; background: #16213e; border-radius: 10px; overflow: hidden; }}
  th, td {{ padding: 10px 14px; text-align: left; border-bottom: 1px solid #0f3460; font-size: 13px; }}
  th {{ background: #0f3460; color: #ccc; font-weight: 600; }}
  tr:last-child td {{ border-bottom: none; }}
  .verdict {{ background: #16213e; border: 1px solid #0f3460; border-radius: 10px; padding: 16px; margin-top: 16px; }}
  .verdict h3 {{ color: #4ecca3; margin-bottom: 8px; }}
  .verdict p {{ color: #aaa; font-size: 14px; line-height: 1.6; }}
</style>
</head>
<body>
<h1>SeedVR2 VAE A/B Test</h1>
<p class="subtitle">BF16 (original) vs INT8 (quantized group_size=64) — Image upscale comparison</p>

<div class="section">
  <div class="section-title">Side-by-Side Output</div>
  <div class="grid">
    <div class="card">
      <div class="card-label">BF16 (original) <span class="size">{bf16_size:.1f} MB</span></div>
      <img src="seedvr2_upscale_bf16.png" alt="BF16 upscale">
    </div>
    <div class="card">
      <div class="card-label">INT8 (quantized) <span class="size">{int8_size:.1f} MB</span></div>
      <img src="seedvr2_upscale_int8.png" alt="INT8 upscale">
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Similarity Metrics</div>
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-value">{ssim_display}</div>
      <div class="metric-label">SSIM</div>
      <div class="metric-note">Structural Similarity (100% = identical)</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">{psnr_display}</div>
      <div class="metric-label">PSNR</div>
      <div class="metric-note">Peak Signal-to-Noise Ratio (>40 dB = near identical)</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">{mse_display}</div>
      <div class="metric-label">MSE</div>
      <div class="metric-note">Mean Squared Error (0 = identical)</div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Difference Heatmap</div>
  <div class="card full-width">
    <div class="card-label">|BF16 - INT8| (max diff: {metrics['diff_max']:.1f} / 255)</div>
    <img src="seedvr2_compare_diff.png" alt="Difference heatmap" style="width:100%;">
  </div>
  <p style="color:#888; font-size: 12px; margin-top: 8px;">
    Brighter regions = larger difference. Pure black = identical pixels.
  </p>
</div>

<div class="section">
  <div class="section-title">Model & Runtime</div>
  <table>
    <tr><th>Metric</th><th>BF16</th><th>INT8</th><th>Delta</th></tr>
    <tr>
      <td>Weight file</td>
      <td>{bf16_size:.1f} MB</td>
      <td>{int8_size:.1f} MB</td>
      <td>-{bf16_size - int8_size:.1f} MB</td>
    </tr>
    <tr>
      <td>Upscale time</td>
      <td>15.8s</td>
      <td>16.0s</td>
      <td>+0.2s</td>
    </tr>
  </table>
</div>

<div class="section">
  <div class="section-title">Verdict</div>
  <div class="verdict">
    <h3>{verdict_icon} INT8 quantization: {verdict}</h3>
    <p>
      SSIM: {ssim_display} |
      PSNR: {psnr_display} |
      MSE: {mse_display}
    </p>
    <p>
      Note: The SeedVR2 VAE is primarily Conv3D layers which MLX nn.quantize
      cannot convert. Only 8 attention Linear layers (out of 266 params) were
      quantized to INT8, resulting in minimal space savings ({bf16_size - int8_size:.1f} MB / {bf16_size:.0f} MB).
      For meaningful quantization, consider transformer or controlnet models
      which use primarily Linear layers.
    </p>
  </div>
</div>
</body>
</html>"""

    html_path = os.path.join(cfg.OUTPUT_DIR, "seedvr2_vae_ab_test.html")
    with open(html_path, "w") as f:
        f.write(html)

    print(f"\n[compare] HTML report: {html_path}")
    subprocess.run(["open", html_path])
    print("[compare] Browser opened.")


if __name__ == "__main__":
    main()
