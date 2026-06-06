#!/usr/bin/env python3
"""mlx-movie-director: Generate images with moody Z-Image MLX pipeline.

Usage:
    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --prompt "a moody portrait photo" \\
        --width 1024 --height 1024 --steps 9 --seed 42

    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --prompt-file prompts/moody_scene.txt
"""

import sys
import os
import argparse
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.pipeline import ZImagePipeline
from app import config as cfg


def main():
    parser = argparse.ArgumentParser(
        description="mlx-movie-director: moody Z-Image generation on Apple Silicon",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--prompt", type=str, help="Text prompt for generation")
    group.add_argument("--prompt-file", type=str, help="Path to a text file containing the prompt")
    parser.add_argument("--width", type=int, default=1024, help="Image width (default: 1024)")
    parser.add_argument("--height", type=int, default=1024, help="Image height (default: 1024)")
    parser.add_argument("--steps", type=int, default=9, help="Number of denoising steps (default: 9)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    parser.add_argument("--lora-path", type=str, default=None, help="Path to LoRA .safetensors file")
    parser.add_argument("--lora-scale", type=float, default=1.0, help="LoRA scale factor (default: 1.0)")
    args = parser.parse_args()

    if args.prompt_file:
        with open(args.prompt_file, "r") as f:
            prompt = f.read().strip()
    else:
        prompt = args.prompt

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)

    pipeline = ZImagePipeline()
    image = pipeline.generate(
        prompt=prompt,
        width=args.width,
        height=args.height,
        steps=args.steps,
        seed=args.seed,
        lora_path=args.lora_path,
        lora_scale=args.lora_scale,
    )

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"output_{timestamp}.png")
    image.save(out_path)
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
