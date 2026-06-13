"""Shared helpers for command modules — avoids circular imports with run.py."""

from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Generator, NamedTuple

from app import config as cfg

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_UPSCALE_MODEL = os.path.join(
    cfg.REPO_DIR, "comfyui_data", "models", "upscale_models",
    "4xNomosWebPhoto_RealPLKSR.pth"
)

RELAY_FINAL_MODE = "relay-final"


# ---------------------------------------------------------------------------
# Output naming (defined early — used by make_output_paths below)
# ---------------------------------------------------------------------------

def generate_base_name() -> str:
    return f"output_{time.strftime('%Y%m%d_%H%M%S')}"


# ---------------------------------------------------------------------------
# Output path helpers
# ---------------------------------------------------------------------------

class OutputPaths(NamedTuple):
    base_name: str       # "output_20260613_143022"
    run_file: str        # ".../output_XXXX.run.json"
    manifest_file: str   # ".../output_XXXX.manifest.json"
    output_file: str     # ".../output_XXXX<suffix><ext>"


def make_output_paths(suffix: str = "", ext: str = ".png") -> OutputPaths:
    """Build a consistent set of output paths from a single timestamp base name."""
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()
    d = cfg.OUTPUT_DIR
    return OutputPaths(
        base_name=base,
        run_file=os.path.join(d, f"{base}.run.json"),
        manifest_file=os.path.join(d, f"{base}.manifest.json"),
        output_file=os.path.join(d, f"{base}{suffix}{ext}"),
    )


# ---------------------------------------------------------------------------
# Draft mode + batch seed helpers
# ---------------------------------------------------------------------------

def apply_draft_overrides(args: argparse.Namespace) -> None:
    """Apply draft mode presets (4 steps, 512×512) when --draft is set."""
    if not getattr(args, "draft", False):
        return
    args.steps = 4
    if getattr(args, "width", None) is None:
        args.width = 512
    if getattr(args, "height", None) is None:
        args.height = 512
    print("  [Draft] Quick preview: 4 steps, 512x512")


def seed_sequence(args_or_config: argparse.Namespace | "RunConfig") -> list[int]:
    """Return a list of seeds for a batch run.

    Works with both argparse Namespace and RunConfig objects (same attribute names).
    """
    count = max(1, getattr(args_or_config, "count", 1) or 1)
    seed = getattr(args_or_config, "seed", None) or 42
    seed_start = getattr(args_or_config, "seed_start", None)
    if seed_start is not None:
        return [seed_start + i for i in range(count)]
    return [seed] * count


# ---------------------------------------------------------------------------
# Run session context manager
# ---------------------------------------------------------------------------

@contextmanager
def run_session(paths: OutputPaths, run_config: "RunConfig | None" = None, json_summary: bool = False) -> "Generator[dict, None, None]":
    """Write run.json, record timing, write manifest on success/error.

    Yields a mutable dict (ctx) the caller fills with generation results:
      ctx["timings"]  — dict of phase timings from GenerationResult
      ctx["outputs"]  — list of {path, seed, size_bytes, width, height, ...}
      ctx["models"]   — model fingerprint dict from collect_model_fingerprint*()

    If run_config is None, the caller is responsible for writing run.json to
    paths.run_file before entering the context manager.

    On exception: writes an error manifest and sys.exit(1).
    On success:   writes a success manifest and prints the summary lines.
    """
    import json as _json
    from app.manifest import Manifest

    if run_config is not None:
        run_config.to_json(paths.run_file)
    start = datetime.now(timezone.utc).isoformat()
    ctx: dict = {"timings": {}, "outputs": [], "models": {}}
    try:
        yield ctx
    except Exception as exc:
        end = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(
            paths.run_file, start, end,
            ctx.get("timings", {}), exc, ctx.get("models", {}),
        )
        manifest.to_json(paths.manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"Manifest (error): {paths.manifest_file}", file=sys.stderr)
        traceback.print_exc()
        if json_summary:
            summary = _json.dumps({
                "status": "error",
                "run_json": paths.run_file,
                "manifest_json": paths.manifest_file,
                "outputs": [o["path"] for o in ctx.get("outputs", [])],
                "error": f"{type(exc).__name__}: {exc}",
            })
            print(f"JSON_SUMMARY:{summary}")
        sys.exit(1)
    else:
        end = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_success(
            paths.run_file, start, end,
            ctx["timings"], ctx["outputs"], ctx["models"],
        )
        manifest.to_json(paths.manifest_file)
        print(f"Run config: {paths.run_file}")
        print(f"Manifest:   {paths.manifest_file}")
        if json_summary:
            summary = _json.dumps({
                "status": "success",
                "run_json": paths.run_file,
                "manifest_json": paths.manifest_file,
                "outputs": [o["path"] for o in ctx["outputs"]],
            })
            print(f"JSON_SUMMARY:{summary}")


