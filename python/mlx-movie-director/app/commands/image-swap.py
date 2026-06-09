"""image-swap — SAM3 text-prompted swap: segment any region, composite reference image.

Uses mlx-vlm's Sam3Predictor to perform text-prompted segmentation on a source
image, then composites a reference image onto the masked region with edge
feathering.  Optionally runs Flux Klein I2I to blend the result.

Pipeline:
  1. SAM3 text-prompted segmentation → binary mask of target region
  2. Feathered alpha composite of reference onto source at mask region
  3. (Optional) Flux Klein I2I refinement at --blend-strength

This enables face swaps, outfit swaps, object swaps, etc. — any region that
SAM3 can identify from a text prompt can be replaced with reference content.

Memory management:
  SAM3 model (~4 GB) stays loaded (lightweight).  Flux Klein (~17 GB) only
  loads if --blend is used, and unloads immediately after.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_swap_args(parser)  — register swap-specific CLI arguments
  run_swap(args)         — execute swap generation
"""

import gc
import json
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
from PIL import Image

from app import config as cfg
from app.commands._shared import generate_base_name
from app.manifest import (
    Manifest,
    collect_model_fingerprint,
)

# ---------------------------------------------------------------------------
# Swap prompts for Flux Klein I2I blending
# ---------------------------------------------------------------------------

_BLEND_PROMPT = (
    "Seamlessly blend the composited region with the surrounding image. "
    "Maintain consistent lighting, skin tone, and texture. "
    "Preserve all details outside the swapped region."
)

# ---------------------------------------------------------------------------
# Test prompts for --self-test mode
# ---------------------------------------------------------------------------

_TEST_BODY_PROMPT = (
    "Moody Photography, 18-year-old Japanese girl in school uniform, "
    "navy blue sailor top, white collar with red ribbon, plaid skirt, "
    "kneeling at desk, warm lamp light from left, cool moonlight from window, "
    "half-body shot from above, looking at camera with pensive expression, "
    "hands resting on desk, textbooks and ramune bottle on desk."
)

_TEST_REF_PROMPT = (
    "Moody Photography, close-up portrait of a 22-year-old European woman, "
    "shoulder-length wavy blonde hair, blue eyes, light freckles across nose, "
    "confident direct gaze, warm golden hour side lighting, "
    "shallow depth of field, film grain texture, neutral background."
)

# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "SAM3 text-prompted swap: segment any region, composite reference image",
    "description": (
        "Swap any visual element using SAM3 text-prompted segmentation.\n\n"
        "Pipeline: SAM3 mask → feathered alpha composite → optional Flux Klein I2I blend.\n\n"
        "Examples:\n"
        "  # Face swap\n"
        "  run.py image swap --input body.png --reference face.png --sam-prompt \"woman's face\"\n\n"
        "  # Outfit swap with blending\n"
        "  run.py image swap --input person.png --reference outfit.png --sam-prompt \"outfit\" --blend\n\n"
        "  # Object swap\n"
        "  run.py image swap --input plate.png --reference chocolate.png --sam-prompt \"cake\"\n\n"
        "  # Just segment and save mask (no reference needed)\n"
        "  run.py image swap --input photo.png --sam-prompt \"person\" --save-mask\n\n"
        "  # Self-test\n"
        "  run.py image swap --self-test\n"
    ),
}


