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

    parser.add_argument("--steps", type=int, default=None,
                        help="Denoising steps (default: 9 for zimage, 4 for flux2-klein)")
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
    parser.add_argument("--upscale-method", choices=["esrgan", "seedvr2"], default="esrgan",
                        help="Upscale method when --upscale is set (default: esrgan)")

    # Batch
    parser.add_argument("--count", type=int, default=1,
                        help="Number of images to generate (default: 1)")
    parser.add_argument("--seed-start", type=int, default=None,
                        help="Starting seed for batch; seeds = seed_start, seed_start+1, ...")


def resolve_lora_path(raw: str | None) -> str | None:
    """Resolve a --lora-path value to an absolute .safetensors file path.

    Accepts:
      1. Full path to a .safetensors file  → used as-is
      2. Path to a directory               → find the .safetensors inside
      3. Short name (e.g. "klein-slider-bodyweight-50")
         → search models/lora/ for a matching subdirectory
      4. Partial name (e.g. "klein-slider")
         → matches if exactly one lora dir starts with it

    Returns None if raw is None. Exits with error if unresolvable.
    """
    if raw is None:
        return None

    # Already a full path to a file
    if os.path.isfile(raw):
        return os.path.abspath(raw)

    lora_base = os.path.join(cfg.MODELS_DIR, "lora")

    # Check if it's a path to a directory (absolute or relative)
    if os.path.isdir(raw):
        return _find_safetensors_in_dir(raw)

    # Check models/lora/<raw> as a directory name
    candidate = os.path.join(lora_base, raw)
    if os.path.isdir(candidate):
        return _find_safetensors_in_dir(candidate)

    # Partial name match: find dirs that start with the given prefix
    if os.path.isdir(lora_base):
        matches = [
            d for d in os.listdir(lora_base)
            if os.path.isdir(os.path.join(lora_base, d)) and d.startswith(raw)
        ]
        if len(matches) == 1:
            print(f"  LoRA resolved: {raw} → {matches[0]}")
            return _find_safetensors_in_dir(os.path.join(lora_base, matches[0]))
        elif len(matches) > 1:
            print(f"ERROR: ambiguous LoRA name '{raw}' matches: {', '.join(matches)}",
                  file=sys.stderr)
            print(f"  Use a more specific name.", file=sys.stderr)
            sys.exit(1)

    print(f"ERROR: cannot resolve LoRA '{raw}'", file=sys.stderr)
    print(f"  Searched: file path, models/lora/{raw}, partial match in models/lora/",
          file=sys.stderr)
    sys.exit(1)


def _find_safetensors_in_dir(directory: str) -> str:
    """Find the single .safetensors file in a directory. Exit if 0 or >1."""
    files = [f for f in os.listdir(directory) if f.endswith(".safetensors")]
    if len(files) == 1:
        return os.path.abspath(os.path.join(directory, files[0]))
    if not files:
        print(f"ERROR: no .safetensors file found in {directory}", file=sys.stderr)
        sys.exit(1)
    print(f"ERROR: multiple .safetensors files in {directory}: {', '.join(files)}",
          file=sys.stderr)
    print(f"  Use full path to specify which one.", file=sys.stderr)
    sys.exit(1)


