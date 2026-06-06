#!/usr/bin/env python3
"""mlx-movie-director: Generate images with moody Z-Image MLX pipeline.

Usage:
    # Text-to-image
    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --prompt "a moody portrait photo" \\
        --width 640 --height 960 --steps 9 --seed 42

    # Text-to-image + ESRGAN upscale (4×)
    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --prompt "..." --width 640 --height 960 --upscale

    # img2img: refine an existing image (latent upscale 1.7× + denoise 50%)
    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --prompt "..." --input-image output/base.png \\
        --latent-upscale 1.7 --denoise-strength 0.5

    # Batch: generate 4 images with seeds 100..103
    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --prompt "..." --count 4 --seed-start 100

    # Replay a previous run
    ./python/venv/bin/python python/mlx-movie-director/run.py \\
        --replay output/output_20260606_220112.run.json
"""

import sys
import os
import argparse
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from app.pipeline import ZImagePipeline, GenerationResult
from app.run_config import RunConfig
from app.manifest import Manifest, collect_model_fingerprint
from app import config as cfg

# ---------------------------------------------------------------------------
# Action registry
# ---------------------------------------------------------------------------

KNOWN_ACTIONS = ["text2img", "img2img"]

DEFAULT_UPSCALE_MODEL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "comfyui_data", "models", "upscale_models", "4xNomosWebPhoto_RealPLKSR.pth"
)


def _build_generate_kwargs(run_config: RunConfig, prompt: str, seed: int) -> dict:
    """Build kwargs for pipeline.generate() from a RunConfig."""
    input_image = None
    if run_config.input_image:
        input_image = Image.open(run_config.input_image).convert("RGB")

    upscale_model = run_config.upscale_model
    if run_config.upscale and not upscale_model:
        upscale_model = DEFAULT_UPSCALE_MODEL

    return dict(
        prompt=prompt,
        width=run_config.width,
        height=run_config.height,
        steps=run_config.steps,
        seed=seed,
        lora_path=run_config.lora_path,
        lora_scale=run_config.lora_scale,
        input_image=input_image,
        latent_upscale=run_config.latent_upscale,
        denoise_strength=run_config.denoise_strength,
        upscale=run_config.upscale,
        upscale_model=upscale_model,
    )


def run_generation(run_config: RunConfig):
    """Execute one or more generations (respects count/seed_start). Returns list of GenerationResult."""
    # Resolve prompt
    prompt = run_config.prompt
    if run_config.prompt_file:
        with open(run_config.prompt_file, "r") as f:
            prompt = f.read().strip()

    if not prompt:
        raise ValueError("No prompt provided. Use --prompt or --prompt-file.")

    count = max(1, run_config.count)
    seed_start = run_config.seed_start

    pipeline = ZImagePipeline()
    results = []

    for i in range(count):
        if seed_start is not None:
            seed = seed_start + i
        else:
            seed = run_config.seed

        if count > 1:
            print(f"\n=== Batch {i + 1}/{count} (seed={seed}) ===")

        kwargs = _build_generate_kwargs(run_config, prompt, seed)
        result = pipeline.generate(**kwargs)
        results.append((seed, result))

    return results


