"""image-faceswap — BFS face/head swap sub-action for 'run.py image faceswap'.

Uses Flux2 Klein 9B + BFS (Best Face Swap) LoRA with multi-image reference
conditioning to swap faces or heads between two input images.

The technique works by loading Klein 9B with the BFS LoRA applied, then
passing both images (body + face) as reference images to Flux2KleinEdit
with a specific swap prompt.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_faceswap_args(parser)  — register faceswap-specific CLI arguments
  run_faceswap(args)         — execute face swap generation
"""

import gc
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import resolve_lora_path, generate_base_name
from app.manifest import (
    Manifest,
    collect_model_fingerprint,
    collect_model_fingerprint_flux2,
)

# Default BFS LoRA short name (resolves via models/lora/)
_DEFAULT_LORA = "bfs-head-v1-klein-9b"

# Prompts tuned from existing flux2-klein-face-head-swap workflow docs
_FACE_SWAP_PROMPT = (
    "Referring to Images 1 and 2, replace the person's face in Image 1 "
    "with the face from Image 2, while keeping the natural hairstyle, "
    "natural lighting, and face skin color of the person in Image 1."
)
_HEAD_SWAP_PROMPT = (
    "Referring to Images 1 and 2, replace the person's face in Image 1 "
    "with the face from Image 2, while keeping the natural hairstyle of "
    "Image 1, natural lighting, and face skin color consistency."
)

_SWAP_PROMPTS = {
    "face": _FACE_SWAP_PROMPT,
    "head": _HEAD_SWAP_PROMPT,
}

# Test prompts for --test mode (ZImage-generated source images)
_TEST_BODY_PROMPT = (
    "Moody Photography, 18-year-old Japanese girl in school uniform, "
    "navy blue sailor top, white collar with red ribbon, plaid skirt, "
    "kneeling at desk, warm lamp light from left, cool moonlight from window, "
    "half-body shot from above, looking at camera with pensive expression, "
    "hands resting on desk, textbooks and ramune bottle on desk."
)
_TEST_FACE_PROMPT = (
    "Moody Photography, close-up portrait of a 22-year-old European woman, "
    "shoulder-length wavy blonde hair, blue eyes, light freckles across nose, "
    "confident direct gaze, warm golden hour side lighting, "
    "shallow depth of field, film grain texture, neutral background."
)


def add_faceswap_args(parser):
    """Register faceswap-specific arguments on an argparse parser."""
    parser.add_argument(
        "--face", type=str, default=None, metavar="IMAGE",
        help="Source face image path (the face to swap IN). Required.",
    )
    parser.add_argument(
        "--mode", choices=["face", "head"], default="face",
        help="Swap mode: 'face' (keep target hair) or 'head' (swap full head). (default: face)",
    )
    parser.add_argument(
        "--lora", type=str, default=_DEFAULT_LORA, metavar="NAME",
        help=f"BFS LoRA name or path (default: {_DEFAULT_LORA})",
    )
    parser.add_argument(
        "--test", action="store_true", default=False,
        help="Auto-generate body + face source images using ZImage, run faceswap, open review HTML",
    )
    # --lora-scale is already registered by add_common_generation_args()


def _generate_body_zimage(prompt: str, seed: int, label: str, base: str):
    """Generate body source image using ZImagePipeline.

    Returns (image_path, manifest_path).
    """
    import mlx.core as mx
    from app.pipeline import ZImagePipeline

    print(f"\n{'='*60}")
    print(f"[Test] Generating {label} image via ZImage (seed={seed})")
    print(f"{'='*60}")

    pipeline = ZImagePipeline()
    result = pipeline.generate(
        prompt=prompt,
        width=640,
        height=960,
        steps=9,
        seed=seed,
    )

    img_path = os.path.join(cfg.OUTPUT_DIR, f"{base}.png")
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base}.manifest.json")

    result.image.save(img_path)
    print(f"Saved: {img_path}")

    # Write run config
    run_meta = {
        "command": "image",
        "action": "faceswap-test-source",
        "label": label,
        "prompt": prompt,
        "width": 640,
        "height": 960,
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

    # Unload ZImage to free ~8 GB for next pipeline
    del pipeline, result
    mx.clear_cache()
    gc.collect()

    return img_path, manifest_file


def _generate_face_flux2(prompt: str, seed: int, label: str, base: str):
    """Generate face source image using Flux2KleinT2IPipeline.

    Returns (image_path, manifest_path).
    """
    import mlx.core as mx
    from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline

    print(f"\n{'='*60}")
    print(f"[Test] Generating {label} image via Flux2 T2I (seed={seed})")
    print(f"{'='*60}")

    pipeline = Flux2KleinT2IPipeline()
    result = pipeline.generate(
        prompt=prompt,
        width=640,
        height=960,
        steps=4,
        seed=seed,
    )

    img_path = os.path.join(cfg.OUTPUT_DIR, f"{base}.png")
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base}.manifest.json")

    result.image.save(img_path)
    print(f"Saved: {img_path}")

    # Write run config
    run_meta = {
        "command": "image",
        "action": "faceswap-test-source",
        "label": label,
        "prompt": prompt,
        "width": 640,
        "height": 960,
        "steps": 4,
        "seed": seed,
        "pipeline": "flux2-klein-t2i",
        "transformer": "klein-9b",
    }
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Write manifest (uses Flux2 fingerprint)
    start = datetime.now(timezone.utc).isoformat()
    end = datetime.now(timezone.utc).isoformat()
    models = collect_model_fingerprint_flux2()
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

    # Unload Flux2 T2I to free ~17 GB for faceswap pipeline
    del pipeline, result
    mx.clear_cache()
    gc.collect()

    return img_path, manifest_file


