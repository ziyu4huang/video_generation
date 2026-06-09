"""Face Detailer — detect faces, crop, re-denoise at higher detail, composite back.

Lightweight alternative to ComfyUI Impact Pack's SEGS FaceDetailer.
Uses mediapipe for face detection (pure Python, no CUDA needed on Apple Silicon).

Workflow:
  1. Detect face bounding boxes via mediapipe
  2. Expand bounding boxes with padding
  3. Crop face region from the full image
  4. Re-encode the crop via VAE → latent
  5. Re-denoise with low strength (0.15–0.3) using the Z-Image pipeline
  6. Alpha-blend composite the detailed face back onto the original
"""

import math
import os
import time
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageFilter


@dataclass
class BoundingBox:
    """Axis-aligned bounding box in pixel coordinates."""
    x1: int
    y1: int
    x2: int
    y2: int


def _get_face_detector_model_path() -> str:
    """Resolve path to the mediapipe face detection TFLite model."""
    import os
    # Model stored in project models/ directory
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "..", "models", "face_detection", "blaze_face_short_range.tflite")


def detect_faces(image: Image.Image, min_confidence: float = 0.5) -> list[BoundingBox]:
    """Detect faces using mediapipe Tasks API.

    Args:
        image: PIL Image (RGB)
        min_confidence: Minimum detection confidence threshold

    Returns:
        List of BoundingBox objects (empty list if mediapipe unavailable)
    """
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions
    except ImportError:
        print("  [FaceDetailer] mediapipe not installed — skipping face detection")
        print("    Install with: pip install mediapipe")
        return []

    model_path = _get_face_detector_model_path()
    if not os.path.exists(model_path):
        print(f"  [FaceDetailer] Face detection model not found: {model_path}")
        print("    Download from: https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite")
        return []

    img_np = np.array(image)
    h, w = img_np.shape[:2]

    options = vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        min_detection_confidence=min_confidence,
    )
    detector = vision.FaceDetector.create_from_options(options)

    try:
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_np)
        result = detector.detect(mp_img)

        boxes = []
        for det in result.detections:
            bb = det.bounding_box
            x1 = max(0, bb.origin_x)
            y1 = max(0, bb.origin_y)
            x2 = min(w, bb.origin_x + bb.width)
            y2 = min(h, bb.origin_y + bb.height)
            if x2 > x1 and y2 > y1:
                boxes.append(BoundingBox(x1, y1, x2, y2))
    finally:
        detector.close()

    return boxes


def expand_bbox(box: BoundingBox, padding: float, img_w: int, img_h: int) -> BoundingBox:
    """Expand bounding box by padding factor, keeping it within image bounds.

    Args:
        box: Original bounding box
        padding: Expansion factor (1.5 = 50% larger on each side)
        img_w, img_h: Image dimensions for clamping
    """
    cx = (box.x1 + box.x2) / 2
    cy = (box.y1 + box.y2) / 2
    w = (box.x2 - box.x1) * padding
    h = (box.y2 - box.y1) * padding

    # Make dimensions even (required by VAE)
    w = int(w) & ~1
    h = int(h) & ~1

    x1 = max(0, int(cx - w / 2))
    y1 = max(0, int(cy - h / 2))
    x2 = min(img_w, int(cx + w / 2))
    y2 = min(img_h, int(cy + h / 2))

    return BoundingBox(x1, y1, x2, y2)


def create_feathered_mask(width: int, height: int, feather: int = 16) -> Image.Image:
    """Create a feathered (soft-edged) mask for alpha blending.

    The mask is white in the center and fades to black at the edges.
    """
    arr = np.ones((height, width), dtype=np.float32)

    # Feather each edge
    if feather > 0:
        for i in range(feather):
            alpha = (i + 1) / feather
            arr[i, :] = np.minimum(arr[i, :], alpha)          # top
            arr[-(i + 1), :] = np.minimum(arr[-(i + 1), :], alpha)  # bottom
            arr[:, i] = np.minimum(arr[:, i], alpha)          # left
            arr[:, -(i + 1)] = np.minimum(arr[:, -(i + 1)], alpha)  # right

    return Image.fromarray((arr * 255).round().astype("uint8"), mode="L")