def add_swap_args(parser):
    """Register swap-specific arguments on an argparse parser."""
    parser.add_argument(
        "--reference", type=str, default=None, metavar="IMAGE",
        help="Reference image to swap IN (face, outfit, object). "
             "Required unless --save-mask only.",
    )
    parser.add_argument(
        "--sam-prompt", type=str, default=None,
        help="Text prompt for SAM3 segmentation on source (e.g. 'bottle', 'outfit'). "
             "Required for swap operations.",
    )
    parser.add_argument(
        "--ref-sam-prompt", type=str, default=None,
        help="Text prompt for SAM3 segmentation on reference image (e.g. 'coffee cup'). "
             "When provided, only the masked region of the reference is composited, "
             "avoiding background paste. Default: same as --sam-prompt.",
    )
    parser.add_argument(
        "--sam-threshold", type=float, default=0.3,
        help="SAM3 detection score threshold (default: 0.3)",
    )
    parser.add_argument(
        "--feather", type=int, default=10,
        help="Mask edge feathering radius in pixels (default: 10, 0 = hard edge)",
    )
    parser.add_argument(
        "--blend", action="store_true", default=False,
        help="Run Flux Klein I2I to blend the composite result",
    )
    parser.add_argument(
        "--blend-strength", type=float, default=0.4,
        help="I2I denoise strength for blending (default: 0.4)",
    )
    parser.add_argument(
        "--blend-prompt", type=str, default=None,
        help="Custom prompt for I2I blending (default: auto-generated)",
    )
    parser.add_argument(
        "--inpaint", action="store_true", default=False,
        help="Use masked inpainting instead of composite. SAM3 provides the mask, "
             "Flux Klein regenerates the masked region via I2I, then mask-blends "
             "to preserve the original outside the mask. Requires --inpaint-prompt.",
    )
    parser.add_argument(
        "--inpaint-prompt", type=str, default=None,
        help="Text prompt describing what should fill the masked region and its context. "
             "Required for --inpaint mode (e.g. 'cozy desk with a ceramic coffee cup').",
    )
    parser.add_argument(
        "--inpaint-strength", type=float, default=0.7,
        help="I2I denoise strength for inpainting (default: 0.7). "
             "Higher = more change in masked region.",
    )
    parser.add_argument(
        "--preserve-aspect-ratio", action="store_true", default=False,
        help="Don't stretch the reference to fill the mask box.  Maintain its "
             "original aspect ratio and center it.  Essential when swapping "
             "objects with very different shapes (e.g. tall bottle → wide cup).",
    )
    parser.add_argument(
        "--mask-dilate", type=int, default=0, metavar="N",
        help="Dilate the mask by N iterations before mask-blending.  Each "
             "iteration expands the mask by ~1px.  Use when swapping objects "
             "with very different shapes — gives the replacement room to "
             "extend beyond the original object's outline.  (default: 0)",
    )
    parser.add_argument(
        "--save-mask", action="store_true", default=False,
        help="Save the SAM3 mask and overlay as separate files",
    )


# ---------------------------------------------------------------------------
# Core swap logic
# ---------------------------------------------------------------------------

