"""sam3_predictor — singleton wrapper for mlx-vlm Sam3Predictor.

Loads the SAM 3.1 model (mlx-community/sam3.1-bf16) once and caches it.
All subsequent calls reuse the loaded model, avoiding the ~4s reload cost.

Usage:
    from app.sam3_predictor import get_sam3_predictor, segment_image

    predictor = get_sam3_predictor(threshold=0.3)
    result = segment_image(predictor, image, text_prompt="woman's face")
"""

import time
from typing import Optional, Union

import numpy as np
from PIL import Image

# Module-level singleton
_predictor = None
_model_id = "mlx-community/sam3.1-bf16"


def get_sam3_predictor(threshold: float = 0.3):
    """Get or create the SAM3 predictor singleton.

    Args:
        threshold: Default score threshold for detection filtering.

    Returns:
        Sam3Predictor instance (cached across calls).
    """
    global _predictor
    if _predictor is None:
        from mlx_vlm.models.sam3.generate import Sam3Predictor
        from mlx_vlm.models.sam3_1.processing_sam3_1 import Sam31Processor
        from mlx_vlm.utils import get_model_path, load_model

        print(f"[sam3] Loading model: {_model_id}")
        t0 = time.perf_counter()
        mp = get_model_path(_model_id)
        model = load_model(mp)
        processor = Sam31Processor.from_pretrained(str(mp))
        _predictor = Sam3Predictor(model, processor, score_threshold=threshold)
        t_load = time.perf_counter() - t0
        print(f"[sam3] Model loaded in {t_load:.1f}s")
    return _predictor


def segment_image(
    predictor,
    image: Union[Image.Image, np.ndarray],
    text_prompt: str,
    score_threshold: Optional[float] = None,
):
    """Run text-prompted segmentation on a single image.

    Args:
        predictor: Sam3Predictor instance from get_sam3_predictor().
        image: PIL Image or numpy array (H, W, 3).
        text_prompt: Natural language description of objects to segment.
        score_threshold: Override predictor's default threshold.

    Returns:
        DetectionResult with boxes (N,4), masks (N,H,W), scores (N,).
        result.scores may be empty if no detections above threshold.
    """
    t0 = time.perf_counter()
    result = predictor.predict(
        image,
        text_prompt=text_prompt,
        score_threshold=score_threshold,
    )
    t_seg = time.perf_counter() - t0
    n = len(result.scores)
    print(f"[sam3] Segmented '{text_prompt}': {n} detections in {t_seg:.2f}s")
    return result


def feather_mask(mask: np.ndarray, radius: int = 10) -> np.ndarray:
    """Apply Gaussian feathering to mask edges.

    Creates a soft transition at mask boundaries for smoother compositing.

    Args:
        mask: Binary mask (H, W) with values 0 or 1 (uint8).
        radius: Feathering radius in pixels.

    Returns:
        Float mask (H, W) with values in [0, 1].
    """
    if radius <= 0:
        return mask.astype(np.float32)

    from PIL import ImageFilter

    # Convert to PIL for Gaussian blur
    mask_pil = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    blurred = mask_pil.filter(ImageFilter.GaussianBlur(radius=radius))
    return np.array(blurred).astype(np.float32) / 255.0


def _crop_masked_object(
    image: Image.Image,
    mask: np.ndarray,
    padding: float = 0.1,
) -> tuple:
    """Crop image to the bounding box of a mask, with optional padding.

    Args:
        image: PIL Image to crop.
        mask: Binary mask (H, W) uint8 — nonzero region defines the crop area.
        padding: Fraction of box size to add as padding (0.1 = 10%).

    Returns:
        (cropped_image, (x_min, y_min)) — the cropped PIL Image and the
        top-left offset of the crop within the original image.
    """
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any():
        return image, (0, 0)

    H, W = mask.shape
    y_min, y_max = np.where(rows)[0][[0, -1]]
    x_min, x_max = np.where(cols)[0][[0, -1]]
    box_w = x_max - x_min + 1
    box_h = y_max - y_min + 1

    # Add padding
    pad_x = int(box_w * padding)
    pad_y = int(box_h * padding)
    x_min = max(0, x_min - pad_x)
    y_min = max(0, y_min - pad_y)
    x_max = min(W - 1, x_max + pad_x)
    y_max = min(H - 1, y_max + pad_y)

    cropped = image.crop((x_min, y_min, x_max + 1, y_max + 1))
    return cropped, (x_min, y_min)