ACTION_HANDLERS = {
    "text2img": run_generation,
    "img2img": run_generation,  # same handler — input_image param drives behaviour
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args():
    parser = argparse.ArgumentParser(
        description="mlx-movie-director: moody Z-Image generation on Apple Silicon",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Top-level options
    parser.add_argument(
        "--action",
        choices=KNOWN_ACTIONS,
        default="text2img",
        help="Action to perform (default: text2img; img2img requires --input-image)",
    )
    parser.add_argument(
        "--replay",
        type=str,
        default=None,
        help="Path to a .run.json file to replay",
    )

    # Generation args
    gen_group = parser.add_argument_group("generation options")
    prompt_grp = gen_group.add_mutually_exclusive_group()
    prompt_grp.add_argument("--prompt", type=str, help="Text prompt for generation")
    prompt_grp.add_argument(
        "--prompt-file", type=str, help="Path to a text file containing the prompt"
    )
    gen_group.add_argument("--width", type=int, default=640, help="Image width (default: 640)")
    gen_group.add_argument("--height", type=int, default=960, help="Image height (default: 960)")
    gen_group.add_argument("--steps", type=int, default=9, help="Number of denoising steps (default: 9)")
    gen_group.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    gen_group.add_argument("--lora-path", type=str, default=None, help="Path to LoRA .safetensors file")
    gen_group.add_argument("--lora-scale", type=float, default=1.0, help="LoRA scale factor (default: 1.0)")

    # img2img args
    img2img_group = parser.add_argument_group("img2img options")
    img2img_group.add_argument(
        "--input-image", type=str, default=None,
        help="Input image path for img2img / latent refinement",
    )
    img2img_group.add_argument(
        "--latent-upscale", type=float, default=1.0,
        help="Upscale input latent by this factor before denoising (e.g. 1.7 matches moody flow stage 2)",
    )
    img2img_group.add_argument(
        "--denoise-strength", type=float, default=1.0,
        help="Denoising strength for img2img: 1.0=full re-denoise, 0.5=half (default: 1.0)",
    )

    # Upscale args
    up_group = parser.add_argument_group("upscale options")
    up_group.add_argument(
        "--upscale", action="store_true", default=False,
        help="Run ESRGAN upscale after generation (default: 4xNomosWebPhoto_RealPLKSR.pth)",
    )
    up_group.add_argument(
        "--upscale-model", type=str, default=None,
        help=f"Path to ESRGAN .pth model (default: {DEFAULT_UPSCALE_MODEL})",
    )

    # Batch args
    batch_group = parser.add_argument_group("batch options")
    batch_group.add_argument(
        "--count", type=int, default=1,
        help="Number of images to generate (default: 1)",
    )
    batch_group.add_argument(
        "--seed-start", type=int, default=None,
        help="Starting seed for batch; seeds will be seed_start, seed_start+1, ... (overrides --seed in batch mode)",
    )

    return parser.parse_args()


def generate_base_name() -> str:
    """Generate a timestamp-based base name for output files."""
    return f"output_{time.strftime('%Y%m%d_%H%M%S')}"


def main():
    from datetime import datetime, timezone

    args = parse_args()

    # Build or load run config
    if args.replay:
        run_config = RunConfig.from_json(args.replay)
        print(f"Replaying: {args.replay} (action={run_config.action})")
    else:
        # Auto-detect img2img action
        action = args.action
        if getattr(args, "input_image", None) and action == "text2img":
            action = "img2img"
        run_config = RunConfig.from_args(args, action=action)

    # Validate action
    handler = ACTION_HANDLERS.get(run_config.action)
    if handler is None:
        print(f"Error: unknown action '{run_config.action}'. Known: {KNOWN_ACTIONS}")
        sys.exit(1)

    # Prepare output directory
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)

    # Generate ONE base_name for all output files (run.json, images, manifest.json)
    base_name = generate_base_name()
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")

    # Write run config BEFORE execution
    run_config.to_json(run_file)

    # Collect model fingerprints (fast: reads first+last 1MB of each file)
    upscale_model = None
    if run_config.upscale:
        upscale_model = run_config.upscale_model or DEFAULT_UPSCALE_MODEL
    models = collect_model_fingerprint(
        lora_path=run_config.lora_path,
        upscale_model=upscale_model if run_config.upscale else None,
    )

    start_time = datetime.now(timezone.utc).isoformat()
    timings_so_far = {}

    try:
        results = handler(run_config)  # list of (seed, GenerationResult)

        all_outputs = []
        for idx, (seed, result) in enumerate(results):
            if len(results) > 1:
                img_name = f"{base_name}_s{seed}"
            else:
                img_name = base_name
            output_image = os.path.join(cfg.OUTPUT_DIR, f"{img_name}.png")
            result.image.save(output_image)
            print(f"Saved: {output_image}")
            all_outputs.append({
                "path": output_image,
                "seed": seed,
                "size_bytes": os.path.getsize(output_image),
                "width": result.image.width,
                "height": result.image.height,
            })

        end_time = datetime.now(timezone.utc).isoformat()
        last_timings = results[-1][1].timings if results else {}
        manifest = Manifest.from_success(
            run_file, start_time, end_time, last_timings, all_outputs, models,
        )
        manifest.to_json(manifest_file)
        print(f"Run config: {run_file}")
        print(f"Manifest: {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(
            run_file, start_time, end_time, timings_so_far, exc, models,
        )
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"Manifest (error): {manifest_file}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