def _run_swap_core(source_path: str, reference_path: str | None, args) -> dict:
    """Core swap logic: SAM3 segment → composite/inpaint → optional blend.

    Two modes controlled by args:
      - **composite** (default): paste reference at mask → optional I2I blend
      - **inpaint** (--inpaint): run I2I with high denoise → mask-blend to keep
        original outside mask, regenerated content inside.  No paste artifacts.

    Args:
        source_path: Path to the source/target image.
        reference_path: Path to the reference image (None if --save-mask only).
        args: Parsed CLI arguments.

    Returns:
        Dict with output paths: {composite, mask, overlay, blend, inpaint, ...}.
    """
    from app.sam3_predictor import (
        get_sam3_predictor,
        segment_image,
        composite_images,
        feather_mask,
    )

    sam_prompt = getattr(args, "sam_prompt", None)
    threshold = getattr(args, "sam_threshold", 0.3)
    feather = getattr(args, "feather", 10)
    do_blend = getattr(args, "blend", False)
    blend_strength = getattr(args, "blend_strength", 0.4)
    do_inpaint = getattr(args, "inpaint", False)
    inpaint_strength = getattr(args, "inpaint_strength", 0.7)
    inpaint_prompt = getattr(args, "inpaint_prompt", None)
    save_mask = getattr(args, "save_mask", False)
    seed = getattr(args, "seed", 42)
    steps = getattr(args, "steps", None) or 4

    if not sam_prompt:
        print("ERROR: --sam-prompt is required for swap operations.", file=sys.stderr)
        sys.exit(1)

    # Load source image
    print(f"[swap] Source: {source_path}")
    source = Image.open(source_path).convert("RGB")
    W, H = source.size

    # Output paths
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()
    prompt_slug = sam_prompt.replace(" ", "_").replace("'", "")[:30]
    out = {
        "run": os.path.join(cfg.OUTPUT_DIR, f"{base}.run.json"),
        "manifest": os.path.join(cfg.OUTPUT_DIR, f"{base}.manifest.json"),
    }

    # Phase 1: SAM3 segmentation
    print(f"\n{'='*60}")
    print(f"[swap] Phase 1: SAM3 segmentation — '{sam_prompt}'")
    print(f"{'='*60}")

    predictor = get_sam3_predictor(threshold=threshold)
    result = segment_image(predictor, source, sam_prompt, score_threshold=threshold)

    if len(result.scores) == 0:
        print(f"[swap] No detections found for '{sam_prompt}'. Try lowering --sam-threshold.")
        # Still save empty mask if requested
        if save_mask:
            empty_mask = np.zeros((H, W), dtype=np.uint8)
            mask_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_mask.png")
            Image.fromarray(empty_mask).save(mask_path)
            out["mask"] = mask_path
            print(f"  Saved empty mask: {mask_path}")
        return out

    # Select best detection
    best_idx = int(np.argmax(result.scores))
    mask = result.masks[best_idx]
    score = float(result.scores[best_idx])
    box = result.boxes[best_idx]
    print(f"  Best: score={score:.3f} box=({box[0]:.0f},{box[1]:.0f},{box[2]:.0f},{box[3]:.0f})")

    # Save mask + overlay if requested
    if save_mask:
        mask_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_mask.png")
        Image.fromarray(mask * 255).save(mask_path)
        out["mask"] = mask_path
        print(f"  Saved mask: {mask_path}")

        # Overlay visualization
        overlay = np.array(source).copy()
        binary = mask > 0
        overlay[binary] = (overlay[binary] * 0.5 + np.array([255, 0, 0]) * 0.5).astype(np.uint8)
        overlay_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_overlay.png")
        Image.fromarray(overlay).save(overlay_path)
        out["overlay"] = overlay_path
        print(f"  Saved overlay: {overlay_path}")

    # Phase 2: Swap (composite or inpaint)
    if do_inpaint:
        # ── Inpaint mode: mask-out + I2I regeneration + mask blend ────────
        if not inpaint_prompt:
            print("ERROR: --inpaint-prompt is required for inpaint mode.",
                  file=sys.stderr)
            sys.exit(1)

        print(f"\n{'='*60}")
        print(f"[swap] Phase 2: Masked inpainting (strength={inpaint_strength})")
        print(f"{'='*60}")
        print(f"  Prompt: {inpaint_prompt[:80]}{'…' if len(inpaint_prompt) > 80 else ''}")

        # Pre-mask: fill the mask region with surrounding context color so
        # the model does NOT see the original object.  Use the median color
        # of pixels just outside the mask boundary for a natural fill.
        src_np = np.array(source)
        binary = mask > 0
        inv_binary = ~binary
        if inv_binary.any():
            # Sample colors from pixels just outside the mask (2px border)
            from scipy.ndimage import binary_dilation
            dilated = binary_dilation(binary, iterations=3)
            border = dilated & ~binary
            if border.any():
                border_colors = src_np[border].astype(np.float32)
                fill_color = np.median(border_colors, axis=0).astype(np.uint8)
            else:
                fill_color = np.median(src_np[inv_binary], axis=0).astype(np.uint8)
        else:
            fill_color = np.array([128, 128, 128], dtype=np.uint8)

        masked_source = src_np.copy()
        masked_source[binary] = fill_color
        masked_pil = Image.fromarray(masked_source)

        pre_mask_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_premask.png")
        masked_pil.save(pre_mask_path)
        out["premask"] = pre_mask_path
        print(f"  Pre-masked: filled {binary.sum()} px with rgb({fill_color[0]},{fill_color[1]},{fill_color[2]})")
        print(f"  Saved pre-mask: {pre_mask_path}")

        import mlx.core as mx
        from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline

        pipeline = Flux2KleinT2IPipeline(
            transformer_name=getattr(args, "transformer", "klein-9b"),
        )
        try:
            result_i2i = pipeline.generate(
                prompt=inpaint_prompt,
                input_image=masked_pil,
                denoise_strength=inpaint_strength,
                width=W,
                height=H,
                steps=steps,
                seed=seed,
            )
        finally:
            del pipeline
            mx.clear_cache()
            gc.collect()

        # Save raw I2I output as the final inpaint result
        # No mask-blending: the model already generated the full scene with the
        # replacement object.  Mask-blending fails when the object moves position.
        inpaint_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_inpaint.png")
        result_i2i.image.save(inpaint_path)
        out["inpaint"] = inpaint_path
        print(f"  Saved inpaint: {inpaint_path}")

    elif reference_path:
        # ── Composite mode: paste reference at mask ──────────────────────
        print(f"\n{'='*60}")
        print(f"[swap] Phase 2: Compositing reference image")
        print(f"{'='*60}")
        print(f"  Reference: {reference_path}")
        print(f"  Feather radius: {feather}px")

        reference = Image.open(reference_path).convert("RGB")

        # Optionally segment the reference to extract just the object
        ref_mask = None
        ref_sam_prompt = getattr(args, "ref_sam_prompt", None) or sam_prompt
        if ref_sam_prompt:
            print(f"  Segmenting reference: '{ref_sam_prompt}'")
            ref_result = segment_image(
                predictor, reference, ref_sam_prompt,
                score_threshold=threshold,
            )
            if len(ref_result.scores) > 0:
                ref_best = int(np.argmax(ref_result.scores))
                ref_mask = ref_result.masks[ref_best]
                ref_score = float(ref_result.scores[ref_best])
                print(f"  Reference mask: score={ref_score:.3f} "
                      f"(object extracted from background)")
            else:
                print(f"  No reference detection for '{ref_sam_prompt}' — "
                      f"using full reference image")

        preserve_ar = getattr(args, "preserve_aspect_ratio", False)

        composite = composite_images(
            source, reference, mask,
            feather_radius=feather,
            ref_mask=ref_mask,
            preserve_aspect_ratio=preserve_ar,
        )

        composite_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_composite.png")
        composite.save(composite_path)
        out["composite"] = composite_path
        print(f"  Saved composite: {composite_path}")

        # Phase 3: Optional I2I blend
        if do_blend:
            print(f"\n{'='*60}")
            print(f"[swap] Phase 3: Flux Klein I2I blend (strength={blend_strength})")
            print(f"{'='*60}")

            import mlx.core as mx

            from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline

            blend_prompt = getattr(args, "blend_prompt", None) or _BLEND_PROMPT
            pipeline = Flux2KleinT2IPipeline(
                transformer_name=getattr(args, "transformer", "klein-9b"),
            )

            try:
                result_i2i = pipeline.generate(
                    prompt=blend_prompt,
                    input_image=composite,
                    denoise_strength=blend_strength,
                    width=W,
                    height=H,
                    steps=steps,
                    seed=seed,
                )
                blend_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_blend.png")
                result_i2i.image.save(blend_path)
                out["blend"] = blend_path
                print(f"  Saved blend (raw I2I): {blend_path}")

                # Phase 3b: Mask-blend I2I result with original source.
                # Keep original source outside the mask, use I2I only inside.
                # This preserves the background scene exactly while allowing
                # natural object replacement within the mask.
                mask_dilate = getattr(args, "mask_dilate", 0)
                blend_mask = mask
                if mask_dilate > 0:
                    from scipy.ndimage import binary_dilation
                    blend_mask = binary_dilation(
                        mask > 0, iterations=mask_dilate,
                    ).astype(np.uint8)
                    print(f"  Mask dilated: {mask_dilate} iterations "
                          f"({mask.sum()} → {blend_mask.sum()} px)")

                src_np_orig = np.array(source)
                blend_np = np.array(result_i2i.image)
                alpha = feather_mask(blend_mask, feather)
                final = src_np_orig.astype(np.float32)
                blend_f = blend_np.astype(np.float32)
                for c in range(3):
                    final[:, :, c] = final[:, :, c] * (1.0 - alpha) + blend_f[:, :, c] * alpha
                final_pil = Image.fromarray(final.astype(np.uint8))

                final_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{prompt_slug}_final.png")
                final_pil.save(final_path)
                out["final"] = final_path
                print(f"  Saved final (mask-blended): {final_path}")
            finally:
                del pipeline
                mx.clear_cache()
                gc.collect()
    else:
        print(f"\n[swap] No reference image provided — mask-only mode.")

    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_swap(args):
    """Execute SAM3 swap. Called by image.py dispatcher.

    Two modes:
      * **Normal**: requires --input (source) and optionally --reference.
      * **Self-test** (--self-test): auto-generates source + reference images,
        runs the swap pipeline, and outputs results.
    """
    if getattr(args, "self_test", False):
        _run_test_mode(args)
        return

    # Normal mode
    source_path = getattr(args, "input", None)
    reference_path = getattr(args, "reference", None)
    sam_prompt = getattr(args, "sam_prompt", None)
    save_mask = getattr(args, "save_mask", False)

    if not source_path:
        print("ERROR: --input (source image) is required for swap.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(source_path):
        print(f"ERROR: source image not found: {source_path}", file=sys.stderr)
        sys.exit(1)

    # Reference is optional (mask-only mode with --save-mask)
    if not reference_path and not save_mask:
        print("ERROR: --reference (image to swap in) is required, "
              "or use --save-mask for mask-only mode.",
              file=sys.stderr)
        sys.exit(1)

    if reference_path and not os.path.exists(reference_path):
        print(f"ERROR: reference image not found: {reference_path}", file=sys.stderr)
        sys.exit(1)

    if not sam_prompt:
        print("ERROR: --sam-prompt is required (e.g. 'woman's face', 'outfit').",
              file=sys.stderr)
        sys.exit(1)

    out = _run_swap_core(source_path, reference_path, args)

    # Write run config
    run_meta = {
        "command": "image",
        "action": "swap",
        "input_image": source_path,
        "reference_image": reference_path,
        "sam_prompt": sam_prompt,
        "sam_threshold": getattr(args, "sam_threshold", 0.3),
        "feather": getattr(args, "feather", 10),
        "blend": getattr(args, "blend", False),
        "blend_strength": getattr(args, "blend_strength", 0.4),
        "seed": getattr(args, "seed", 42),
        "steps": getattr(args, "steps", 4),
    }
    run_file = out.get("run")
    if run_file:
        with open(run_file, "w") as f:
            json.dump(run_meta, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"\n  Run config: {run_file}")

    # Print summary
    print(f"\n[swap] Done.")
    for label, path in out.items():
        if path and os.path.exists(path):
            print(f"  {label}: {path}")


# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

def _generate_test_image(prompt: str, seed: int, label: str, base: str,
                         width: int = 640, height: int = 960,
                         write_manifest: bool = False):
    """Generate a test image using ZImagePipeline.

    Args:
        prompt: Text prompt for generation.
        seed:   RNG seed for reproducibility.
        label:  Human-readable label for log messages (e.g., "body").
        base:   Output filename prefix (without extension).
        width:  Image width (default: 640).
        height: Image height (default: 960).
        write_manifest: If True, also write .run.json + .manifest.json and
                        return (image_path, manifest_path) tuple.

    Returns:
        str image_path if write_manifest=False,
        tuple (image_path, manifest_path) if write_manifest=True.
    """
    import mlx.core as mx
    from app.pipeline import ZImagePipeline

    print(f"\n{'='*60}")
    print(f"[Test] Generating {label} image (seed={seed}, {width}x{height})")
    print(f"{'='*60}")

    pipeline = ZImagePipeline()
    result = pipeline.generate(
        prompt=prompt,
        width=width,
        height=height,
        steps=9,
        seed=seed,
    )

    img_path = os.path.join(cfg.OUTPUT_DIR, f"{base}.png")
    result.image.save(img_path)
    print(f"  Saved: {img_path}")

    manifest_file = None
    if write_manifest:
        run_file = os.path.join(cfg.OUTPUT_DIR, f"{base}.run.json")
        manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base}.manifest.json")

        # Write run config
        run_meta = {
            "command": "image",
            "action": "swap-test-source",
            "label": label,
            "prompt": prompt,
            "width": width,
            "height": height,
            "steps": 9,
            "seed": seed,
            "pipeline": "zimage",
            "model": "zimage-moody-v12.6-dpo",
        }
        with open(run_file, "w") as f:
            json.dump(run_meta, f, indent=2, ensure_ascii=False)
            f.write("\n")

        # Write manifest
        start = datetime.now(timezone.utc).isoformat()
        end = datetime.now(timezone.utc).isoformat()
        models = collect_model_fingerprint()
        manifest = Manifest.from_success(
            run_file, start, end, result.timings,
            [{
                "path": img_path,
                "seed": seed,
                "size_bytes": os.path.getsize(img_path),
                "width": result.image.width,
                "height": result.image.height,
            }],
            models,
        )
        manifest.to_json(manifest_file)

    # Unload to free memory
    del pipeline, result
    mx.clear_cache()
    gc.collect()

    if write_manifest:
        return img_path, manifest_file
    return img_path