def composite_images(
    source: Image.Image,
    reference: Image.Image,
    mask: np.ndarray,
    feather_radius: int = 10,
    ref_mask: Optional[np.ndarray] = None,
    preserve_aspect_ratio: bool = False,
) -> Image.Image:
    """Composite reference content onto source using a feathered mask.

    When ``ref_mask`` is provided, only the masked portion of the reference
    image is used — the reference object is cropped to its mask bounding box,
    resized to fill the source mask region, and alpha-blended.  This avoids
    pasting the reference's background into the source.

    When ``ref_mask`` is None, the entire reference image is resized to the
    source mask bounding box (legacy behaviour).

    When ``preserve_aspect_ratio`` is True, the reference object is resized to
    FIT WITHIN the mask bounding box without stretching — the original aspect
    ratio is maintained, and the object is centered in the mask region.  The
    effective blend mask is the intersection of the original mask and the
    reference placement rectangle.  This prevents shape distortion when
    swapping objects with very different proportions (e.g. tall bottle →
    wide coffee cup).

    Args:
        source: Background PIL Image (the target to modify).
        reference: Foreground PIL Image (the content to paste in).
        mask: Binary mask (H, W) uint8 — 1 where reference should appear.
        feather_radius: Edge feathering in pixels (0 = hard edge).
        ref_mask: Optional binary mask (H_ref, W_ref) uint8 — 1 where the
                  reference object is located.  When provided, only the masked
                  region of the reference is composited.
        preserve_aspect_ratio: When True, don't stretch the reference to fill
                  the mask box — maintain its aspect ratio and center it.

    Returns:
        Composite PIL Image (same size as source).
    """
    src_np = np.array(source.convert("RGB"))
    W, H = source.size

    # Ensure mask matches source dimensions
    if mask.shape != (H, W):
        mask_pil = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
        mask_pil = mask_pil.resize((W, H), Image.NEAREST)
        mask = np.array(mask_pil).astype(np.uint8)
        mask = (mask > 127).astype(np.uint8)

    # Find mask bounding box (where the object should be placed)
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any():
        return source
    y_min, y_max = np.where(rows)[0][[0, -1]]
    x_min, x_max = np.where(cols)[0][[0, -1]]
    box_w = x_max - x_min + 1
    box_h = y_max - y_min + 1

    # Prepare reference content to paste
    ref_img = reference.convert("RGB")

    if ref_mask is not None and ref_mask.any():
        ref_cropped, _ = _crop_masked_object(ref_img, ref_mask, padding=0.15)
    else:
        ref_cropped = ref_img

    if preserve_aspect_ratio:
        # ── Aspect-ratio-preserving composite ──────────────────────────
        # Fit the reference WITHIN the mask box, center it, and blend only
        # where the reference is actually placed.  This avoids stretching
        # when source and reference objects have very different proportions.
        ref_w, ref_h = ref_cropped.size
        if ref_w <= 0 or ref_h <= 0:
            return source
        scale = min(box_w / ref_w, box_h / ref_h)
        new_w = int(ref_w * scale)
        new_h = int(ref_h * scale)
        ref_resized = ref_cropped.resize((new_w, new_h), Image.LANCZOS)

        # Center within the mask bounding box
        x_off = (box_w - new_w) // 2
        y_off = (box_h - new_h) // 2
        paste_x = x_min + x_off
        paste_y = y_min + y_off

        # Build a canvas with source pixels, paste reference on top
        ref_canvas = src_np.copy()
        ref_canvas[paste_y:paste_y + new_h, paste_x:paste_x + new_w] = \
            np.array(ref_resized)

        # Effective mask: original mask intersected with placement rectangle
        placement = np.zeros((H, W), dtype=np.uint8)
        placement[paste_y:paste_y + new_h, paste_x:paste_x + new_w] = 1
        effective_mask = mask & placement

        # Apply feathering to effective mask boundary
        alpha = feather_mask(effective_mask, feather_radius)

        # Alpha blend
        result = src_np.astype(np.float32)
        ref_f = ref_canvas.astype(np.float32)
        for c in range(3):
            result[:, :, c] = result[:, :, c] * (1.0 - alpha) + ref_f[:, :, c] * alpha

        return Image.fromarray(result.astype(np.uint8))
    else:
        # ── Legacy: stretch reference to fill mask box ─────────────────
        ref_resized = ref_cropped.resize((box_w, box_h), Image.LANCZOS)

        # Place resized reference at mask location on a full-size canvas
        ref_np = np.full((H, W, 3), 0, dtype=np.uint8)
        ref_np[y_min:y_min + box_h, x_min:x_min + box_w] = np.array(ref_resized)

        # Apply feathering
        alpha = feather_mask(mask, feather_radius)

        # Alpha blend: result = source * (1 - alpha) + reference * alpha
        result = src_np.astype(np.float32)
        ref_f = ref_np.astype(np.float32)
        for c in range(3):
            result[:, :, c] = result[:, :, c] * (1.0 - alpha) + ref_f[:, :, c] * alpha

        return Image.fromarray(result.astype(np.uint8))