# ---------------------------------------------------------------------------
# Argparse helpers
# ---------------------------------------------------------------------------

def _arg_registered(parser: argparse.ArgumentParser, dest: str) -> bool:
    """Check if an argument with the given dest is already registered on the parser."""
    return any(getattr(a, 'dest', None) == dest for a in parser._actions)


def _option_registered(parser: argparse.ArgumentParser, option: str) -> bool:
    """Check if an option string (e.g. '--input') is already registered."""
    return any(option in getattr(a, 'option_strings', []) for a in parser._actions)


def normalize_self_test(args: "argparse.Namespace") -> None:
    """Normalize the nargs='*' --self-test value back to legacy scalar form.

    Must be called once at the top of the image command entry point, BEFORE any
    sub-action reads args.self_test. Preserves all existing semantics:
      None              → None            (not given)
      []  (bare)        → True            (command default, == old const=True)
      ["X"]             → "X"             (single named test, == old scalar)
      ["X", "Y", ...]   → kept as list    (≥2 names → unified multi-report)

    Only the multi-name list (≥2) is a new case; it is consumed by the review
    dispatcher (run_review_selftest). All other commands see their legacy form.
    """
    st = getattr(args, "self_test", None)
    if isinstance(st, list):
        if len(st) == 0:
            args.self_test = True
        elif len(st) == 1:
            args.self_test = st[0]
        # len >= 2: leave the list intact for unified review