def _run_test_mode(args):
    """Run the full swap test pipeline.

    Phase 1: ZImagePipeline → generate body image (Asian JK girl, seed=42)
    Phase 2: ZImagePipeline → generate reference image (European woman, seed=100)
    Phase 3: SAM3 segment face region from body image
    Phase 4: Composite reference onto body at masked region
    Phase 5: Save all outputs (mask, overlay, composite)
    """
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")

    print(f"\n{'#'*60}")
    print(f" SAM3 Swap Test Mode")
    print(f"{'#'*60}")

    # Phase 1: Generate body image
    body_path = _generate_test_image(
        prompt=_TEST_BODY_PROMPT,
        seed=42,
        label="body (source)",
        base=f"swap-test-{ts}_body",
    )

    # Phase 2: Generate reference image
    ref_path = _generate_test_image(
        prompt=_TEST_REF_PROMPT,
        seed=100,
        label="reference (face)",
        base=f"swap-test-{ts}_ref",
    )

    # Phase 3-5: Run swap with SAM3
    # Override args for test mode
    args.input = body_path
    args.reference = ref_path
    args.sam_prompt = "woman's face"
    args.save_mask = True
    args.feather = getattr(args, "feather", 15)
    args.blend = getattr(args, "blend", False)

    print(f"\n{'='*60}")
    print(f"[Test] Running swap pipeline")
    print(f"{'='*60}")

    out = _run_swap_core(body_path, ref_path, args)

    print(f"\n{'#'*60}")
    print(f" SAM3 Swap Test Complete")
    print(f"{'#'*60}")
    for label, path in out.items():
        if path and os.path.exists(path):
            print(f"  {label}: {path}")
