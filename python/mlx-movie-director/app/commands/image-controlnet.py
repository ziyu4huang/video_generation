"""image-controlnet — Z-Image ControlNet generation (native MLX, no ComfyUI required).

Source: https://civitai.com/models/2192289/zimageturbo-controlnet-6g-vram-can-run-it?modelVersionId=2509261

Preprocessors supported:
  canny   — cv2.Canny edge detection (built-in, no extra model)
  raw     — pass control image directly without preprocessing (--skip-preprocess)

Preprocessors requiring external models (deferred):
  pose, depth, hed, scribble — use --skip-preprocess and run preprocessing externally

Public API:
  add_controlnet_args(parser)  — register ControlNet-specific CLI arguments
  run_controlnet(args)         — execute native MLX ControlNet generation
"""

import argparse
import gc
import json
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

import mlx.core as mx
import mlx.nn as nn
import numpy as np

from app import config as cfg
from app.controlnet import load_controlnet, build_control_input_33ch, _FLUX_SHIFT_FACTOR, _FLUX_SCALE_FACTOR

_DEFAULT_REF_IMAGE = os.path.join(
    cfg.OUTPUT_DIR, "Z-image+Controlnet+V2.1-ref-image.png"
)
_DEFAULT_PROMPT = "背面拍摄，高清摄影。一个coser少女，她cos的是雷姆。"

# A/B test variations: (label, strength, blur_sigma_or_None, remove_outlines, skip_preprocess)
_AB_VARIATIONS = [
    ("A-str06-canny",  0.6, None, False, False),  # Canny + strength 0.6
    ("B-str06-raw",    0.6, None, False, True),   # Raw + strength 0.6
    ("C-str06-blur5",  0.6, 5.0,  False, True),   # Blur(5) + strength 0.6
    ("D-str08-canny",  0.8, None, False, False),  # Canny + strength 0.8
    ("E-str08-raw",    0.8, None, False, True),   # Raw + strength 0.8
    ("F-str08-blur5",  0.8, 5.0,  False, True),   # Blur(5) + strength 0.8
]


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

