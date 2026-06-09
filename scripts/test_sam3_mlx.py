#!/usr/bin/env python3
"""test_sam3_mlx.py — Proof-of-concept for SAM3 text-prompted segmentation on Apple Silicon.

Uses mlx-vlm's Sam3Predictor with the mlx-community/sam3.1-bf16 model.
Downloads the model on first run (HuggingFace cache).

Usage:
    python/venv/bin/python scripts/test_sam3_mlx.py --image <path> --prompt "woman's face"
    python/venv/bin/python scripts/test_sam3_mlx.py  # defaults to a test image
"""

import argparse
import os
import sys
import time

# Ensure mlx-movie-director's venv is used
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
VENV_PYTHON = os.path.join(REPO_DIR, "python", "venv", "bin", "python")

# Default test image (portrait)
DEFAULT_IMAGE = os.path.join(
    REPO_DIR, "python", "mlx-movie-director", "output", "output_20260609_192145.png"
)
DEFAULT_PROMPT = "woman's face"

MODEL_ID = "mlx-community/sam3.1-bf16"
OUTPUT_DIR = os.path.join(REPO_DIR, "scripts", "output_sam3_test")


def main():
    parser = argparse.ArgumentParser(description="SAM3 text-prompted segmentation (MLX)")
    parser.add_argument("--image", default=DEFAULT_IMAGE, help="Input image path")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="Text prompt for segmentation")
    parser.add_argument("--model", default=MODEL_ID, help="HuggingFace model ID")
    parser.add_argument("--threshold", type=float, default=0.3, help="Score threshold")
    parser.add_argument("--output-dir", default=OUTPUT_DIR, help="Output directory")
    args = parser.parse_args()

    # Import MLX deps
    import mlx.core as mx
    import numpy as np
    from PIL import Image

    from mlx_vlm.models.sam3.generate import Sam3Predictor
    from mlx_vlm.models.sam3_1.processing_sam3_1 import Sam31Processor
    from mlx_vlm.utils import get_model_path, load_model

    # Load image
    print(f"[sam3-test] Loading image: {args.image}")
    image = Image.open(args.image).convert("RGB")
    print(f"  Size: {image.size}, Mode: {image.mode}")

    # Load model
    print(f"[sam3-test] Loading model: {args.model}")
    t0 = time.perf_counter()
    mp = get_model_path(args.model)
    model = load_model(mp)
    processor = Sam31Processor.from_pretrained(str(mp))
    predictor = Sam3Predictor(model, processor, score_threshold=args.threshold)
    t_load = time.perf_counter() - t0
    print(f"  Model loaded in {t_load:.1f}s")

    # Run segmentation
    print(f"[sam3-test] Running segmentation with prompt: '{args.prompt}'")
    t0 = time.perf_counter()
    result = predictor.predict(image, text_prompt=args.prompt)
    t_seg = time.perf_counter() - t0
    print(f"  Segmentation done in {t_seg:.2f}s")
    print(f"  Found {len(result.scores)} detections")

    for i, (score, box) in enumerate(zip(result.scores, result.boxes)):
        x0, y0, x1, y1 = box
        print(f"    [{i}] score={score:.3f} box=({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f})")

    # Save results
    os.makedirs(args.output_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.image))[0]
    prompt_slug = args.prompt.replace(" ", "_").replace("'", "")[:30]

    # Save individual masks
    for i in range(len(result.scores)):
        mask = result.masks[i]  # (H, W) binary
        mask_img = Image.fromarray(mask * 255)
        mask_path = os.path.join(args.output_dir, f"{base}_{prompt_slug}_mask{i}_s{result.scores[i]:.2f}.png")
        mask_img.save(mask_path)
        print(f"  Saved: {mask_path}")

    # Save composite overlay
    if len(result.scores) > 0:
        overlay = np.array(image).copy()
        # Use different colors for each detection
        colors = [
            [255, 0, 0],    # red
            [0, 255, 0],    # green
            [0, 0, 255],    # blue
            [255, 255, 0],  # yellow
            [255, 0, 255],  # magenta
        ]
        for i in range(len(result.scores)):
            mask = result.masks[i]
            color = colors[i % len(colors)]
            binary = mask > 0
            overlay[binary] = (overlay[binary] * 0.5 + np.array(color) * 0.5).astype(np.uint8)

        overlay_path = os.path.join(args.output_dir, f"{base}_{prompt_slug}_overlay.png")
        Image.fromarray(overlay).save(overlay_path)
        print(f"  Saved overlay: {overlay_path}")

    # Save masked (extracted) region
    if len(result.scores) > 0:
        # Use the best scoring mask
        best_idx = np.argmax(result.scores)
        mask = result.masks[best_idx]
        img_np = np.array(image)
        # Alpha-blend: transparent outside mask
        masked = img_np.copy()
        alpha = np.zeros_like(mask, dtype=np.uint8)
        alpha[mask > 0] = 255
        rgba = np.dstack([masked, alpha])
        masked_path = os.path.join(args.output_dir, f"{base}_{prompt_slug}_extracted.png")
        Image.fromarray(rgba, mode="RGBA").save(masked_path)
        print(f"  Saved extracted: {masked_path}")

    print(f"\n[sam3-test] Done. {len(result.scores)} detections in {t_seg:.2f}s")
    print(f"  Output dir: {args.output_dir}")


if __name__ == "__main__":
    main()
