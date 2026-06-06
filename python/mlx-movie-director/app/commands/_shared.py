"""Shared helpers for command modules — avoids circular imports with run.py."""

import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_UPSCALE_MODEL = os.path.join(
    cfg.REPO_DIR, "comfyui_data", "models", "upscale_models",
    "4xNomosWebPhoto_RealPLKSR.pth"
)


# ---------------------------------------------------------------------------
# Argparse helpers
# ---------------------------------------------------------------------------

def add_common_generation_args(parser):
    """Register args shared by generate, refine, and video subcommands."""
    prompt_grp = parser.add_mutually_exclusive_group()
    prompt_grp.add_argument("--prompt", type=str, help="Text prompt")
    prompt_grp.add_argument("--prompt-file", type=str,
                            help="Path to a text file containing the prompt")

    parser.add_argument("--steps", type=int, default=9,
                        help="Denoising steps (default: 9)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--lora-path", type=str, default=None,
                        help="Path to LoRA .safetensors file")
    parser.add_argument("--lora-scale", type=float, default=1.0,
                        help="LoRA scale factor (default: 1.0)")

    # Post-process upscale
    parser.add_argument("--upscale", action="store_true", default=False,
                        help=f"ESRGAN 4× upscale after generation (default model: 4xNomosWebPhoto_RealPLKSR.pth)")
    parser.add_argument("--upscale-model", type=str, default=None,
                        help="Path to ESRGAN .pth model (overrides default)")

    # Batch
    parser.add_argument("--count", type=int, default=1,
                        help="Number of images to generate (default: 1)")
    parser.add_argument("--seed-start", type=int, default=None,
                        help="Starting seed for batch; seeds = seed_start, seed_start+1, ...")


def resolve_prompt(args) -> str:
    """Read prompt from --prompt or --prompt-file. Raises ValueError if neither set."""
    prompt = getattr(args, "prompt", None)
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file:
        with open(prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        raise ValueError("No prompt provided. Use --prompt or --prompt-file.")
    return prompt


def resolve_upscale_model(run_config) -> str | None:
    if not run_config.upscale:
        return None
    return run_config.upscale_model or DEFAULT_UPSCALE_MODEL


# ---------------------------------------------------------------------------
# Output naming
# ---------------------------------------------------------------------------

def generate_base_name() -> str:
    return f"output_{time.strftime('%Y%m%d_%H%M%S')}"


# ---------------------------------------------------------------------------
# Generation execution (shared by generate, refine, replay)
# ---------------------------------------------------------------------------

def execute_generation(run_config) -> None:
    """Run pipeline.generate() for all batch items, save images, write manifest."""
    from app.pipeline import ZImagePipeline
    from app.manifest import Manifest, collect_model_fingerprint
    from PIL import Image

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)

    # Single base name shared by .run.json, .manifest.json, and .png files.
    # Batch images get a _s{seed} suffix but keep the same timestamp base.
    base_name = generate_base_name()
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")

    run_config.to_json(run_file)

    start_time = datetime.now(timezone.utc).isoformat()

    # Resolve prompt
    prompt = run_config.prompt
    if run_config.prompt_file:
        with open(run_config.prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        raise ValueError("No prompt provided.")

    count = max(1, run_config.count)
    upscale_model = resolve_upscale_model(run_config)

    # Load input image for img2img (once, reused across batch)
    input_image = None
    if run_config.input_image:
        input_image = Image.open(run_config.input_image).convert("RGB")

    pipeline = ZImagePipeline()
    all_outputs = []
    last_timings = {}

    try:
        for i in range(count):
            seed = (run_config.seed_start + i) if run_config.seed_start is not None else run_config.seed

            if count > 1:
                print(f"\n=== Batch {i + 1}/{count} (seed={seed}) ===")

            result = pipeline.generate(
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

            suffix = f"_s{seed}" if count > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}{suffix}.png")
            result.image.save(out_path)
            print(f"Saved: {out_path}")

            all_outputs.append({
                "path": out_path,
                "seed": seed,
                "size_bytes": os.path.getsize(out_path),
                "width": result.image.width,
                "height": result.image.height,
            })
            last_timings = result.timings

        end_time = datetime.now(timezone.utc).isoformat()
        models = collect_model_fingerprint(
            lora_path=run_config.lora_path,
            upscale_model=upscale_model,
        )
        manifest = Manifest.from_success(run_file, start_time, end_time,
                                         last_timings, all_outputs, models)
        manifest.to_json(manifest_file)
        print(f"Run config: {run_file}")
        print(f"Manifest:   {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        models = {}
        manifest = Manifest.from_error(run_file, start_time, end_time,
                                       last_timings, exc, models)
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"Manifest (error): {manifest_file}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


# ---------------------------------------------------------------------------
# Standalone ESRGAN execution (upscale command only)
# ---------------------------------------------------------------------------

def execute_upscale(input_path: str, model_path: str, output_path: str | None) -> None:
    """Upscale a single image with ESRGAN (no diffusion model loaded)."""
    from app.pipeline import ZImagePipeline
    from PIL import Image

    if not os.path.exists(input_path):
        print(f"ERROR: input image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(model_path):
        print(f"ERROR: ESRGAN model not found: {model_path}", file=sys.stderr)
        print(f"  Expected at: {model_path}", file=sys.stderr)
        sys.exit(1)

    image = Image.open(input_path).convert("RGB")
    w0, h0 = image.size

    print(f"Upscaling {input_path} ({w0}×{h0}) with {os.path.basename(model_path)}...")
    t0 = time.time()
    upscaled = ZImagePipeline.upscale_esrgan(image, model_path)
    elapsed = time.time() - t0
    w1, h1 = upscaled.size
    print(f"Done ({elapsed:.2f}s) → {w1}×{h1}")

    if output_path is None:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_4x{ext or '.png'}"

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    upscaled.save(output_path)
    print(f"Saved: {output_path}")