def add_controlnet_args(parser):
    """Register ControlNet-specific arguments (prompt/steps/seed come from common args)."""
    parser.add_argument(
        "--input-image", type=str, default=None, metavar="PATH",
        help=(
            "Reference image for ControlNet conditioning "
            "(default: output/Z-image+Controlnet+V2.1-ref-image.png)"
        ),
    )
    parser.add_argument(
        "--controlnet-type",
        choices=["canny"],
        default="canny",
        help="ControlNet preprocessor: canny (built-in, default: canny)",
    )
    parser.add_argument(
        "--controlnet-strength", type=float, default=1.0, dest="controlnet_strength",
        help="ControlNet conditioning strength (default: 1.0)",
    )
    parser.add_argument(
        "--skip-preprocess", action="store_true", default=False,
        help="Skip preprocessing — pass the reference image directly as control signal",
    )
    parser.add_argument(
        "--blur-ref", type=float, default=None, metavar="SIGMA",
        dest="blur_ref",
        help=(
            "Apply Gaussian blur (sigma) to the reference image before VAE encoding. "
            "Softens thick outlines (苗框線) into gradients that still convey pose "
            "but won't produce sharp line artifacts. Try values 5–20. "
            "Default (when flag omitted): no blur."
        ),
    )
    parser.add_argument(
        "--remove-outlines", action="store_true", default=False,
        dest="remove_outlines",
        help=(
            "Remove thick dark outlines (苗框線) from the reference image via "
            "inpainting before VAE encoding. Fills outlines with surrounding colors, "
            "keeping the image sharp while removing harsh black lines. "
            "Better clarity than --blur-ref."
        ),
    )
    parser.add_argument(
        "--scale", type=int, default=None,
        help="Scale longest side of generated image to this resolution "
             "(default: match reference image size)",
    )
    parser.add_argument(
        "--controlnet-ab-test", action="store_true", default=False,
        dest="controlnet_ab_test",
        help=(
            "Run A/B test comparing outline removal and blur approaches. "
            "Opens manifest review HTML after completion."
        ),
    )
    parser.add_argument(
        "--cnet-active-steps", type=int, default=None, metavar="N",
        help=(
            "Only apply ControlNet for the first N denoising steps "
            "(dual-sampler technique). Default: apply on all steps."
        ),
    )
    # --self-test is registered in _shared.py (shared by controlnet, faceswap, quality)
    # Flux2-Klein-specific options for ControlNet:
    # --pipeline, --variant, --flux2-model-path, --quantize are already
    # registered by add_t2i_args() in image-t2i.py (shared parser).
    # --ref-count is already registered by add_profile_args() in image-profile.py.
    # No additional args needed — controlnet reuses these shared flags.

    # --server argument kept for backward compat but ignored (no ComfyUI needed)
    parser.add_argument(
        "--server", type=str, default=None,
        help=argparse.SUPPRESS,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_controlnet(args):
    """Execute ControlNet generation (Z-Image native or Flux2 Klein reference conditioning).

    Called by image.py dispatcher.
    """
    # ── Self-test mode ─────────────────────────────────────────────────────
    if getattr(args, "self_test", False):
        _run_self_test(args)
        return

    from PIL import Image

    prompt = getattr(args, "prompt", None) or _DEFAULT_PROMPT
    ref_image_path = getattr(args, "input_image", None) or _DEFAULT_REF_IMAGE
    ctrl_type = getattr(args, "controlnet_type", "canny")
    strength = getattr(args, "controlnet_strength", 1.0)
    skip_preprocess = getattr(args, "skip_preprocess", False)
    blur_ref = getattr(args, "blur_ref", None)
    remove_outlines = getattr(args, "remove_outlines", False)
    scale = getattr(args, "scale", None)
    pipeline_type = getattr(args, "pipeline", "zimage")
    seed = getattr(args, "seed", 42)
    do_ab = getattr(args, "controlnet_ab_test", False)

    # Default steps differ by pipeline
    steps = getattr(args, "steps", None)
    if steps is None:
        steps = 4 if pipeline_type == "flux2-klein" else 9

    if not os.path.exists(ref_image_path):
        print(f"ERROR: Reference image not found: {ref_image_path}", file=sys.stderr)
        print("  Pass --input-image PATH to specify a reference image.", file=sys.stderr)
        sys.exit(1)

    # ── Determine output dimensions ──────────────────────────────────────────
    with Image.open(ref_image_path) as img:
        src_w, src_h = img.size
    # Dimensions must be divisible by 16: VAE divides by 8, then patchify divides by 2
    if scale is not None:
        if src_w >= src_h:
            out_w = (scale // 16) * 16
            out_h = max(16, (round(src_h * scale / src_w) // 16) * 16)
        else:
            out_h = (scale // 16) * 16
            out_w = max(16, (round(src_w * scale / src_h) // 16) * 16)
    else:
        out_w = (src_w // 16) * 16
        out_h = (src_h // 16) * 16

    # ── Create Flux2 pipeline once (reused across A/B variations) ─────────────
    flux2_pipeline = None
    resolved_lora_path = None
    if pipeline_type == "flux2-klein":
        flux2_pipeline = _create_flux2_pipeline(args)
        from app.commands._shared import resolve_lora_path
        resolved_lora_path = resolve_lora_path(getattr(args, "lora_path", None))

    if do_ab:
        _run_ab_test(
            prompt=prompt,
            ref_image_path=ref_image_path,
            ctrl_type=ctrl_type,
            skip_preprocess=skip_preprocess,
            out_w=out_w,
            out_h=out_h,
            steps=steps,
            seed=seed,
            pipeline_type=pipeline_type,
            flux2_pipeline=flux2_pipeline,
            lora_path=resolved_lora_path,
            args=args,
        )
        return

    # ── Single run ───────────────────────────────────────────────────────────
    # Build descriptive output name from key parameters
    out_label = "controlnet"
    out_label += f"_str{strength}"
    if skip_preprocess:
        out_label += "-raw"
    else:
        out_label += f"-{ctrl_type}"
    if blur_ref is not None:
        out_label += f"-blur{blur_ref:.0f}"
    if remove_outlines:
        out_label += "-rmout"
    out_label += f"-{steps}st"
    if cnet_active_steps := getattr(args, "cnet_active_steps", None):
        out_label += f"-active{cnet_active_steps}"
    out_label += f"-s{seed}"

    run_file, manifest_file, out_path = _make_output_paths(out_label)
    run_meta = _build_run_meta(
        prompt=prompt,
        ref_image_path=ref_image_path,
        ctrl_type=ctrl_type,
        strength=strength,
        skip_preprocess=skip_preprocess,
        blur_ref=blur_ref,
        remove_outlines=remove_outlines,
        steps=steps,
        seed=seed,
        out_w=out_w,
        out_h=out_h,
        scale=scale,
        pipeline_type=pipeline_type,
    )
    _write_json(run_file, run_meta)

    print(f"  Ref image : {ref_image_path} ({src_w}×{src_h})")
    print(f"  Output    : {out_w}×{out_h}")
    print(f"  Prompt    : {prompt}")
    print(f"  ControlNet: {ctrl_type} (strength={strength})")
    print(f"  Steps/seed: {steps} / {seed}")
    print(f"Run config : {run_file}")

    start_time = datetime.now(timezone.utc).isoformat()
    last_timings = {}

    try:
        if pipeline_type == "flux2-klein":
            pil_image = _execute_generation_flux2(
                prompt=prompt,
                ref_image_path=ref_image_path,
                ctrl_type=ctrl_type,
                strength=strength,
                skip_preprocess=skip_preprocess,
                blur_ref=blur_ref,
                remove_outlines=remove_outlines,
                out_w=out_w,
                out_h=out_h,
                steps=steps,
                seed=seed,
                pipeline=flux2_pipeline,
                args=args,
            )
        else:
            pil_image = _execute_generation(
                prompt=prompt,
                ref_image_path=ref_image_path,
                ctrl_type=ctrl_type,
                strength=strength,
                skip_preprocess=skip_preprocess,
                blur_ref=blur_ref,
                remove_outlines=remove_outlines,
                out_w=out_w,
                out_h=out_h,
                steps=steps,
                seed=seed,
                cnet_active_steps=getattr(args, "cnet_active_steps", None),
            )

        pil_image.save(out_path)
        print(f"Saved: {out_path}")

        end_time = datetime.now(timezone.utc).isoformat()
        output_files = [{
            "path": out_path,
            "seed": seed,
            "size_bytes": os.path.getsize(out_path),
            "width": pil_image.width,
            "height": pil_image.height,
        }]

        from app.manifest import Manifest, collect_model_fingerprint_controlnet, collect_model_fingerprint_flux2
        if pipeline_type == "flux2-klein":
            models = collect_model_fingerprint_flux2(lora_path=resolved_lora_path)
        else:
            models = collect_model_fingerprint_controlnet()
        manifest = Manifest.from_success(
            run_file, start_time, end_time, last_timings, output_files, models
        )
        manifest.to_json(manifest_file)
        print(f"Manifest:   {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        from app.manifest import Manifest
        manifest = Manifest.from_error(run_file, start_time, end_time, last_timings, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)

    return [out_path]


# ---------------------------------------------------------------------------
# A/B test runner
# ---------------------------------------------------------------------------

def _run_ab_test(prompt, ref_image_path, ctrl_type, skip_preprocess,
                 out_w, out_h, steps, seed, pipeline_type="zimage",
                 flux2_pipeline=None, lora_path=None, args=None):
    """Run ControlNet variations and open manifest review HTML."""
    from app.manifest import Manifest, collect_model_fingerprint_controlnet, collect_model_fingerprint_flux2

    manifest_files = []

    for label, strength, blur_ref, remove_outlines, skip_pp in _AB_VARIATIONS:
        print(f"\n{'=' * 60}")
        parts = [f"strength={strength}"]
        if blur_ref:
            parts.append(f"blur={blur_ref}")
        if remove_outlines:
            parts.append("remove-outlines")
        if skip_pp:
            parts.append("skip-preprocess")
        print(f"A/B Test — {label}  ({', '.join(parts)})")
        print(f"{'=' * 60}")

        run_file, manifest_file, out_path = _make_output_paths(
            f"controlnet_{label}"
        )
        run_meta = _build_run_meta(
            prompt=prompt,
            ref_image_path=ref_image_path,
            ctrl_type=ctrl_type,
            strength=strength,
            skip_preprocess=skip_pp,
            blur_ref=blur_ref,
            remove_outlines=remove_outlines,
            steps=steps,
            seed=seed,
            out_w=out_w,
            out_h=out_h,
            pipeline_type=pipeline_type,
        )
        _write_json(run_file, run_meta)
        print(f"Run config : {run_file}")

        start_time = datetime.now(timezone.utc).isoformat()
        last_timings = {}

        try:
            if pipeline_type == "flux2-klein":
                pil_image = _execute_generation_flux2(
                    prompt=prompt,
                    ref_image_path=ref_image_path,
                    ctrl_type=ctrl_type,
                    strength=strength,
                    skip_preprocess=skip_pp,
                    blur_ref=blur_ref,
                    remove_outlines=remove_outlines,
                    out_w=out_w,
                    out_h=out_h,
                    steps=steps,
                    seed=seed,
                    pipeline=flux2_pipeline,
                    args=args,
                )
            else:
                pil_image = _execute_generation(
                    prompt=prompt,
                    ref_image_path=ref_image_path,
                    ctrl_type=ctrl_type,
                    strength=strength,
                    skip_preprocess=skip_pp,
                    blur_ref=blur_ref,
                    remove_outlines=remove_outlines,
                    out_w=out_w,
                    out_h=out_h,
                    steps=steps,
                    seed=seed,
                    cnet_active_steps=getattr(args, "cnet_active_steps", None),
                )

            pil_image.save(out_path)
            print(f"Saved: {out_path}")

            end_time = datetime.now(timezone.utc).isoformat()
            output_files = [{
                "path": out_path,
                "seed": seed,
                "size_bytes": os.path.getsize(out_path),
                "width": pil_image.width,
                "height": pil_image.height,
            }]

            if pipeline_type == "flux2-klein":
                models = collect_model_fingerprint_flux2(lora_path=lora_path)
            else:
                models = collect_model_fingerprint_controlnet()
            manifest = Manifest.from_success(
                run_file, start_time, end_time, last_timings, output_files, models
            )
            manifest.to_json(manifest_file)
            print(f"Manifest:   {manifest_file}")
            manifest_files.append(manifest_file)

        except Exception as exc:
            end_time = datetime.now(timezone.utc).isoformat()
            manifest = Manifest.from_error(
                run_file, start_time, end_time, last_timings, exc, {}
            )
            manifest.to_json(manifest_file)
            print(f"ERROR in {label}: {type(exc).__name__}: {exc}", file=sys.stderr)
            traceback.print_exc()
            manifest_files.append(manifest_file)

    # Open manifest review HTML
    if manifest_files:
        import importlib
        _review_mod = importlib.import_module("app.commands.image-review")
        _open_manifest_review = _review_mod._open_manifest_review
        labels = [v[0] for v in _AB_VARIATIONS]
        _open_manifest_review(manifest_files, labels=labels)


# ---------------------------------------------------------------------------
# Flux2 Klein pipeline factory
# ---------------------------------------------------------------------------

def _create_flux2_pipeline(args):
    """Create a Flux2KleinControlnetPipeline from CLI args (loaded once, reused)."""
    from app.flux2_controlnet_pipeline import Flux2KleinControlnetPipeline
    from app.commands._shared import resolve_lora_path

    lora_path = resolve_lora_path(getattr(args, "lora_path", None))
    lora_paths = [lora_path] if lora_path else None
    lora_scales = [getattr(args, "lora_scale", None) or 1.0] if lora_paths else None

    return Flux2KleinControlnetPipeline(
        model_path=getattr(args, "flux2_model_path", None),
        quantize=getattr(args, "quantize", None),
        variant=getattr(args, "variant", "9b"),
        transformer_name=getattr(args, "transformer", "klein-9b"),
        lora_paths=lora_paths,
        lora_scales=lora_scales,
    )


# ---------------------------------------------------------------------------
# Core generation (shared by single run + A/B test)
# ---------------------------------------------------------------------------

def _execute_generation(prompt, ref_image_path, ctrl_type, strength,
                        skip_preprocess, blur_ref, remove_outlines,
                        out_w, out_h, steps, seed, cnet_active_steps=None) -> "Image.Image":
    """Run the full ControlNet pipeline. Returns PIL Image."""
    # ── Preprocess reference image ───────────────────────────────────────────
    ctrl_pil = _load_and_preprocess(
        ref_image_path, ctrl_type, out_w, out_h, skip_preprocess,
        blur_ref=blur_ref, remove_outlines=remove_outlines,
    )

    # ── VAE encode control image ─────────────────────────────────────────────
    print("[ControlNet] VAE encoding control image...", end=" ", flush=True)
    vae = _load_vae()
    ctrl_latent = _vae_encode(vae, ctrl_pil)   # [1, 16, H_lat, W_lat]
    # Apply Flux latent format (matches ComfyUI latent_formats.Flux.process_in)
    ctrl_latent = (ctrl_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR

    # Build 33-channel input: [ctrl_latent(16), mask(1), inpaint_latent(16)]
    ctrl_33ch = build_control_input_33ch(ctrl_latent, lambda img: _vae_encode(vae, img))
    mx.eval(ctrl_33ch)  # Force materialize before VAE is freed (lazy tensor safety)
    del vae
    _gc()
    print(f"Done → control input {list(ctrl_33ch.shape)}")

    # ── Generate with ControlNet ─────────────────────────────────────────────
    return _generate(
        prompt=prompt,
        out_w=out_w,
        out_h=out_h,
        steps=steps,
        seed=seed,
        ctrl_33ch=ctrl_33ch,
        strength=strength,
        cnet_active_steps=cnet_active_steps,
    )


def _execute_generation_flux2(prompt, ref_image_path, ctrl_type, strength,
                               skip_preprocess, blur_ref, remove_outlines,
                               out_w, out_h, steps, seed, pipeline, args=None) -> "Image.Image":
    """Run Flux2 Klein reference conditioning pipeline. Returns PIL Image.

    Uses Flux2KleinControlnetPipeline (reference latent concatenation) instead
    of a dedicated ControlNet model.  The pipeline instance must be created
    externally (by run_controlnet / _run_ab_test) so it is reused across
    A/B variations instead of re-loading ~17 GB of weights each time.
    """
    # ── Preprocess reference image (reuse existing preprocessing) ──────────
    ctrl_pil = _load_and_preprocess(
        ref_image_path, ctrl_type, out_w, out_h, skip_preprocess,
        blur_ref=blur_ref, remove_outlines=remove_outlines,
    )

    ref_count = getattr(args, "ref_count", 1) if args else 1

    # ── Generate ───────────────────────────────────────────────────────────
    print(f"[ControlNet/Flux2] Generating {out_w}×{out_h} "
          f"(steps={steps}, seed={seed}, strength={strength}, ref_count={ref_count})")
    result = pipeline.generate(
        prompt=prompt,
        control_image=ctrl_pil,
        width=out_w,
        height=out_h,
        steps=steps,
        seed=seed,
        controlnet_strength=strength,
        ref_count=ref_count,
    )
    return result.image


# ---------------------------------------------------------------------------
# Output path / metadata helpers
# ---------------------------------------------------------------------------

def _make_output_paths(base_name):
    """Return (run_file, manifest_file, output_png) for a given base name."""
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.png")
    return run_file, manifest_file, out_path


def _build_run_meta(prompt, ref_image_path, ctrl_type, strength,
                    skip_preprocess, blur_ref, remove_outlines, steps, seed,
                    out_w, out_h, scale=None, pipeline_type="zimage"):
    """Build run.json metadata dict."""
    return {
        "command": "image",
        "action": "controlnet",
        "pipeline": pipeline_type,
        "input_image": ref_image_path,
        "controlnet_type": ctrl_type,
        "controlnet_strength": strength,
        "skip_preprocess": skip_preprocess,
        "blur_ref": blur_ref,
        "remove_outlines": remove_outlines,
        "prompt": prompt,
        "steps": steps,
        "seed": seed,
        "width": out_w,
        "height": out_h,
        "scale": scale,
    }


def _write_json(path, data):
    """Write JSON with trailing newline."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------

def _load_and_preprocess(path: str, ctrl_type: str, out_w: int, out_h: int,
                          skip: bool, blur_ref: float | None = None,
                          remove_outlines: bool = False) -> "Image.Image":
    """Load and preprocess reference image. Returns PIL Image resized to (out_w, out_h)."""
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    if skip:
        if remove_outlines:
            print(f"[ControlNet] Removing outlines via inpainting...")
            img = _remove_outlines(img)
        if blur_ref is not None:
            print(f"[ControlNet] Applying Gaussian blur (sigma={blur_ref})...")
            img = _blur_ref_image(img, blur_ref)
        parts = []
        if remove_outlines:
            parts.append("outlines-removed")
        if blur_ref is not None:
            parts.append(f"blur={blur_ref}")
        desc = "+".join(parts) if parts else "raw"
        print(f"[ControlNet] Preprocessing skipped — using {desc} image as control.")
        return img
    if ctrl_type == "canny":
        return _apply_canny(img)
    print(
        f"[ControlNet] WARNING: preprocessor '{ctrl_type}' requires an external model. "
        f"Using raw image as fallback (run with --skip-preprocess to silence this warning).",
        file=sys.stderr,
    )
    return img


def _apply_canny(pil_img: "Image.Image") -> "Image.Image":
    """Apply Canny edge detection using cv2."""
    from PIL import Image
    try:
        import cv2
    except ImportError:
        print("[ControlNet] cv2 not available — using raw image instead of Canny.", file=sys.stderr)
        return pil_img
    import numpy as np
    gray = np.array(pil_img.convert("L"))
    edges = cv2.Canny(gray, threshold1=100, threshold2=200)
    # 3-channel so VAE expects RGB
    edges_rgb = np.stack([edges] * 3, axis=-1)
    return Image.fromarray(edges_rgb)


def _blur_ref_image(pil_img: "Image.Image", sigma: float) -> "Image.Image":
    """Apply Gaussian blur to soften thick outlines (苗框線) in the reference image.

    Softens the image into gradients that still convey pose/composition
    but won't produce sharp line artifacts in the ControlNet output.
    Higher sigma = more blur = less outline influence.
    """
    from PIL import ImageFilter
    # PIL GaussianBlur radius ≈ sigma * 2 for similar effect
    radius = max(1, int(sigma))
    blurred = pil_img.filter(ImageFilter.GaussianBlur(radius=radius))
    return blurred


def _remove_outlines(pil_img: "Image.Image", threshold: int = 80,
                     dilate: int = 2) -> "Image.Image":
    """Remove thick dark outlines (苗框線) via inpainting with surrounding colors.

    Detects dark pixels below threshold, dilates the mask slightly to cover
    anti-aliased edges, then uses cv2.inpaint to fill with neighboring colors.
    The result keeps color/pose information but removes harsh black outlines.
    """
    try:
        import cv2
    except ImportError:
        print("[ControlNet] cv2 not available — skipping outline removal.", file=sys.stderr)
        return pil_img

    import numpy as np
    from PIL import Image

    img_np = np.array(pil_img.convert("RGB"))
    gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)

    # Create mask of dark pixels (outlines)
    _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)

    # Dilate mask to cover anti-aliased edges around outlines
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.dilate(mask, kernel, iterations=dilate)

    # Inpaint: fill masked areas with surrounding colors
    result = cv2.inpaint(img_np, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)

    return Image.fromarray(result)


# ---------------------------------------------------------------------------
# VAE utilities
# ---------------------------------------------------------------------------

def _load_vae():
    """Load MLX-native ZImage VAE."""
    _add_mflux_to_path()
    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    vae = ZImageVAE()
    vae.load_weights(os.path.join(cfg.VAE_DIR, "model.safetensors"))
    mx.eval(vae.parameters())
    return vae


def _vae_encode(vae, pil_img: "Image.Image") -> mx.array:
    """Encode PIL image → latent [1, 16, H//8, W//8]."""
    from PIL import Image
    import numpy as np
    # Handle both PIL Image and numpy array input
    if isinstance(pil_img, Image.Image):
        img_np = np.array(pil_img.convert("RGB")).astype(np.float32) / 127.5 - 1.0
    else:
        img_np = np.array(pil_img).astype(np.float32) / 127.5 - 1.0
    # Ensure H, W are multiples of 8
    h, w = img_np.shape[:2]
    h8 = (h // 8) * 8
    w8 = (w // 8) * 8
    if h8 != h or w8 != w:
        img_np = img_np[:h8, :w8]
    img_mx = mx.array(img_np.transpose(2, 0, 1)[None]).astype(mx.bfloat16)  # [1, 3, H, W]
    encoded = vae.encode(img_mx)   # [1, 16, 1, H_lat, W_lat]
    if encoded.ndim == 5:
        encoded = encoded[:, :, 0, :, :]   # squeeze temporal → [1, 16, H_lat, W_lat]
    mx.eval(encoded)
    return encoded.astype(mx.bfloat16)


# ---------------------------------------------------------------------------
# Denoising loop with ControlNet injection (interleaved)
# ---------------------------------------------------------------------------

def _generate(prompt, out_w, out_h, steps, seed, ctrl_33ch, strength,
              cnet_active_steps=None) -> "Image.Image":
    """Run full denoising loop with interleaved ControlNet. Returns PIL Image.

    Args:
        cnet_active_steps: If set, only apply ControlNet for the first N steps
            (dual-sampler technique). None = apply on all steps.
    """
    from PIL import Image
    from transformers import AutoTokenizer
    from app.pipeline import (
        ZImageTransformerMLX,
        MLXFlowMatchEulerScheduler, create_coordinate_grid,
        calculate_shift, load_sharded_weights, _load_mlx_vae,
    )
    from app.text_encoder import TextEncoderMLX
    from app.controlnet import patchify_latent

    print("[ControlNet] Loading ControlNet weights...")
    controlnet = load_controlnet(cfg.CONTROLNET_DIR)

    # ── Phase 1: Text encoding ────────────────────────────────────────────
    print("[Phase 1] Text encoding...", end=" ", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(cfg.TOKENIZER_DIR, trust_remote_code=True)
    with open(os.path.join(cfg.TEXT_ENCODER_DIR, "config.json")) as f:
        te_config = json.load(f)
    text_encoder = TextEncoderMLX(te_config)
    nn.quantize(text_encoder, bits=4, group_size=32)
    text_encoder.load_weights(os.path.join(cfg.TEXT_ENCODER_DIR, "model.safetensors"))
    mx.eval(text_encoder)

    messages = [{"role": "user", "content": prompt}]
    try:
        prompt_fmt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        prompt_fmt = prompt
    inputs = tokenizer(prompt_fmt, padding="max_length", max_length=512, truncation=True, return_tensors="np")
    prompt_embeds = text_encoder(mx.array(inputs["input_ids"]))
    mx.eval(prompt_embeds)

    cap_feats_np = np.array(prompt_embeds)
    pad = (-cap_feats_np.shape[1]) % 32
    if pad > 0:
        cap_feats_np = np.concatenate([cap_feats_np, np.repeat(cap_feats_np[:, -1:, :], pad, axis=1)], axis=1)
    cap_feats_mx = mx.array(cap_feats_np).astype(mx.bfloat16)
    del text_encoder, tokenizer
    _gc()
    print("Done")

    # ── Phase 2: Transformer loading ─────────────────────────────────────
    print("[Phase 2] Loading transformer (4-bit)...", end=" ", flush=True)
    with open(os.path.join(cfg.TRANSFORMER_DIR, "config.json")) as f:
        t_config = json.load(f)
    model = ZImageTransformerMLX(t_config)
    nn.quantize(model, bits=4, group_size=32)
    if os.path.exists(os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors.index.json")):
        weights = load_sharded_weights(cfg.TRANSFORMER_DIR)
        model.load_weights(list(weights.items()))
        del weights
    else:
        model.load_weights(os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors"))
    model.fuse_model()
    model.eval()
    _gc()
    print("Done")

    # ── Phase 2.5: Embed control context ─────────────────────────────────
    print("[Phase 2.5] Embedding control context...", end=" ", flush=True)
    controlnet_context = controlnet.embed_control(ctrl_33ch)  # [1, N, 3840]
    mx.eval(controlnet_context)
    print(f"Done → {list(controlnet_context.shape)}")

    # ── Phase 3: Denoising with interleaved ControlNet ────────────────────
    print("[Phase 3] Denoising with ControlNet...")
    scheduler = MLXFlowMatchEulerScheduler(shift=3.0, use_dynamic_shifting=True)
    if seed is not None:
        np.random.seed(seed)

    noise = mx.array(np.random.randn(1, 16, out_h // 8, out_w // 8)).astype(mx.bfloat16)
    _, C_lat, H_lat, W_lat = noise.shape
    H_tok, W_tok = H_lat // 2, W_lat // 2
    mu = calculate_shift(H_tok * W_tok)
    scheduler.set_timesteps(steps, mu=mu)
    latents = noise

    total_len = cap_feats_mx.shape[1]
    img_pos = mx.array(
        create_coordinate_grid((1, H_tok, W_tok), (total_len + 1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    cap_pos = mx.array(
        create_coordinate_grid((total_len, 1, 1), (1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    unified_pos_all = mx.concatenate([img_pos, cap_pos], axis=1)
    cos_cached, sin_cached = model.prepare_rope(unified_pos_all)
    cos_cached = cos_cached.astype(mx.bfloat16)
    sin_cached = sin_cached.astype(mx.bfloat16)

    for i in range(steps):
        step_start = time.time()
        t_curr = scheduler.timesteps[i]
        t_input = (1.0 - t_curr)[None].astype(mx.bfloat16)

        # Reuse the pre-computed control context (identical input every step, no need to re-embed)
        step_controlnet_context = controlnet_context

        # Dual-sampler: only apply ControlNet for the first N steps
        active_strength = strength if (cnet_active_steps is None or i < cnet_active_steps) else 0.0

        # Run main transformer with interleaved ControlNet
        B, C, H, W = latents.shape
        x_reshaped = latents.reshape(C, 1, 1, H_tok, 2, W_tok, 2).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)
        out = model(x_reshaped, t_input, cap_feats_mx, img_pos, cap_pos,
                    cos_cached, sin_cached, cap_mask=None,
                    controlnet_model=controlnet,
                    controlnet_context=step_controlnet_context,
                    controlnet_strength=active_strength)
        noise_pred = -out.reshape(1, 1, H_tok, W_tok, 2, 2, C).transpose(6, 0, 1, 2, 4, 3, 5).reshape(1, C, H, W)

        latents = scheduler.step(noise_pred, i, latents)
        mx.eval(latents)
        print(f"   Step {i + 1}/{steps}: {time.time() - step_start:.2f}s")

    # ── Phase 4: Decode ───────────────────────────────────────────────────
    print("[Phase 4] Decoding...", end=" ", flush=True)
    del model, controlnet, cos_cached, sin_cached
    _gc()

    vae_dec = _load_mlx_vae()
    decoded = vae_dec.decode(latents.astype(mx.bfloat16))
    if decoded.ndim == 5:
        decoded = decoded[:, :, 0, :, :]
    image_np = np.array(mx.clip(decoded.astype(mx.float32) / 2.0 + 0.5, 0, 1))
    image_np = np.nan_to_num(image_np, nan=0.0, posinf=1.0, neginf=0.0)
    image_np = image_np[0].transpose(1, 2, 0)
    pil_image = Image.fromarray((image_np * 255).round().astype("uint8"))
    del vae_dec, decoded
    _gc()
    print("Done")
    return pil_image


# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

_SELF_TEST_PROMPT = (
    "A young woman standing in a simple pose, facing the camera, wearing "
    "casual clothes, clean white background, studio lighting, high quality "
    "portrait photography."
)

_SELF_TEST_REF_URL = (
    "https://images.unsplash.com/photo-1534528741775-53994a69daeb"
    "?w=1024&h=1280&fit=crop&crop=face"
)

# Self-test variations:
#   (label, strength, blur_sigma_or_None, remove_outlines, skip_preprocess, steps, cnet_active_steps_or_None)
#
# Based on A/B test findings (2026-06-08):
#   - Raw at strength >= 0.6 causes multi-limb artifacts without blur
#   - Canny is stable at any strength
#   - Blur(5) + raw at 0.6 = best quality (5/5)
#   - Strength 0.4 + raw = safest without blur
_SELF_TEST_VARIATIONS = [
    # Row 1: Baseline — pure T2I, no ControlNet
    ("baseline",            None, None, False, True,   9, None),
    # Row 2: Raw strength sweep (0.2 → 0.6, all safe range)
    ("str02-raw-9st",       0.2, None, False, True,   9, None),
    ("str04-raw-9st",       0.4, None, False, True,   9, None),
    ("str06-raw-9st",       0.6, None, False, True,   9, None),
    # Row 3: Canny strength sweep (stable at any strength)
    ("str06-canny-9st",     0.6, None, False, False,  9, None),
    ("str10-canny-9st",     1.0, None, False, False,  9, None),
    # Row 4: Blur comparison (known best settings)
    ("str06-raw-blur5-9st", 0.6, 5.0,  False, True,   9, None),  # Best from A/B test
    ("str06-raw-blur10-9st",0.6, 10.0, False, True,   9, None),  # Higher blur
    # Row 5: Steps comparison (using blur5 to avoid multi-limb)
    ("str06-raw-blur5-15st",       0.6, 5.0, False, True, 15, None),
    ("str06-raw-blur5-15st-act5",  0.6, 5.0, False, True, 15, 5),
]


def _run_self_test(args):
    """Run ControlNet self-test: generate reference + variations, open bilingual review HTML.

    Steps:
      1. Download a simple reference image (or reuse cached)
      2. Generate baseline (no ControlNet) + predefined variations
      3. Generate bilingual (EN/zh_TW) review HTML with scoring guide
      4. Open in browser
    """
    from PIL import Image

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)

    print(f"\n{'#'*60}")
    print(f" ControlNet Self-Test")
    print(f"{'#'*60}")

    # ── Step 1: Reference image ────────────────────────────────────────────
    ref_path = os.path.join(cfg.OUTPUT_DIR, "selftest-ref-standing.jpg")
    if not os.path.exists(ref_path):
        print(f"\n[Self-Test] Downloading reference image...")
        try:
            import urllib.request
            urllib.request.urlretrieve(_SELF_TEST_REF_URL, ref_path)
            print(f"  Saved: {ref_path}")
        except Exception as e:
            print(f"  Download failed: {e}", file=sys.stderr)
            print(f"  Using existing test-ref-standing.jpg as fallback", file=sys.stderr)
            fallback = os.path.join(cfg.OUTPUT_DIR, "test-ref-standing.jpg")
            if os.path.exists(fallback):
                ref_path = fallback
            else:
                print(f"  ERROR: No reference image available.", file=sys.stderr)
                sys.exit(1)
    else:
        print(f"\n[Self-Test] Reusing cached reference: {ref_path}")

    with Image.open(ref_path) as img:
        src_w, src_h = img.size
    out_w = (src_w // 16) * 16
    out_h = (src_h // 16) * 16
    print(f"  Size: {src_w}×{src_h} → output {out_w}×{out_h}")

    seed = getattr(args, "seed", 42)

    # ── Step 2: Generate variations ────────────────────────────────────────
    results = []  # (label, img_filename, params_dict, run_config_dict)

    for label, strength, blur_ref, remove_outlines, skip_pp, steps, cnet_active in _SELF_TEST_VARIATIONS:
        print(f"\n{'='*60}")
        print(f"[Self-Test] {label}")
        print(f"{'='*60}")

        img_filename = f"selftest_{label}-s{seed}.png"

        if strength is None:
            # Baseline: pure T2I (no ControlNet)
            print(f"  Type: Baseline (no ControlNet)")
            pil_image = _generate_baseline(
                prompt=_SELF_TEST_PROMPT,
                out_w=out_w, out_h=out_h,
                steps=steps, seed=seed,
            )
            params = {"strength": "N/A", "preprocess": "N/A", "steps": steps, "seed": seed}
            run_config = None
        else:
            parts = [f"strength={strength}"]
            if skip_pp:
                parts.append("raw")
            else:
                parts.append("canny")
            if blur_ref:
                parts.append(f"blur={blur_ref}")
            if cnet_active:
                parts.append(f"active={cnet_active}")
            print(f"  Type: ControlNet ({', '.join(parts)})")

            pil_image = _execute_generation(
                prompt=_SELF_TEST_PROMPT,
                ref_image_path=ref_path,
                ctrl_type="canny",
                strength=strength,
                skip_preprocess=skip_pp,
                blur_ref=blur_ref,
                remove_outlines=remove_outlines,
                out_w=out_w,
                out_h=out_h,
                steps=steps,
                seed=seed,
                cnet_active_steps=cnet_active,
            )
            params = {
                "strength": strength,
                "preprocess": "raw" if skip_pp else "canny",
                "steps": steps,
                "cnet_active_steps": cnet_active,
                "seed": seed,
            }
            run_config = {
                "command": "image",
                "action": "controlnet",
                "pipeline": "zimage",
                "controlnet_strength": strength,
                "skip_preprocess": skip_pp,
                "blur_ref": blur_ref,
                "remove_outlines": remove_outlines,
                "steps": steps,
                "cnet_active_steps": cnet_active,
                "seed": seed,
            }

        out_path = os.path.join(cfg.OUTPUT_DIR, img_filename)
        pil_image.save(out_path)
        print(f"  Saved: {out_path}")

        results.append({
            "id": label,
            "label": label,
            "img": img_filename,
            "params": params,
            "run_config": run_config,
        })

    # ── Step 3: Generate bilingual review HTML ─────────────────────────────
    print(f"\n{'='*60}")
    print(f"[Self-Test] Generating review HTML")
    print(f"{'='*60}")

    html_path = os.path.join(cfg.OUTPUT_DIR, "controlnet_selftest_review.html")
    _generate_self_test_html(html_path, results, ref_image=os.path.basename(ref_path))
    print(f"  Saved: {html_path}")

    # ── Step 4: Open in browser ────────────────────────────────────────────
    import webbrowser
    webbrowser.open(f"file://{os.path.abspath(html_path)}")
    print(f"  Opened in browser")


def _generate_baseline(prompt, out_w, out_h, steps, seed):
    """Generate a baseline T2I image (no ControlNet). Returns PIL Image."""
    from PIL import Image
    from transformers import AutoTokenizer
    from app.pipeline import (
        ZImageTransformerMLX,
        MLXFlowMatchEulerScheduler, create_coordinate_grid,
        calculate_shift, load_sharded_weights, _load_mlx_vae,
    )
    from app.text_encoder import TextEncoderMLX

    print("[Baseline] Loading text encoder...", end=" ", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(cfg.TOKENIZER_DIR, trust_remote_code=True)
    with open(os.path.join(cfg.TEXT_ENCODER_DIR, "config.json")) as f:
        te_config = json.load(f)
    text_encoder = TextEncoderMLX(te_config)
    nn.quantize(text_encoder, bits=4, group_size=32)
    text_encoder.load_weights(os.path.join(cfg.TEXT_ENCODER_DIR, "model.safetensors"))
    mx.eval(text_encoder)

    messages = [{"role": "user", "content": prompt}]
    try:
        prompt_fmt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        prompt_fmt = prompt
    inputs = tokenizer(prompt_fmt, padding="max_length", max_length=512, truncation=True, return_tensors="np")
    prompt_embeds = text_encoder(mx.array(inputs["input_ids"]))
    mx.eval(prompt_embeds)

    cap_feats_np = np.array(prompt_embeds)
    pad = (-cap_feats_np.shape[1]) % 32
    if pad > 0:
        cap_feats_np = np.concatenate([cap_feats_np, np.repeat(cap_feats_np[:, -1:, :], pad, axis=1)], axis=1)
    cap_feats_mx = mx.array(cap_feats_np).astype(mx.bfloat16)
    del text_encoder, tokenizer
    _gc()
    print("Done")

    print("[Baseline] Loading transformer (4-bit)...", end=" ", flush=True)
    with open(os.path.join(cfg.TRANSFORMER_DIR, "config.json")) as f:
        t_config = json.load(f)
    model = ZImageTransformerMLX(t_config)
    nn.quantize(model, bits=4, group_size=32)
    if os.path.exists(os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors.index.json")):
        weights = load_sharded_weights(cfg.TRANSFORMER_DIR)
        model.load_weights(list(weights.items()))
        del weights
    else:
        model.load_weights(os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors"))
    model.fuse_model()
    model.eval()
    _gc()
    print("Done")

    print("[Baseline] Denoising...")
    scheduler = MLXFlowMatchEulerScheduler(shift=3.0, use_dynamic_shifting=True)
    if seed is not None:
        np.random.seed(seed)

    noise = mx.array(np.random.randn(1, 16, out_h // 8, out_w // 8)).astype(mx.bfloat16)
    _, C_lat, H_lat, W_lat = noise.shape
    H_tok, W_tok = H_lat // 2, W_lat // 2
    mu = calculate_shift(H_tok * W_tok)
    scheduler.set_timesteps(steps, mu=mu)
    latents = noise

    total_len = cap_feats_mx.shape[1]
    img_pos = mx.array(
        create_coordinate_grid((1, H_tok, W_tok), (total_len + 1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    cap_pos = mx.array(
        create_coordinate_grid((total_len, 1, 1), (1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    unified_pos_all = mx.concatenate([img_pos, cap_pos], axis=1)
    cos_cached, sin_cached = model.prepare_rope(unified_pos_all)
    cos_cached = cos_cached.astype(mx.bfloat16)
    sin_cached = sin_cached.astype(mx.bfloat16)

    for i in range(steps):
        step_start = time.time()
        t_curr = scheduler.timesteps[i]
        t_input = (1.0 - t_curr)[None].astype(mx.bfloat16)
        B, C, H, W = latents.shape
        x_reshaped = latents.reshape(C, 1, 1, H_tok, 2, W_tok, 2).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)
        out = model(x_reshaped, t_input, cap_feats_mx, img_pos, cap_pos,
                    cos_cached, sin_cached, cap_mask=None)
        noise_pred = -out.reshape(1, 1, H_tok, W_tok, 2, 2, C).transpose(6, 0, 1, 2, 4, 3, 5).reshape(1, C, H, W)
        latents = scheduler.step(noise_pred, i, latents)
        mx.eval(latents)
        print(f"   Step {i + 1}/{steps}: {time.time() - step_start:.2f}s")

    print("[Baseline] Decoding...", end=" ", flush=True)
    del model, cos_cached, sin_cached
    _gc()

    vae_dec = _load_mlx_vae()
    decoded = vae_dec.decode(latents.astype(mx.bfloat16))
    if decoded.ndim == 5:
        decoded = decoded[:, :, 0, :, :]
    image_np = np.array(mx.clip(decoded.astype(mx.float32) / 2.0 + 0.5, 0, 1))
    image_np = np.nan_to_num(image_np, nan=0.0, posinf=1.0, neginf=0.0)
    image_np = image_np[0].transpose(1, 2, 0)
    pil_image = Image.fromarray((image_np * 255).round().astype("uint8"))
    del vae_dec, decoded
    _gc()
    print("Done")
    return pil_image


def _generate_self_test_html(html_path, results, ref_image):
    """Generate bilingual (EN/zh_TW) review HTML with scoring guide."""
    import html as html_mod

    tests_json = json.dumps(results, ensure_ascii=False)

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ControlNet Self-Test Review</title>
<style>
  :root {{ --bg: #1a1a2e; --card: #16213e; --border: #0f3460; --accent: #e94560;
           --text: #eee; --muted: #999; --success: #4ecca3; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; padding-bottom: 80px; }}

  /* Header */
  .header {{ text-align: center; margin-bottom: 20px; }}
  .header h1 {{ font-size: 1.6em; margin-bottom: 4px; }}
  .header .subtitle {{ color: var(--muted); font-size: 0.9em; }}
  .lang-toggle {{ display: inline-flex; background: var(--border); border-radius: 6px; overflow: hidden; margin-top: 8px; }}
  .lang-toggle button {{ padding: 6px 16px; border: none; background: transparent; color: var(--muted);
    cursor: pointer; font-size: 0.85em; font-weight: 600; transition: all 0.2s; }}
  .lang-toggle button.active {{ background: var(--accent); color: #fff; }}

  /* Scoring guide */
  .guide {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    margin-bottom: 20px; overflow: hidden; }}
  .guide-header {{ padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between;
    align-items: center; user-select: none; }}
  .guide-header:hover {{ background: rgba(255,255,255,0.03); }}
  .guide-header h2 {{ font-size: 1em; }}
  .guide-header .chevron {{ transition: transform 0.2s; font-size: 0.8em; }}
  .guide-header .chevron.open {{ transform: rotate(180deg); }}
  .guide-body {{ padding: 0 16px 16px; display: none; }}
  .guide-body.open {{ display: block; }}
  .guide-body h3 {{ font-size: 0.9em; color: var(--accent); margin: 12px 0 6px; }}
  .guide-body p, .guide-body li {{ font-size: 0.82em; line-height: 1.7; color: #ccc; }}
  .guide-body ul {{ padding-left: 20px; }}
  .guide-body li {{ margin-bottom: 4px; }}
  .guide-body .tip {{ background: rgba(233,69,96,0.1); border-left: 3px solid var(--accent);
    padding: 8px 12px; border-radius: 0 6px 6px 0; margin: 8px 0; font-size: 0.82em; }}

  /* Grid */
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-bottom: 24px; }}
  .card {{ background: var(--card); border: 2px solid var(--border); border-radius: 12px;
    padding: 12px; transition: border-color 0.2s; }}
  .card:hover {{ border-color: var(--accent); }}
  .card.highlighted {{ border-color: var(--success); box-shadow: 0 0 12px rgba(78,204,163,0.3); }}
  .card-title {{ font-weight: 700; font-size: 0.95em; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }}
  .card-title .badge {{ font-size: 0.7em; background: var(--border); padding: 2px 8px; border-radius: 4px; }}
  .card-title .badge.baseline {{ background: rgba(78,204,163,0.2); color: var(--success); }}
  .card-title .badge.cnet {{ background: rgba(233,69,96,0.2); color: var(--accent); }}
  .card-img-wrap {{ position: relative; width: 100%; aspect-ratio: 4/5; overflow: hidden; border-radius: 8px;
    background: #111; cursor: zoom-in; margin-bottom: 8px; }}
  .card-img-wrap img {{ width: 100%; height: 100%; object-fit: contain; }}
  .card-img-wrap .zoom-hint {{ position: absolute; bottom: 4px; right: 4px; background: rgba(0,0,0,0.6);
    color: #fff; font-size: 0.7em; padding: 2px 6px; border-radius: 4px; }}
  .params {{ font-size: 0.78em; color: var(--muted); margin-bottom: 8px; line-height: 1.5; }}
  .params span {{ display: inline-block; background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 3px; margin: 1px 2px; }}
  .rating-row {{ display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.82em; }}
  .rating-row label {{ min-width: 90px; color: var(--muted); font-size: 0.8em; }}
  .stars {{ display: flex; gap: 2px; }}
  .stars span {{ font-size: 1.3em; cursor: pointer; opacity: 0.3; transition: opacity 0.15s; }}
  .stars span.active {{ opacity: 1; }}
  .stars span:hover {{ opacity: 0.8; }}
  .comment-box {{ width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 8px; font-size: 0.8em; resize: vertical; min-height: 40px; font-family: inherit; }}
  .winner-btn {{ background: none; border: 1px solid var(--border); color: var(--muted); padding: 4px 12px;
    border-radius: 6px; cursor: pointer; font-size: 0.78em; transition: all 0.2s; margin-top: 4px; }}
  .winner-btn:hover {{ border-color: var(--success); color: var(--success); }}
  .winner-btn.selected {{ background: var(--success); color: #1a1a2e; border-color: var(--success); font-weight: 700; }}

  /* Bottom bar */
  .bottom-bar {{ position: fixed; bottom: 0; left: 0; right: 0; background: var(--card); border-top: 1px solid var(--border);
    padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; }}
  .btn {{ padding: 8px 20px; border-radius: 8px; border: none; font-size: 0.9em; cursor: pointer; font-weight: 600; transition: opacity 0.2s; }}
  .btn-primary {{ background: var(--accent); color: #fff; }}
  .btn-primary:hover {{ opacity: 0.85; }}
  .btn-secondary {{ background: var(--border); color: var(--text); }}
  .btn-secondary:hover {{ opacity: 0.85; }}
  .winner-count {{ font-size: 0.85em; color: var(--muted); }}

  /* Overlay */
  .overlay {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 200; cursor: zoom-out;
    justify-content: center; align-items: center; }}
  .overlay.show {{ display: flex; }}
  .overlay img {{ max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 8px; }}

  /* Modal */
  .modal {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 300;
    justify-content: center; align-items: center; }}
  .modal.show {{ display: flex; }}
  .modal-content {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    width: 90vw; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column; }}
  .modal-header {{ padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }}
  .modal-body {{ flex: 1; overflow: auto; padding: 16px 20px; }}
  .modal-body pre {{ white-space: pre-wrap; word-break: break-all; font-size: 0.8em; line-height: 1.6; color: #a8d8ea; }}
</style>
</head>
<body>

<div class="header">
  <h1 data-en="🔬 Z-Image ControlNet Self-Test" data-zh="🔬 Z-Image ControlNet 自動測試"></h1>
  <p class="subtitle" data-en="Click images to zoom · Rate each test · Pick winners → Generate JSON" data-zh="點擊圖片放大 · 評分每張測試 · 選出最佳 → 產出 JSON"></p>
  <div class="lang-toggle">
    <button class="active" onclick="setLang('en')">EN</button>
    <button onclick="setLang('zh')">中文</button>
  </div>
</div>

<!-- Scoring Guide -->
<div class="guide">
  <div class="guide-header" onclick="toggleGuide()">
    <h2 data-en="📖 How to Score — Click to Expand" data-zh="📖 評分指南 — 點擊展開"></h2>
    <span class="chevron">▼</span>
  </div>
  <div class="guide-body" id="guideBody">
    <p data-en="Rate each image on 4 criteria using 1–5 stars. The goal is to determine whether ControlNet is working correctly and find the best settings."
       data-zh="每張圖片依 4 個面向以 1–5 顆星評分。目的是確認 ControlNet 是否正常運作，並找出最佳設定。"></p>

    <h3 data-en="⭐ Criteria" data-zh="⭐ 評分面向"></h3>
    <ul>
      <li data-en="<b>CN Influence (ControlNet 影響力)</b>: How much does the output differ from the baseline? A working ControlNet should visibly change pose/composition compared to the baseline. <b>Score 1</b> = identical to baseline (ControlNet not working), <b>Score 5</b> = strong visible influence."
             data-zh="<b>CN Influence（ControlNet 影響力）</b>：輸出與 baseline 差異多大？正常運作的 ControlNet 應明顯改變姿勢/構圖。<b>1 分</b> = 與 baseline 完全相同（ControlNet 沒作用），<b>5 分</b> = 明顯受到控制。"></li>
      <li data-en="<b>Pose Match (姿勢吻合度)</b>: Does the output pose/composition match the reference image? Higher = better alignment with the reference pose. <b>Score 1</b> = completely different pose, <b>Score 5</b> = perfect pose match."
             data-zh="<b>Pose Match（姿勢吻合度）</b>：輸出的姿勢/構圖是否與參考圖吻合？越高分 = 與參考姿勢越一致。<b>1 分</b> = 完全不同的姿勢，<b>5 分</b> = 完美吻合。"></li>
      <li data-en="<b>Low Artifacts (低瑕疵)</b>: Are there unwanted artifacts? Look for: extra limbs, deformed faces, melting textures, line artifacts from thick outlines. <b>Score 1</b> = severe artifacts, <b>Score 5</b> = clean output."
             data-zh="<b>Low Artifacts（低瑕疵）</b>：是否有不想要的瑕疵？注意：多餘肢體、變形臉部、融化紋理、粗框線造成的線條瑕疵。<b>1 分</b> = 嚴重瑕疵，<b>5 分</b> = 乾淨輸出。"></li>
      <li data-en="<b>Overall Quality (整體品質)</b>: Your subjective overall quality rating considering aesthetics, detail, and naturalness. <b>Score 1</b> = terrible, <b>Score 5</b> = excellent."
             data-zh="<b>Overall Quality（整體品質）</b>：主觀整體品質評分，綜合考量美感、細節和自然度。<b>1 分</b> = 很差，<b>5 分</b> = 非常好。"></li>
    </ul>

    <h3 data-en="🎯 How to Compare" data-zh="🎯 比較方式"></h3>
    <ul>
      <li data-en="<b>Start with baseline</b>: This is the pure T2I result with no ControlNet. All other tests should differ from this."
             data-zh="<b>先看 baseline</b>：這是沒有 ControlNet 的純 T2I 結果。所有其他測試應與此不同。"></li>
      <li data-en="<b>Compare by rows</b>: Same strength, different preprocessing (raw vs canny) — which handles the reference better?"
             data-zh="<b>逐行比較</b>：相同強度、不同預處理（raw vs canny）— 哪種處理參考圖效果更好？"></li>
      <li data-en="<b>Compare by columns</b>: Same preprocessing, different strength (0.4 → 1.0) — how does strength affect quality?"
             data-zh="<b>逐列比較</b>：相同預處理、不同強度（0.4 → 1.0）— 強度如何影響品質？"></li>
      <li data-en="<b>Dual-sampler test</b>: The last test (15 steps, active=5) applies ControlNet only for the first 5 steps, then lets the model run freely — often produces cleaner results."
             data-zh="<b>雙取樣器測試</b>：最後一個測試（15 步、active=5）僅在前 5 步套用 ControlNet，之後讓模型自由運作 — 通常產生更乾淨的結果。"></li>
    </ul>

    <div class="tip" data-en="💡 <b>Quick check</b>: If all ControlNet results look identical to baseline, the ControlNet is NOT working. If strength=1.0 looks burnt/over-saturated, that's normal — lower strength (0.6–0.8) usually works best."
         data-zh="💡 <b>快速判斷</b>：如果所有 ControlNet 結果都和 baseline 長得一樣，ControlNet 就沒在作用。如果 strength=1.0 看起來過飽和/燒焦，這是正常的 — 較低的強度（0.6–0.8）通常效果最好。"></div>
  </div>
</div>

<div class="grid" id="grid"></div>

<div class="bottom-bar">
  <span class="winner-count" id="winnerCount" data-en="0 winners selected" data-zh="已選 0 個最佳"></span>
  <div>
    <button class="btn btn-secondary" onclick="resetAll()" style="margin-right:8px" data-en="Reset All" data-zh="全部重設"></button>
    <button class="btn btn-primary" onclick="generateJSON()">📋 Generate JSON</button>
  </div>
</div>

<div class="overlay" id="overlay" onclick="this.classList.remove('show')">
  <img id="overlayImg" src="">
</div>

<div class="modal" id="modal">
  <div class="modal-content">
    <div class="modal-header">
      <strong>📋 Review Results JSON</strong>
      <div>
        <button class="btn btn-secondary" onclick="copyJSON()" style="margin-right:8px">Copy</button>
        <button class="btn btn-secondary" onclick="downloadJSON()" style="margin-right:8px">Download</button>
        <button class="btn btn-primary" onclick="document.getElementById('modal').classList.remove('show')">Close</button>
      </div>
    </div>
    <div class="modal-body">
      <pre id="jsonOutput"></pre>
    </div>
  </div>
</div>

<script>
const TESTS = {tests_json};

const CRITERIA = [
  {{ key: "controlnet_influence", en: "CN Influence", zh: "CN 影響力" }},
  {{ key: "pose_fidelity",       en: "Pose Match",    zh: "姿勢吻合" }},
  {{ key: "artifact_level",      en: "Low Artifacts", zh: "低瑕疵" }},
  {{ key: "overall_quality",     en: "Overall Quality", zh: "整體品質" }}
];

// State
let lang = 'en';
const state = {{}};
TESTS.forEach(t => {{
  state[t.id] = {{ ratings: {{}}, comment: "", winner: false }};
  CRITERIA.forEach(c => state[t.id].ratings[c.key] = 0);
}});

// ── Language switching ──────────────────────────────────────────────────
function setLang(l) {{
  lang = l;
  document.querySelectorAll('.lang-toggle button').forEach(b => b.classList.remove('active'));
  document.querySelector(`.lang-toggle button:${{l === 'en' ? 'first' : 'last'}}-child`).classList.add('active');

  // Update all [data-en] / [data-zh] elements
  document.querySelectorAll('[data-' + l + ']').forEach(el => {{
    el.innerHTML = el.getAttribute('data-' + l);
  }});

  // Re-render grid with new language labels
  renderGrid();
  updateWinnerCount();
}}

// ── Guide toggle ────────────────────────────────────────────────────────
function toggleGuide() {{
  const body = document.getElementById('guideBody');
  const chevron = document.querySelector('.guide-header .chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
}}

// ── Grid rendering ──────────────────────────────────────────────────────
function getTestLabel(t) {{
  if (t.id === 'baseline') return lang === 'en' ? 'Baseline (no ControlNet)' : 'Baseline（無 ControlNet）';
  const p = t.params;
  let label = '';
  if (t.id === 'baseline') return label;
  label += 'str=' + p.strength;
  label += ' ' + (p.preprocess === 'raw' ? 'raw' : 'canny');
  if (p.steps) label += ' ' + p.steps + 'st';
  if (p.cnet_active_steps) label += ' act=' + p.cnet_active_steps;
  return label;
}}

function getTestBadge(t) {{
  if (t.id === 'baseline') return '<span class="badge baseline">' + (lang === 'en' ? 'Baseline' : '基線') + '</span>';
  return '<span class="badge cnet">ControlNet</span>';
}}

function renderGrid() {{
  const grid = document.getElementById('grid');
  grid.innerHTML = TESTS.map(t => {{
    const paramsHtml = Object.entries(t.params).map(([k,v]) => `<span>${{k}}=${{v}}</span>`).join('');
    const starsHtml = CRITERIA.map(c => {{
      const critLabel = c[lang];
      const stars = [1,2,3,4,5].map(s =>
        `<span class="${{state[t.id].ratings[c.key] >= s ? 'active' : ''}}" onclick="setRating('${{t.id}}','${{c.key}}',${{s}})">★</span>`
      ).join('');
      return `<div class="rating-row"><label>${{critLabel}}</label><div class="stars">${{stars}}</div></div>`;
    }}).join('');

    return `
    <div class="card ${{state[t.id].winner ? 'highlighted' : ''}}" id="card-${{t.id}}">
      <div class="card-title">
        <span>${{getTestLabel(t)}}</span>
        ${{getTestBadge(t)}}
      </div>
      <div class="card-img-wrap" onclick="zoom('${{t.img}}')">
        <img src="${{t.img}}" loading="lazy" alt="${{t.id}}">
        <span class="zoom-hint">🔍</span>
      </div>
      <div class="params">${{paramsHtml}}</div>
      ${{starsHtml}}
      <textarea class="comment-box" placeholder="${{lang === 'en' ? 'Comments...' : '評論...'}}"
        id="comment-${{t.id}}" oninput="state['${{t.id}}'].comment=this.value">${{state[t.id].comment}}</textarea>
      <button class="winner-btn ${{state[t.id].winner ? 'selected' : ''}}" onclick="toggleWinner('${{t.id}}')">
        ${{state[t.id].winner
            ? '✅ ' + (lang === 'en' ? 'Winner' : '最佳')
            : '🏆 ' + (lang === 'en' ? 'Mark Winner' : '標記最佳')}}
      </button>
    </div>`;
  }}).join('');
}}

function setRating(testId, criterion, value) {{
  state[testId].ratings[criterion] = value;
  renderGrid();
}}

function toggleWinner(testId) {{
  state[testId].winner = !state[testId].winner;
  updateWinnerCount();
  renderGrid();
}}

function updateWinnerCount() {{
  const count = Object.values(state).filter(s => s.winner).length;
  document.getElementById('winnerCount').textContent =
    lang === 'en' ? `${{count}} winner${{count !== 1 ? 's' : ''}} selected`
                  : `已選 ${{count}} 個最佳`;
}}

function zoom(imgSrc) {{
  document.getElementById('overlayImg').src = imgSrc;
  document.getElementById('overlay').classList.add('show');
}}

function resetAll() {{
  const msg = lang === 'en' ? 'Reset all ratings, comments, and winners?' : '重設所有評分、評論和最佳選擇？';
  if (!confirm(msg)) return;
  TESTS.forEach(t => {{
    state[t.id].ratings = {{}};
    state[t.id].comment = "";
    state[t.id].winner = false;
    CRITERIA.forEach(c => state[t.id].ratings[c.key] = 0);
    const ta = document.getElementById('comment-' + t.id);
    if (ta) ta.value = '';
  }});
  updateWinnerCount();
  renderGrid();
}}

function generateJSON() {{
  const results = TESTS.map(t => ({{
    id: t.id,
    label: getTestLabel(t),
    image_file: t.img,
    parameters: t.params,
    run_config: t.run_config,
    feedback: {{
      ratings: {{ ...state[t.id].ratings }},
      comment: state[t.id].comment,
      is_winner: state[t.id].winner
    }}
  }}));

  const winners = results.filter(r => r.feedback.is_winner);
  const output = {{
    title: "Z-Image ControlNet Self-Test Results",
    date: new Date().toISOString(),
    reference_image: "{html_mod.escape(ref_image)}",
    reference_prompt: "{html_mod.escape(_SELF_TEST_PROMPT)}",
    language: lang,
    total_tests: results.length,
    winners: winners.map(w => w.id),
    results: results
  }};

  const jsonStr = JSON.stringify(output, null, 2);
  document.getElementById('jsonOutput').textContent = jsonStr;
  document.getElementById('modal').classList.add('show');
}}

function copyJSON() {{
  const text = document.getElementById('jsonOutput').textContent;
  navigator.clipboard.writeText(text).then(() => {{
    const btn = event.target;
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  }});
}}

function downloadJSON() {{
  const text = document.getElementById('jsonOutput').textContent;
  const blob = new Blob([text], {{ type: 'application/json' }});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `controlnet_selftest_${{new Date().toISOString().slice(0,10)}}.json`;
  a.click();
  URL.revokeObjectURL(url);
}}

// Init
renderGrid();
</script>
</body>
</html>"""

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _add_mflux_to_path():
    here = os.path.dirname(os.path.abspath(__file__))
    vendor = os.path.join(here, "..", "..", "vendor", "mflux", "src")
    if os.path.isdir(vendor) and vendor not in sys.path:
        sys.path.insert(0, vendor)


def _gc():
    if hasattr(mx, "clear_cache"):
        mx.clear_cache()
    gc.collect()