def add_common_generation_args(parser: argparse.ArgumentParser) -> None:
    """Register args shared by generate, refine, and video subcommands.

    Uses guards to avoid conflicts when sub-command modules register
    overlapping args (--steps, --seed, --prompt, etc.) on the same parser.
    """
    if not _arg_registered(parser, "prompt"):
        prompt_grp = parser.add_mutually_exclusive_group()
        prompt_grp.add_argument("--prompt", type=str, help="Text prompt")
        prompt_grp.add_argument("--prompt-file", type=str,
                                help="Path to a text file containing the prompt")

    if not _arg_registered(parser, "steps"):
        parser.add_argument("--steps", type=int, default=None,
                            help="Denoising steps (default: 9 for zimage, 4 for flux2-klein)")
    if not _arg_registered(parser, "seed"):
        parser.add_argument("--seed", type=int, default=42,
                            help="Random seed (default: 42)")
    if not _arg_registered(parser, "self_test"):
        # nargs="*" accepts 0..N names. normalize_self_test() (called at the
        # image entry point) restores the legacy scalar/bare semantics:
        #   absent  → None      bare --self-test → True   (command default)
        #   one name → "NAME"   two+ names → ["A","B"] (unified multi report)
        parser.add_argument("--self-test", nargs="*", default=None,
                            dest="self_test", metavar="TEST_ID",
                            help="Run named self-test (e.g. --self-test ultraflux), "
                                 "bare --self-test for the command default, "
                                 "or multiple names for a unified multi-report "
                                 "(e.g. --self-test redzit15 redzit15-lora)")
    if not _arg_registered(parser, "lora_path"):
        parser.add_argument("--lora-path", type=str, default=None,
                            help="LoRA weights: full path, dir, or short name "
                                 "(e.g. 'klein-slider-anatomy') — auto-resolved from models/lora/")
    if not _arg_registered(parser, "lora_scale"):
        # CAUTION: Some subcommands (e.g. anime2real) register their own
        # dedicated --lora-scale variant with default=None BEFORE this
        # function runs.  When that happens, _arg_registered returns True
        # and this block is skipped — the shared --lora-scale default=1.0
        # is NOT applied.  Other commands must use
        #   getattr(args, "lora_scale", None) or 1.0
        # to safely handle the None case.
        parser.add_argument("--lora-scale", type=float, default=1.0,
                            help="LoRA conditioning strength 0–2 (default: 1.0; "
                                 "try 0.7–0.9 to soften style influence)")
    if not _arg_registered(parser, "vae_path"):
        parser.add_argument("--vae-path", type=str, default=None,
                            help="VAE weights: full dir path or short name "
                                 "(e.g. 'ultraflux') — auto-resolved from models/vae/")

    # img2img / I2I (unified with t2i via --input)
    # NOTE: --input may already be registered by add_angle_args() with dest="input"
    if not _option_registered(parser, "--input"):
        parser.add_argument("--input", type=str, default=None, dest="input_image",
                            help="Input image for I2I / img2img mode")
    if not _arg_registered(parser, "denoise_strength"):
        parser.add_argument("--denoise-strength", type=float, default=1.0,
                            help="Denoise strength for I2I (0.0 = keep input, 1.0 = full redraw)")
    if not _arg_registered(parser, "latent_upscale"):
        parser.add_argument("--latent-upscale", type=float, default=1.0,
                            help="Latent space upscale factor before denoising (default: 1.0)")

    # Draft mode (quick preview)
    if not _arg_registered(parser, "draft"):
        parser.add_argument("--draft", action="store_true", default=False,
                            help="Draft mode: fewer steps (4), smaller resolution (512x512)")

    # Post-process upscale
    if not _arg_registered(parser, "upscale"):
        parser.add_argument("--upscale", action="store_true", default=False,
                            help=f"ESRGAN 4× upscale after generation (default model: 4xNomosWebPhoto_RealPLKSR.pth)")
    if not _arg_registered(parser, "upscale_model"):
        parser.add_argument("--upscale-model", type=str, default=None,
                            help="Path to ESRGAN .pth model (overrides default)")
    if not _arg_registered(parser, "upscale_method"):
        parser.add_argument("--upscale-method", choices=["esrgan", "seedvr2"], default="esrgan",
                            help="Upscale method when --upscale is set (default: esrgan)")

    # Batch
    if not _arg_registered(parser, "count"):
        parser.add_argument("--count", type=int, default=1,
                            help="Number of outputs to generate (default: 1). "
                                 "Use with --seed-start for distinct seeds per output.")
    if not _arg_registered(parser, "seed_start"):
        parser.add_argument("--seed-start", type=int, default=None,
                            help="First seed for a batch run; overrides --seed. "
                             "Output i uses seed seed_start+i.")

    # Machine-readable output for automation / CI
    if not _arg_registered(parser, "json_summary"):
        parser.add_argument("--json-summary", action="store_true", default=False,
                            dest="json_summary",
                            help="Print a JSON summary line to stdout after generation "
                                 "(for workflow integration)")


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