def detail_faces(
    image: Image.Image,
    prompt: str,
    seed: int = 42,
    denoise_strength: float = 0.15,
    steps: int = 9,
    padding: float = 1.8,
    feather: int = 20,
    lora_path: str | None = None,
    lora_scale: float = 1.0,
    min_confidence: float = 0.5,
) -> tuple[Image.Image, dict]:
    """Detect and enhance face details in an image.

    For each detected face:
      1. Crop the face region with padding
      2. Re-denoise with low strength (adds detail without changing identity)
      3. Feathered alpha-blend composite back

    Args:
        image: Input PIL Image (RGB)
        prompt: Text prompt (describes the person/scene for better detail)
        seed: Random seed for reproducibility
        denoise_strength: How much to change (0.15 = subtle, 0.3 = noticeable)
        steps: Denoising steps for face re-generation
        padding: Bounding box expansion factor (1.5–2.0 typical)
        feather: Feather radius in pixels for alpha blending
        lora_path: Optional LoRA for face detail enhancement
        lora_scale: LoRA conditioning strength
        min_confidence: Minimum face detection confidence

    Returns:
        (enhanced_image, timings_dict)
    """
    timings = {"face_detailer_total": 0}
    total_start = time.time()

    # Detect faces
    t0 = time.time()
    faces = detect_faces(image, min_confidence=min_confidence)
    timings["face_detection_seconds"] = time.time() - t0

    if not faces:
        print("  [FaceDetailer] No faces detected — skipping")
        timings["face_detailer_total"] = time.time() - total_start
        return image, timings

    print(f"  [FaceDetailer] Found {len(faces)} face(s)")

    img_w, img_h = image.size
    result = image.copy()

    # Import pipeline lazily (heavy MLX loading)
    from app.pipeline import ZImagePipeline

    # Create or reuse pipeline
    pipeline = ZImagePipeline()

    for idx, face_box in enumerate(faces):
        print(f"  [FaceDetailer] Processing face {idx + 1}/{len(faces)}: "
              f"({face_box.x1},{face_box.y1})-({face_box.x2},{face_box.y2})")

        # Expand bounding box with padding
        expanded = expand_bbox(face_box, padding, img_w, img_h)
        print(f"    Expanded: ({expanded.x1},{expanded.y1})-({expanded.x2},{expanded.y2})")

        # Crop face region
        crop = image.crop((expanded.x1, expanded.y1, expanded.x2, expanded.y2))
        crop_w, crop_h = crop.size
        print(f"    Crop size: {crop_w}x{crop_h}")

        # Re-denoise the crop with low strength
        t_crop = time.time()
        try:
            crop_result = pipeline.generate(
                prompt=prompt,
                width=crop_w,
                height=crop_h,
                steps=steps,
                seed=seed,
                input_image=crop,
                denoise_strength=denoise_strength,
                lora_path=lora_path,
                lora_scale=lora_scale,
            )
            detailed_crop = crop_result.image
        except Exception as e:
            print(f"    Face detail generation failed: {e} — skipping")
            continue
        timings[f"face_{idx}_denoise_seconds"] = time.time() - t_crop

        # Resize if dimensions changed during generation
        if detailed_crop.size != (crop_w, crop_h):
            detailed_crop = detailed_crop.resize((crop_w, crop_h), Image.LANCZOS)

        # Feathered alpha-blend composite
        mask = create_feathered_mask(crop_w, crop_h, feather=feather)
        result.paste(detailed_crop, (expanded.x1, expanded.y1), mask)

    # Cleanup
    import gc
    import mlx.core as mx
    del pipeline
    mx.clear_cache()
    gc.collect()

    timings["face_detailer_total"] = time.time() - total_start
    return result, timings
