"""image-faceswap — BFS (Best Face Swap) via Flux2 Klein 9B + BFS LoRA.

Source: https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap

Technique
  BFS works by loading Flux2 Klein 9B with a dedicated swap LoRA applied at
  init time, then passing two reference images (body + face) to Flux2KleinEdit
  with a specific swap prompt.  The model sees both images and generates a new
  image that combines the body/pose from Image 1 with the face from Image 2.

  LoRA is applied at model init (not generate time) because Klein's distilled
  architecture fuses LoRA weights into the transformer during loading.  The BFS
  LoRA was trained at rank-64 on Flux Klein 9B and modifies 144 attention layers.

Memory management (--self-test mode)
  The self-test mode runs three sequential phases, each loading a different model:
    Phase 1: ZImagePipeline (~8 GB)  → body image  → unload + mx.clear_cache()
    Phase 2: Flux2KleinT2IPipeline (~17 GB) → face image → unload + mx.clear_cache()
    Phase 3: Flux2KleinPipeline + BFS LoRA (~17 GB) → faceswap result
  Total peak memory ~17 GB (never exceeds single large model + overhead).

Dimension matching
  Source images are 640×960 (2:3 portrait).  The faceswap output defaults to
  1024×1536 (same 2:3 ratio) to avoid stretching — mflux resizes reference
  images to match output dimensions, so mismatched ratios cause distortion
  (e.g., 640×960 source → 1024×1024 output makes the subject look "胖").

Modes
  face  — swap face only, keep original hairstyle and skin tone (default)
  head  — swap full head including hair, keep body lighting/skin

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

# ---------------------------------------------------------------------------
# Swap prompts — instruct the model what to combine from each reference image
# ---------------------------------------------------------------------------
# Image 1 = body (target), Image 2 = face (source to swap in).
# "face" mode preserves hairstyle and skin color of the body image,
# "head" mode swaps the full head including hair.

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

# ---------------------------------------------------------------------------
# Test prompts for --test mode
# ---------------------------------------------------------------------------
# Body prompt uses ZImage pipeline (photorealistic Moody style).
# Face prompt uses Flux2 Klein T2I (different style/pipeline for diversity).
# Deliberately different ethnicity to make swap quality clearly visible.

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


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

def add_faceswap_args(parser):
    """Register faceswap-specific arguments on an argparse parser.

    Note: ``--lora-scale`` is already registered by
    ``add_common_generation_args()`` in ``_shared.py``, so it is not
    duplicated here.
    """
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
    # --self-test is registered in _shared.py (shared by controlnet, faceswap, quality)


# ---------------------------------------------------------------------------
# Source image generators (test mode only)
# ---------------------------------------------------------------------------

def _generate_body_zimage(prompt: str, seed: int, label: str, base: str):
    """Generate body source image using ZImagePipeline (Moody V12.6 DPO).

    Uses 640×960 portrait (2:3 ratio) at 9 denoising steps.
    After generation, the pipeline is fully unloaded to free ~8 GB VRAM
    for the next phase.

    Args:
        prompt: Text prompt for generation.
        seed:   RNG seed for reproducibility.
        label:  Human-readable label for log messages (e.g., "body").
        base:   Output filename prefix (without extension).

    Returns:
        Tuple of (image_path, manifest_path).
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

    Uses 640×960 portrait (2:3 ratio) at 4 denoising steps (distilled Klein).
    After generation, the pipeline is fully unloaded to free ~17 GB VRAM
    for the faceswap pipeline in the next phase.

    Using Flux2 T2I (instead of ZImage) for the face source provides
    stylistic diversity — Flux2 has a different rendering aesthetic than
    ZImage, making the swap more challenging and the result easier to judge.

    Args:
        prompt: Text prompt for generation.
        seed:   RNG seed for reproducibility.
        label:  Human-readable label for log messages (e.g., "face").
        base:   Output filename prefix (without extension).

    Returns:
        Tuple of (image_path, manifest_path).
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


# ---------------------------------------------------------------------------
# Optional VLM scoring (test mode)
# ---------------------------------------------------------------------------

def _score_with_vlm(image_path: str, label: str) -> dict | None:
    """Score an image using VLM (Qwen3-VL) via local API, if available.

    Sends the image to the local OpenAI-compatible VLM server at
    ``localhost:1234`` and requests quality scoring on 6 dimensions
    (overall, detail, sharpness, composition, prompt_adherence, artifacts).

    If the VLM server is not running, returns None silently.

    Reuses ``_image_to_base64()`` and ``_call_vlm()`` from
    ``app.commands.caption``.

    Args:
        image_path: Path to the image file.
        label:      Human-readable label for log messages.

    Returns:
        Parsed score dict (e.g., ``{"overall": 8, "detail": 7, ...}``)
        or None if the VLM server is unavailable.
    """
    import importlib
    import re

    import requests as http_requests

    # Check if VLM server is reachable (quick HEAD request, 2s timeout)
    try:
        http_requests.head("http://localhost:1234/v1/models", timeout=2)
    except Exception:
        return None

    # Lazy-import caption helpers (avoids import at module level)
    _caption_mod = importlib.import_module("app.commands.caption")
    _image_to_base64 = _caption_mod._image_to_base64
    _call_vlm = _caption_mod._call_vlm
    _score_prompt = _caption_mod._STYLE_PROMPTS["score"]

    print(f"[VLM] Scoring {label}...", end=" ", flush=True)
    try:
        b64 = _image_to_base64(image_path)
        raw = _call_vlm("http://localhost:1234/v1", "qwen/qwen3-vl-4b",
                        b64, _score_prompt)
        # Strip Qwen3 <think/> blocks if present
        raw = re.sub(r"<think.*?</think\s*>", "", raw, flags=re.DOTALL).strip()
        scores = json.loads(raw)
        print(f"overall={scores.get('overall', '?')}")
        return scores
    except Exception as exc:
        print(f"failed ({exc})")
        return None