def _run_faceswap_core(body_path, face_path, args):
    """Core faceswap logic shared between normal and test modes.

    Returns (output_path, manifest_path).
    """
    from app.flux2_pipeline import Flux2KleinPipeline

    mode = getattr(args, "mode", "face")
    seed = getattr(args, "seed", 42)
    steps = getattr(args, "steps", None) or 4
    width = getattr(args, "width", None) or 1024
    height = getattr(args, "height", None) or 1536  # 2:3 portrait to match source
    prompt = _SWAP_PROMPTS[mode]

    # Resolve LoRA
    lora_name = getattr(args, "lora", _DEFAULT_LORA)
    lora_path = resolve_lora_path(lora_name)
    lora_scale = getattr(args, "lora_scale", 1.0)

    print(f"[FaceSwap] Mode: {mode}")
    print(f"[FaceSwap] Body: {body_path}")
    print(f"[FaceSwap] Face: {face_path}")
    print(f"[FaceSwap] LoRA: {os.path.basename(lora_path)} (scale={lora_scale})")
    print(f"[FaceSwap] Steps: {steps}, Seed: {seed}, Size: {width}x{height}")

    # Output paths
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.png")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")

    run_meta = {
        "command": "image",
        "action": "faceswap",
        "mode": mode,
        "input_image": body_path,
        "face_image": face_path,
        "prompt": prompt,
        "lora_path": lora_path,
        "lora_scale": lora_scale,
        "transformer": getattr(args, "transformer", "klein-9b"),
        "steps": steps,
        "seed": seed,
        "width": width,
        "height": height,
    }
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Load pipeline with LoRA
    transformer_name = getattr(args, "transformer", "klein-9b")
    pipeline = Flux2KleinPipeline(
        model_path=getattr(args, "flux2_model_path", None),
        quantize=getattr(args, "quantize", None),
        variant=getattr(args, "variant", "9b"),
        transformer_name=transformer_name,
        lora_paths=[lora_path],
        lora_scales=[lora_scale],
    )

    # Generate
    start_time = datetime.now(timezone.utc).isoformat()
    last_timings = {}

    try:
        result = pipeline.generate(
            seed=seed,
            prompt=prompt,
            reference_images=[body_path, face_path],
            width=width,
            height=height,
            steps=steps,
        )

        result.image.save(out_path)
        print(f"Saved: {out_path}")

        end_time = datetime.now(timezone.utc).isoformat()

        output_files = [{
            "path": out_path,
            "seed": seed,
            "size_bytes": os.path.getsize(out_path),
            "width": result.image.width,
            "height": result.image.height,
        }]

        models = collect_model_fingerprint_flux2(lora_path=lora_path)
        manifest = Manifest.from_success(
            run_file, start_time, end_time,
            last_timings, output_files, models,
        )
        manifest.to_json(manifest_file)
        print(f"Run config: {run_file}")
        print(f"Manifest:   {manifest_file}")

        return out_path, manifest_file

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(
            run_file, start_time, end_time,
            last_timings, exc, {},
        )
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


def run_faceswap(args):
    """Execute BFS face/head swap. Called by image.py dispatcher."""
    # ── Test mode: auto-generate sources + review HTML ─────────────────────
    if getattr(args, "test", False):
        _run_test_mode(args)
        return

    # ── Normal mode: require explicit images ───────────────────────────────
    body_path = getattr(args, "input", None)
    face_path = getattr(args, "face", None)

    if not body_path:
        print("ERROR: --input (target body image) is required for faceswap.",
              file=sys.stderr)
        sys.exit(1)
    if not face_path:
        print("ERROR: --face (source face image) is required for faceswap.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(body_path):
        print(f"ERROR: body image not found: {body_path}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(face_path):
        print(f"ERROR: face image not found: {face_path}", file=sys.stderr)
        sys.exit(1)

    _run_faceswap_core(body_path, face_path, args)


def _run_test_mode(args):
    """Generate test source images with ZImage, run faceswap, open review HTML."""
    import importlib
    _review_mod = importlib.import_module("app.commands.image-review")
    _open_manifest_review = _review_mod._open_manifest_review

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")

    print(f"\n{'#'*60}")
    print(f" FaceSwap Test Mode")
    print(f"{'#'*60}")

    # Phase 1: Generate body image (ZImage — Asian JK girl)
    body_path, body_manifest = _generate_body_zimage(
        prompt=_TEST_BODY_PROMPT,
        seed=42,
        label="body",
        base=f"fs-test-{ts}_body",
    )

    # Phase 2: Generate face image (Flux2 T2I — European woman)
    face_path, face_manifest = _generate_face_flux2(
        prompt=_TEST_FACE_PROMPT,
        seed=100,
        label="face",
        base=f"fs-test-{ts}_face",
    )

    # Phase 3: Run faceswap
    print(f"\n{'='*60}")
    print(f"[Test] Running faceswap")
    print(f"{'='*60}")

    result_path, result_manifest = _run_faceswap_core(body_path, face_path, args)

    # Phase 4: Open review HTML with all 3 results
    print(f"\n{'='*60}")
    print(f"[Test] Generating review HTML")
    print(f"{'='*60}")

    manifest_files = [body_manifest, face_manifest, result_manifest]
    labels = ["1-Body (ZImage)", "2-Face (Flux2 T2I)", "3-FaceSwap Result"]

    _open_manifest_review(manifest_files, labels=labels)