def resolve_prompt(args) -> str:
    """Read prompt from --prompt or --prompt-file. Raises ValueError if neither set."""
    prompt = getattr(args, "prompt", None)
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file:
        with open(prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        raise ValueError("No prompt provided. Use --prompt, --prompt-file, or --test-prompt.")
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

def execute_generation(run_config, pipeline_type: str = "zimage") -> None:
    """Run pipeline.generate() for all batch items, save images, write manifest."""
    from app.pipeline import ZImagePipeline
    from app.manifest import Manifest, collect_model_fingerprint, collect_model_fingerprint_flux2
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

    # Instantiate the selected pipeline
    if pipeline_type == "flux2-klein":
        from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline
        lora_paths = [run_config.lora_path] if run_config.lora_path else None
        lora_scales = [run_config.lora_scale] if lora_paths else None
        pipeline = Flux2KleinT2IPipeline(
            lora_paths=lora_paths,
            lora_scales=lora_scales,
        )
    else:
        pipeline = ZImagePipeline()

    all_outputs = []
    last_timings = {}

    try:
        for i in range(count):
            seed = (run_config.seed_start + i) if run_config.seed_start is not None else run_config.seed

            if count > 1:
                print(f"\n=== Batch {i + 1}/{count} (seed={seed}) ===")

            if pipeline_type == "flux2-klein":
                result = pipeline.generate(
                    prompt=prompt,
                    width=run_config.width,
                    height=run_config.height,
                    steps=run_config.steps,
                    seed=seed,
                    input_image=input_image,
                    denoise_strength=run_config.denoise_strength,
                )
            else:
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
                    upscale_method=run_config.upscale_method,
                )

            # ESRGAN post-processing (handled inside ZImagePipeline.generate()
            # for zimage; applied separately for flux2-klein)
            if pipeline_type == "flux2-klein" and run_config.upscale and upscale_model:
                result = _apply_upscale(result, run_config.upscale_method, upscale_model)

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
        if pipeline_type == "flux2-klein":
            models = collect_model_fingerprint_flux2(upscale_model=upscale_model)
        else:
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
    return manifest_file


# ---------------------------------------------------------------------------
# Upscale helper (shared between pipeline dispatch and standalone)
# ---------------------------------------------------------------------------

def _apply_upscale(result, upscale_method: str, upscale_model: str):
    """Apply post-generation upscaling to a GenerationResult."""
    from app.pipeline_types import GenerationResult as GR
    from app.pipeline import ZImagePipeline

    if upscale_method == "seedvr2":
        from app.seedvr2_pipeline import SeedVR2Pipeline
        pipeline_s = SeedVR2Pipeline()
        upscaled = pipeline_s.upscale(result.image)
        return GR(image=upscaled, timings=result.timings)
    else:
        upscaled = ZImagePipeline.upscale_esrgan(result.image, upscale_model)
        return GR(image=upscaled, timings=result.timings)


# ---------------------------------------------------------------------------
# A/B test: run both pipelines sequentially for comparison
# ---------------------------------------------------------------------------

def _stitch_horizontal(images, gap: int = 0, labels=None, bg_color=(30, 30, 30)):
    """Stitch images horizontally with optional text labels."""
    from PIL import ImageDraw, ImageFont
    max_h = max(img.height for img in images)
    label_h = 36 if labels else 0
    total_w = sum(img.width for img in images) + gap * (len(images) - 1)
    strip = Image.new("RGB", (total_w, max_h + label_h), color=bg_color)
    x = 0
    for idx, img in enumerate(images):
        strip.paste(img, (x, label_h))
        if labels:
            draw = ImageDraw.Draw(strip)
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
            except (OSError, IOError):
                font = ImageFont.load_default()
            draw.text((x + 8, 6), labels[idx], fill=(220, 220, 220), font=font)
        x += img.width + gap
    return strip