def list_available_loras(pipeline_filter: str | None = None) -> None:
    """List available LoRAs from the model registry, optionally filtered by pipeline.

    Args:
        pipeline_filter: If set, only show LoRAs with this pipeline in their manifest.
                         E.g. "zimage-turbo", "flux2-klein".
    """
    from app.model_registry import ModelRegistry

    registry = ModelRegistry(cfg.MODELS_DIR)
    lorals = registry.list("lora")

    if not lorals:
        print("No LoRAs found in models/lora/")
        return

    if pipeline_filter:
        lorals = [l for l in lorals if pipeline_filter in l.get("pipeline", [])]
        if not lorals:
            print(f"No LoRAs found for pipeline '{pipeline_filter}'.")
            print(f"Available pipelines: {', '.join(sorted(set(p for l in registry.list('lora') for p in l.get('pipeline', []))))}")
            return

    # Format table
    print(f"\n{'Name':<35} {'Arch':<20} {'Pipeline':<20} {'Size':>10}  Description")
    print(f"{'─'*35} {'─'*20} {'─'*20} {'─'*10}  {'─'*40}")
    for l in lorals:
        name = l.get("name", "?")
        arch = l.get("arch", "?")
        pipelines = ", ".join(l.get("pipeline", []))
        size_mb = l.get("size_bytes", 0) / (1024 * 1024)
        desc = l.get("description", "")
        # Truncate long descriptions
        if len(desc) > 60:
            desc = desc[:57] + "..."
        print(f"{name:<35} {arch:<20} {pipelines:<20} {size_mb:>8.1f}MB  {desc}")

    print(f"\n{len(lorals)} LoRA(s) found" + (f" (pipeline={pipeline_filter})" if pipeline_filter else ""))


