#!/usr/bin/env python3
"""Depth-Anything-V2 preprocessor for the krea2 ControlNet validation.

Produces a depth PNG (single-channel, brighter = nearer) from an input image,
sized to the target generation dims. The krea2 `controlnet` CLI consumes this
directly as --control-image (channel-mode gray + normalize minmax).

Run from repo root:
  ../video_generation__venv/bin/python python/mlx-movie-director/scripts/depth_anything_preprocess.py \
      --input <photo> --output depth.png --size 512

Model: depth-anything/Depth-Anything-V2-Small-hf (~100MB, HF). Cached under
~/.cache/huggingface. Falls back to MPS, then CPU.
"""
import argparse, os, sys
import numpy as np
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--size", type=int, default=512, help="output square size")
    ap.add_argument("--model", default="depth-anything/Depth-Anything-V2-Small-hf")
    args = ap.parse_args()

    import torch
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[depth] device={device} model={args.model}", file=sys.stderr)
    proc = AutoImageProcessor.from_pretrained(args.model)
    model = AutoModelForDepthEstimation.from_pretrained(args.model).to(device).eval()

    img = Image.open(args.input).convert("RGB")
    inputs = proc(images=img, return_tensors="pt").to(device)
    with torch.no_grad():
        depth = model(**inputs).predicted_depth          # (1, H, W) or (H, W)
    depth = depth.squeeze().float().cpu().numpy()
    # Depth-Anything predicts inverse-relative depth (larger = nearer).
    # Bright = near: normalize to [0,1] then invert so near is bright? The krea2
    # pipeline minmax-normalizes anyway; keep raw ordinality (larger value nearer).
    d = (depth - depth.min()) / (depth.max() - depth.min() + 1e-9)
    # Resize to target square via PIL (the controlnet CLI also resizes to W×H).
    dimg = Image.fromarray((d * 255).astype(np.uint8)).resize(
        (args.size, args.size), Image.BILINEAR)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    dimg.save(args.output)
    print(f"[depth] saved {args.output} (size {dimg.size})", file=sys.stderr)


if __name__ == "__main__":
    main()