# ---------------------------------------------------------------------------
# Core faceswap logic
# ---------------------------------------------------------------------------

def _run_faceswap_core(body_path, face_path, args):
    """Core faceswap logic shared between normal and test modes.

    Loads Flux2KleinPipeline with BFS LoRA applied, then generates the
    swap result using both reference images.

    Output dimensions default to 1024×1536 (2:3 portrait) to match the
    typical source image aspect ratio.  mflux resizes reference images
    to match output dimensions, so mismatched ratios cause distortion.

    Args:
        body_path: Path to the target body image (Image 1).
        face_path: Path to the source face image (Image 2).
        args:      Parsed CLI arguments (seed, steps, width, height, etc.).

    Returns:
        Tuple of (output_path, manifest_path).
    """
    from app.flux2_pipeline import Flux2KleinPipeline

    mode = getattr(args, "mode", "face")
    seed = getattr(args, "seed", 42)
    steps = getattr(args, "steps", None) or 4
    width = getattr(args, "width", None) or 1024
    height = getattr(args, "height", None) or 1536  # 2:3 portrait to match source
    prompt = _SWAP_PROMPTS[mode]

    # Resolve LoRA path from short name or absolute path
    lora_name = getattr(args, "lora", _DEFAULT_LORA)
    lora_path = resolve_lora_path(lora_name)
    lora_scale = getattr(args, "lora_scale", None) or 1.0

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

    # Load pipeline with BFS LoRA fused into the transformer at init time.
    # Klein's distilled architecture requires LoRA during loading — it cannot
    # be applied post-hoc at generate time.
    transformer_name = getattr(args, "transformer", "klein-9b")
    pipeline = Flux2KleinPipeline(
        model_path=getattr(args, "flux2_model_path", None),
        quantize=getattr(args, "quantize", None),
        variant=getattr(args, "variant", "9b"),
        transformer_name=transformer_name,
        lora_paths=[lora_path],
        lora_scales=[lora_scale],
    )

    # Generate swap result
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


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_faceswap(args):
    """Execute BFS face/head swap.  Called by ``image.py`` dispatcher.

    Two modes:
      * **Normal**: requires ``--input`` (body) and ``--face`` (source).
      * **Self-test** (``--self-test``): auto-generates both source images using
        different pipelines (ZImage for body, Flux2 T2I for face), runs
        the faceswap, optionally scores results with VLM, then opens an
        interactive HTML review page.
    """
    # ── Self-test mode: auto-generate sources + review HTML ────────────────
    if getattr(args, "self_test", False):
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
    """Run the full faceswap test pipeline and open an HTML review.

    Phase 1: ZImagePipeline → generate body image (Asian JK girl, seed=42)
    Phase 2: Flux2KleinT2IPipeline → generate face image (European woman, seed=100)
    Phase 3: Flux2KleinPipeline + BFS LoRA → faceswap result
    Phase 4: Optional VLM quality scoring on all 3 images
    Phase 5: Open interactive HTML review with labeled cards

    Memory is managed by fully unloading each pipeline before loading the
    next one.  Peak usage never exceeds ~17 GB (single large model).
    """
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

    # Phase 3: Run faceswap (loads Flux2 Klein Edit + BFS LoRA)
    print(f"\n{'='*60}")
    print(f"[Test] Running faceswap")
    print(f"{'='*60}")

    result_path, result_manifest = _run_faceswap_core(body_path, face_path, args)

    # Phase 4: Optional VLM quality scoring (only if LM Studio is running)
    print(f"\n{'='*60}")
    print(f"[Test] VLM quality scoring (optional)")
    print(f"{'='*60}")

    images_to_score = [
        (body_path, "body"),
        (face_path, "face"),
        (result_path, "result"),
    ]
    scores = {}
    for img_path, lbl in images_to_score:
        score = _score_with_vlm(img_path, lbl)
        if score:
            scores[lbl] = score

    if scores:
        print(f"[VLM] Scored {len(scores)}/3 images")
    else:
        print("[VLM] Server not available — start LM Studio with Qwen3-VL to enable scoring")

    # Phase 5: Open review HTML with all 3 results
    print(f"\n{'='*60}")
    print(f"[Test] Generating review HTML")
    print(f"{'='*60}")

    manifest_files = [body_manifest, face_manifest, result_manifest]

    # Include scores in labels when available
    labels = []
    for lbl, name in [("1-Body (ZImage)", "body"),
                      ("2-Face (Flux2 T2I)", "face"),
                      ("3-FaceSwap Result", "result")]:
        if name in scores:
            s = scores[name]
            labels.append(f"{lbl} — score {s.get('overall', '?')}/10")
        else:
            labels.append(lbl)

    _open_manifest_review(manifest_files, labels=labels)