def resolve_vae_path(raw: str | None) -> str | None:
    """Resolve a --vae-path value to an absolute directory path.

    Accepts:
      1. Full path to a directory  → used as-is
      2. Short name (e.g. "ultraflux")
         → search models/vae/ for a matching subdirectory
      3. Partial name prefix match

    Returns None if raw is None. Exits with error if unresolvable.
    """
    if raw is None:
        return None

    if os.path.isdir(raw):
        return os.path.abspath(raw)

    vae_base = os.path.join(cfg.MODELS_DIR, "vae")

    candidate = os.path.join(vae_base, raw)
    if os.path.isdir(candidate):
        return os.path.abspath(candidate)

    if os.path.isdir(vae_base):
        matches = [
            d for d in os.listdir(vae_base)
            if os.path.isdir(os.path.join(vae_base, d)) and d.startswith(raw)
        ]
        if len(matches) == 1:
            print(f"  VAE resolved: {raw} → {matches[0]}")
            return os.path.abspath(os.path.join(vae_base, matches[0]))
        elif len(matches) > 1:
            print(f"ERROR: ambiguous VAE name '{raw}' matches: {', '.join(matches)}",
                  file=sys.stderr)
            print(f"  Use a more specific name.", file=sys.stderr)
            sys.exit(1)

    print(f"ERROR: cannot resolve VAE '{raw}'", file=sys.stderr)
    print(f"  Searched: directory path, models/vae/{raw}, partial match in models/vae/",
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


def resolve_prompt(args: argparse.Namespace) -> str:
    """Read prompt from --prompt or --prompt-file. Raises ValueError if neither set."""
    prompt = getattr(args, "prompt", None)
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file:
        with open(prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        raise ValueError("No prompt provided. Use --prompt, --prompt-file, or --test-prompt.")
    return prompt


def resolve_upscale_model(run_config: "RunConfig") -> str | None:
    if not run_config.upscale:
        return None
    return run_config.upscale_model or DEFAULT_UPSCALE_MODEL


# ---------------------------------------------------------------------------
# Generation execution (shared by generate, refine, replay)
# ---------------------------------------------------------------------------

def execute_generation(run_config: "RunConfig", pipeline_type: str = "zimage",
                       json_summary: bool = False) -> str:
    """Run pipeline.generate() for all batch items, save images, write manifest.

    Returns manifest_file path on success.  Exits with code 1 on error.

    When json_summary is True, prints a JSON_SUMMARY:{...} line to stdout
    for automation workflows (e.g. Claude Code workflow integration).
    The summary contains: status, run_json, manifest_json, outputs.
    """
    import json as _json

    from app.pipeline import ZImagePipeline
    from app.manifest import Manifest, collect_model_fingerprint, collect_model_fingerprint_flux2
    from PIL import Image

    # Single base name shared by .run.json, .manifest.json, and .png files.
    # Batch images get a _s{seed} suffix but keep the same timestamp base.
    paths = make_output_paths()
    run_file = paths.run_file
    manifest_file = paths.manifest_file
    base_name = paths.base_name

    run_config.to_json(run_file)

    start_time = datetime.now(timezone.utc).isoformat()

    # Resolve prompt
    prompt = run_config.prompt
    if run_config.prompt_file:
        with open(run_config.prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        raise ValueError("No prompt provided.")

    seeds = seed_sequence(run_config)
    count = len(seeds)
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
            transformer_name=getattr(run_config, "transformer", "klein-9b"),
        )
    else:
        transformer_name = getattr(run_config, "transformer", None)
        if transformer_name:
            t_dir = os.path.join(cfg.MODELS_DIR, "transformer", transformer_name)
            if not os.path.isdir(t_dir):
                print(f"ERROR: Transformer '{transformer_name}' not found at {t_dir}")
                sys.exit(1)
            print(f"[Pipeline] Using transformer: {transformer_name}")
            pipeline = ZImagePipeline(transformer_dir=t_dir)
        else:
            pipeline = ZImagePipeline()

    all_outputs = []
    output_paths = []
    last_timings = {}

    try:
        for i, seed in enumerate(seeds):
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
                    vae_dir=run_config.vae_path,
                )

            # ESRGAN post-processing (handled inside ZImagePipeline.generate()
            # for zimage; applied separately for flux2-klein)
            if pipeline_type == "flux2-klein" and run_config.upscale and upscale_model:
                result = _apply_upscale(
                    result, run_config.upscale_method, upscale_model,
                    upscale_resolution=getattr(run_config, "upscale_resolution", "2x"),
                    upscale_softness=getattr(run_config, "upscale_softness", 0.5),
                    seed=seed,
                )

            suffix = f"_s{seed}" if count > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}{suffix}.png")
            result.image.save(out_path)
            print(f"Saved: {out_path}")

            output_paths.append(out_path)
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
            models = collect_model_fingerprint_flux2(lora_path=run_config.lora_path,
                                                      upscale_model=upscale_model)
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

        if json_summary:
            summary = _json.dumps({
                "status": "success",
                "run_json": run_file,
                "manifest_json": manifest_file,
                "outputs": output_paths,
            })
            print(f"JSON_SUMMARY:{summary}")
        return manifest_file

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        models = {}
        manifest = Manifest.from_error(run_file, start_time, end_time,
                                       last_timings, exc, models)
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"Manifest (error): {manifest_file}", file=sys.stderr)
        traceback.print_exc()

        if json_summary:
            summary = _json.dumps({
                "status": "error",
                "run_json": run_file,
                "manifest_json": manifest_file,
                "outputs": output_paths,
                "error": f"{type(exc).__name__}: {exc}",
            })
            print(f"JSON_SUMMARY:{summary}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Upscale helper (shared between pipeline dispatch and standalone)
# ---------------------------------------------------------------------------

def _apply_upscale(result: "GenerationResult", upscale_method: str, upscale_model: str,
                   upscale_resolution: str = "2x", upscale_softness: float = 0.5,
                   seed: int = 42) -> "GenerationResult":
    """Apply post-generation upscaling to a GenerationResult."""
    from app.pipeline_types import GenerationResult as GR
    from app.pipeline import ZImagePipeline

    if upscale_method == "seedvr2":
        from app.seedvr2.pipeline import SeedVR2Upscaler
        res_str = str(upscale_resolution)
        if res_str.lower().endswith("x"):
            resolution = float(res_str.lower().rstrip("x"))
        else:
            resolution = int(res_str)
        upscaler = SeedVR2Upscaler(model_size="7b")
        try:
            upscaled = upscaler.upscale(
                image=result.image, resolution=resolution,
                softness=upscale_softness, seed=seed,
            )
        finally:
            try:
                upscaler.unload()
            except Exception:
                pass
        return GR(image=upscaled, timings=result.timings)
    else:
        upscaled = ZImagePipeline.upscale_esrgan(result.image, upscale_model)
        return GR(image=upscaled, timings=result.timings)


# ---------------------------------------------------------------------------
# A/B test: run both pipelines sequentially for comparison
# ---------------------------------------------------------------------------

def _stitch_horizontal(images: "list[Image.Image]", gap: int = 0, labels: list[str] | None = None, bg_color: tuple[int, int, int] = (30, 30, 30)) -> "Image.Image":
    """Stitch images horizontally with optional text labels."""
    from PIL import Image, ImageDraw, ImageFont
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


def execute_ab_test(run_config: "RunConfig", json_summary: bool = False) -> str:
    """Run both zimage and flux2-klein pipelines for A/B comparison.

    Returns manifest_file path on success.  Exits with code 1 on error.
    When json_summary is True, prints JSON_SUMMARY:{...} line to stdout.
    """
    import gc
    import json as _json
    import mlx.core as mx
    from app.pipeline import ZImagePipeline
    from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline
    from app.manifest import Manifest, collect_model_fingerprint, collect_model_fingerprint_flux2
    from app.pipeline_types import GenerationResult
    from PIL import Image

    paths = make_output_paths()
    run_file = paths.run_file
    manifest_file = paths.manifest_file
    base_name = paths.base_name

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

    seeds = seed_sequence(run_config)
    count = len(seeds)
    all_outputs = []
    all_timings = {}

    try:
        for i, seed in enumerate(seeds):
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
            pipeline_f = Flux2KleinT2IPipeline(
                transformer_name=getattr(run_config, "transformer", "klein-9b"),
            )
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
                result_f = _apply_upscale(
                    result_f, run_config.upscale_method, upscale_model,
                    upscale_resolution=getattr(run_config, "upscale_resolution", "2x"),
                    upscale_softness=getattr(run_config, "upscale_softness", 0.5),
                    seed=seed,
                )
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

        output_paths = [o["path"] for o in all_outputs]
        if json_summary:
            summary = _json.dumps({
                "status": "success",
                "run_json": run_file,
                "manifest_json": manifest_file,
                "outputs": output_paths,
            })
            print(f"JSON_SUMMARY:{summary}")
        return manifest_file

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time,
                                       all_timings, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()

        output_paths = [o["path"] for o in all_outputs]
        if json_summary:
            summary = _json.dumps({
                "status": "error",
                "run_json": run_file,
                "manifest_json": manifest_file,
                "outputs": output_paths,
                "error": f"{type(exc).__name__}: {exc}",
            })
            print(f"JSON_SUMMARY:{summary}")
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

    try:
        image = Image.open(input_path).convert("RGB")
    except Exception as exc:
        print(f"ERROR: cannot open image (corrupt or unsupported format): {input_path}\n  {exc}", file=sys.stderr)
        sys.exit(1)
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


# ---------------------------------------------------------------------------
# Subprocess helper — auto-propagates --force to prevent GPU lock deadlock
# ---------------------------------------------------------------------------

def build_run_py_cmd(*args: str, force: bool | None = None) -> list[str]:
    """Build a subprocess command invoking run.py.

    Automatically appends --force when the current process was started with
    --force (prevents GPU lock deadlock in child processes). All subprocess
    calls to run.py should use this helper instead of building cmd lists by hand.

    Args:
        *args: Positional arguments for run.py (e.g. "video", "generate", "--prompt", "test").
        force: Override force behavior. None = auto-detect from sys.argv,
               True = always append --force, False = never append.

    Returns:
        Command list suitable for subprocess.run().
    """
    run_py = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "run.py")
    )
    cmd = [sys.executable, run_py] + list(args)
    if force is None:
        force = "--force" in sys.argv or "--skip-gpu-lock" in sys.argv
    if force:
        cmd.append("--force")
    return cmd
