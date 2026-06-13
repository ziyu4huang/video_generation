#!/usr/bin/env python3
"""Test SeedVR2 upscale with both BF16 and INT8 VAE, compare outputs."""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.seedvr2.pipeline import SeedVR2Upscaler
from app import config as cfg
from PIL import Image


def main():
    # Use cfg-based absolute paths
    input_path = os.path.join(cfg.OUTPUT_DIR, "seedvr2_test_input.png")
    if not os.path.exists(input_path):
        import glob
        files = sorted(glob.glob(os.path.join(cfg.OUTPUT_DIR, "output_20260613_*.png")))
        if files:
            input_path = files[-1]
        else:
            print(f"[test] ERROR: input image not found at {input_path}")
            sys.exit(1)

    print(f"[test] Input: {input_path}")
    image = Image.open(input_path).convert("RGB")
    print(f"[test] Size: {image.size}")

    # VAE paths
    bf16_dir = cfg.SEEDVR2_VAE_DIR
    int8_dir = os.path.join(cfg.MODELS_DIR, "vae", "seedvr2-vae-int8")

    results = {}

    for label, vae_dir in [("BF16", bf16_dir), ("INT8", int8_dir)]:
        print(f"\n{'='*60}")
        print(f"[test] Running upscale with {label} VAE ({vae_dir})")
        print(f"{'='*60}")

        t0 = time.time()
        upscaler = SeedVR2Upscaler(model_size="7b", vae_dir=vae_dir)
        result = upscaler.upscale(
            image,
            resolution=2.0,   # 2x upscale
            softness=0.5,     # enhance mode
            seed=42,
        )
        elapsed = time.time() - t0

        out_path = os.path.join(cfg.OUTPUT_DIR, f"seedvr2_upscale_{label.lower()}.png")
        result.save(out_path)
        print(f"[test] Saved: {out_path} ({result.size[0]}x{result.size[1]}) in {elapsed:.1f}s")

        results[label] = {
            "path": out_path,
            "size": result.size,
            "elapsed": elapsed,
            "image": result,
        }

    # Compare
    print(f"\n{'='*60}")
    print("[test] Comparison Summary")
    print(f"{'='*60}")
    for label, r in results.items():
        print(f"  {label}: {r['path']} ({r['size'][0]}x{r['size'][1]}) in {r['elapsed']:.1f}s")

    print(f"\n[test] Done. Run comparison script next.")


if __name__ == "__main__":
    main()