def execute_ab_test(run_config) -> None:
    """Run both zimage and flux2-klein pipelines for A/B comparison."""
    import gc
    import mlx.core as mx
    from app.pipeline import ZImagePipeline
    from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline
    from app.manifest import Manifest, collect_model_fingerprint, collect_model_fingerprint_flux2
    from app.pipeline_types import GenerationResult
    from PIL import Image

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")

    run_config.to_json(run_file)
    start_time = datetime.now(timezone.utc).isoformat()

    prompt = run_config.prompt
    if run_config.prompt_file:
        with open(run_config.prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        raise ValueError("No prompt provided.")

    upscale_model = resolve_upscale_model(run_config)
    input_image = None
    if run_config.input_image:
        input_image = Image.open(run_config.input_image).convert("RGB")

    count = max(1, run_config.count)
    all_outputs = []
    all_timings = {}

    try:
        for i in range(count):
            seed = (run_config.seed_start + i) if run_config.seed_start is not None else run_config.seed
            suffix = f"_s{seed}" if count > 1 else ""

            # --- Pass 1: ZImage ---
            print(f"\n{'='*60}")
            print(f"A/B Test — ZImage (batch {i+1}/{count}, seed={seed})")
            print(f"{'='*60}")
            pipeline_z = ZImagePipeline()
            result_z = pipeline_z.generate(
                prompt=prompt,
                width=run_config.width,
                height=run_config.height,
                steps=run_config.steps or 9,
                seed=seed,
                lora_path=run_config.lora_path,
                lora_scale=run_config.lora_scale,
                input_image=input_image,
                latent_upscale=run_config.latent_upscale,
                denoise_strength=run_config.denoise_strength,
                upscale=False,
                upscale_model=None,
            )
            zimg_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_zimage{suffix}.png")
            result_z.image.save(zimg_path)
            print(f"Saved ZImage: {zimg_path}")
            all_outputs.append({
                "path": zimg_path, "seed": seed, "pipeline": "zimage",
                "size_bytes": os.path.getsize(zimg_path),
                "width": result_z.image.width, "height": result_z.image.height,
            })
            all_timings["zimage"] = result_z.timings

            # Unload ZImage to free ~8 GB
            del pipeline_z, result_z
            mx.clear_cache()
            gc.collect()

            # --- Pass 2: Flux2 Klein ---
            print(f"\n{'='*60}")
            print(f"A/B Test — Flux2 Klein (batch {i+1}/{count}, seed={seed})")
            print(f"{'='*60}")
            pipeline_f = Flux2KleinT2IPipeline()
            result_f = pipeline_f.generate(
                prompt=prompt,
                width=run_config.width,
                height=run_config.height,
                steps=run_config.steps or 4,
                seed=seed,
                input_image=input_image,
                denoise_strength=run_config.denoise_strength,
            )
            if run_config.upscale and upscale_model:
                result_f = _apply_upscale(result_f, run_config.upscale_method, upscale_model)
            fimg_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_klein{suffix}.png")
            result_f.image.save(fimg_path)
            print(f"Saved Klein: {fimg_path}")
            all_outputs.append({
                "path": fimg_path, "seed": seed, "pipeline": "flux2-klein",
                "size_bytes": os.path.getsize(fimg_path),
                "width": result_f.image.width, "height": result_f.image.height,
            })
            all_timings["flux2-klein"] = result_f.timings

            # --- Side-by-side comparison ---
            zimg = Image.open(zimg_path)
            fimg = Image.open(fimg_path)
            compare = _stitch_horizontal(
                [zimg, fimg], gap=4, labels=["ZImage Turbo", "Flux2 Klein 9B"]
            )
            compare_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_compare{suffix}.png")
            compare.save(compare_path)
            print(f"Comparison: {compare_path}")
            all_outputs.append({
                "path": compare_path, "pipeline": "compare",
                "size_bytes": os.path.getsize(compare_path),
                "width": compare.width, "height": compare.height,
            })

            del pipeline_f, result_f, zimg, fimg, compare
            mx.clear_cache()
            gc.collect()

        end_time = datetime.now(timezone.utc).isoformat()
        models_z = collect_model_fingerprint(lora_path=run_config.lora_path)
        models_f = collect_model_fingerprint_flux2(upscale_model=upscale_model)
        models = {"zimage": models_z, "flux2-klein": models_f}
        manifest = Manifest.from_success(run_file, start_time, end_time,
                                         all_timings, all_outputs, models)
        manifest.to_json(manifest_file)
        print(f"\nRun config: {run_file}")
        print(f"Manifest:   {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time,
                                       all_timings, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
    return manifest_file


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
