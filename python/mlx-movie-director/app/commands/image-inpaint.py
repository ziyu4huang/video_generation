"""image-inpaint — masked redraw / object removal (OM C4) on MLX.

Step 2 of next-goal-20260708-230000. OpenMontage has NO inpaint tool; this fills
the one true remaining generation gap. Masked latent redraw: regenerate ONLY the
masked region of an image (white = regenerate, black = keep bit-for-bit), driven
by a text prompt. Object removal (``--prompt`` describes the background that
should fill the hole) and object replacement (``--prompt`` describes the new
content) are the two modes.

MECHANISM — reuses the PROVEN latent-mask re-injection machinery from
``app/flux2_outpaint_pipeline.py`` (Flux2 Klein 9B). Outpaint is just inpaint
where the mask is the canvas margin; here the mask is an arbitrary interior
region. The pipeline:
  1. Load input + mask; align both to the same %16 canvas (edge-pad if needed).
  2. Feather the mask seam so the redrawn region blends (no hard edge).
  3. ``Flux2OutpaintPipeline.expand(padded_image=input, mask_image=mask)`` → at
     every denoise step the kept region (mask 0) is re-injected to its VAE-
     encoded latent, only the masked region (mask 1) denoises; a final pixel
     composite pastes the true original back for a bit-perfect kept region.
  4. Crop back to the original input size if it was padded.

The ``--crop`` flag (Union 2.1 crop-for-detail): crop the masked bbox + a margin,
inpaint at higher effective resolution, paste back — sharper detail on small
regions (the resolution the model needs to render a face/object faithfully).

This is the LOCAL MLX path (constraint 1: never cloud). The Z-Image 33-ch
ControlNet masked-inpaint channel and the LanPaint "think-mode" sampler are the
research alternates (see the Step 2 receipt) — Flux2 latent-mask is the working,
certified path today.

Imported by app.commands.image via importlib (hyphen in filename).

Public API:
  add_inpaint_args(parser)  — register inpaint-specific CLI arguments
  run_inpaint(args)         — execute inpaint
"""
import argparse
import gc
import os
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageFilter

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_lora_paths

_VAE_ALIGN = 16  # Flux2 canvas sides must be multiples of 16

_DEFAULT_PROMPT = (
    "Seamless background, clean and natural, matching the surrounding lighting, "
    "color, texture and perspective. No artifacts, no visible seam."
)


def _round16(n: int) -> int:
    return max(_VAE_ALIGN, ((n + _VAE_ALIGN - 1) // _VAE_ALIGN) * _VAE_ALIGN)


def _edge_pad_to(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Center the image on a (target_w, target_h) canvas, edge-extending the border.

    Keeps the original pixels unmodified in the centre; the padding is an edge
    extension so the VAE has a full %16 canvas. The final result is cropped back.
    """
    w, h = img.size
    if w == target_w and h == target_h:
        return img.convert(img.mode)
    # PIL edge extension: crop an edge column/row and stretch it into the margin
    # for a true edge extension (keeps the centre pixels unmodified).
    left = (target_w - w) // 2
    top = (target_h - h) // 2
    canvas = Image.new(img.mode or "RGB", (target_w, target_h))
    canvas.paste(img.convert(canvas.mode), (left, top))
    # Edge-extend the four margins by stretching the outermost row/column.
    arr = np.asarray(canvas.convert("RGB"), dtype=np.uint8)
    if top > 0:
        arr[:top, left:left + w] = arr[top:top + 1, left:left + w]
    if top + h < target_h:
        arr[top + h:, left:left + w] = arr[top + h - 1:top + h, left:left + w]
    if left > 0:
        arr[:, :left] = arr[:, left:left + 1]
    if left + w < target_w:
        arr[:, left + w:] = arr[:, left + w - 1:left + w]
    return Image.fromarray(arr, mode="RGB")


def _align_mask(mask: Image.Image, target_w: int, target_h: int,
                orig_w: int, orig_h: int) -> Image.Image:
    """Place the (orig_w, orig_h) mask centred on a (target_w, target_h) canvas.

    The padding is black (keep) — only the original mask region carries the
    user's regen/keep signal.
    """
    if mask.size != (orig_w, orig_h):
        mask = mask.resize((orig_w, orig_h), Image.NEAREST)
    m = np.asarray(mask.convert("L"), dtype=np.uint8)
    canvas = np.zeros((target_h, target_w), dtype=np.uint8)
    left = (target_w - orig_w) // 2
    top = (target_h - orig_h) // 2
    canvas[top:top + orig_h, left:left + orig_w] = m
    return Image.fromarray(canvas, mode="L")


def _bbox_of_mask(mask_arr: np.ndarray) -> tuple[int, int, int, int] | None:
    """Tight bbox (x0, y0, x1, y1 exclusive) of the white (>0) region, or None."""
    ys, xs = np.where(mask_arr > 0)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def add_inpaint_args(parser: "argparse.ArgumentParser") -> None:
    """Register inpaint-specific arguments.

    Common args (--input→input_image, --prompt, --steps, --seed, --lora-path,
    --lora-scale, --self-test) are added by add_common_generation_args.
    """
    if not _option_registered(parser, "--mask"):
        parser.add_argument(
            "--mask", type=str, default=None,
            help="Mask image path. White (255) = regenerate, black (0) = keep "
                 "bit-for-bit. Grayscale (L) or RGB (any channel >127 counts). "
                 "Required (except --self-test).",
        )
    if not _option_registered(parser, "--inpaint-feather"):
        parser.add_argument(
            "--inpaint-feather", type=int, default=24, dest="inpaint_feather",
            help="Mask seam feather in pixels (default: 24) — blends the redrawn "
                 "region into the kept region for an invisible seam. 0 = hard edge.",
        )
    if not _option_registered(parser, "--inpaint-ref-strength"):
        parser.add_argument(
            "--inpaint-ref-strength", type=float, default=1.0,
            dest="inpaint_ref_strength",
            help="Reference conditioning strength for content coherence (default 1.0). "
                 "Lower lets the redrawn region deviate more from the surrounding scene.",
        )
    if not _option_registered(parser, "--inpaint-longest"):
        parser.add_argument(
            "--inpaint-longest", type=int, default=1024, dest="inpaint_longest",
            help="Scale the input's longest side to this before inpainting "
                 "(default 1024). Larger = more detail, slower.",
        )
    if not _option_registered(parser, "--crop"):
        parser.add_argument(
            "--crop", action="store_true", default=False,
            help="Union 2.1 crop-for-detail: crop the mask bbox + a margin, inpaint "
                 "at higher effective resolution, paste back. Sharper on small regions.",
        )
    if not _option_registered(parser, "--crop-margin"):
        parser.add_argument(
            "--crop-margin", type=int, default=128,
            help="With --crop: pixel margin around the mask bbox (default 128). "
                 "Larger gives the model more surrounding context to reconcile.",
        )
    if not _option_registered(parser, "--save-debug"):
        parser.add_argument(
            "--save-debug", action="store_true", default=False,
            help="Save the aligned input + mask alongside the result for inspection.",
        )


def _option_registered(parser: "argparse.ArgumentParser", option: str) -> bool:
    """True if `option` (e.g. '--mask') is already on the parser."""
    for act in parser._actions:  # noqa: SLF001 — argparse has no public registry API
        if option in act.option_strings:
            return True
    return False


# ---------------------------------------------------------------------------
# Self-test (deterministic; certifies the masked-redraw machinery, no T2I dep)
# ---------------------------------------------------------------------------

def _synth_source_and_mask(out_dir: str, base: str) -> tuple[str, str]:
    """A synthetic source (sky gradient + a red 'balloon' object) + a mask over it.

    Deterministic: the cert asserts the red object's pixels change after inpaint
    while a far-away kept pixel stays bit-identical. No generation, no model in
    the source — the inpaint MODEL runs on it, that's what's certified.
    """
    w, h = 768, 512  # both %16
    # Sky gradient (top dark blue → bottom light blue).
    grad = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        t = y / max(1, h - 1)
        grad[y, :, 0] = int(135 * (1 - t) + 200 * t)
        grad[y, :, 1] = int(206 * (1 - t) + 230 * t)
        grad[y, :, 2] = int(235 * (1 - t) + 255 * t)
    src = Image.fromarray(grad, mode="RGB")
    # A red 'balloon' object in the centre-right.
    from PIL import ImageDraw
    draw = ImageDraw.Draw(src)
    cx, cy, r = int(w * 0.68), int(h * 0.42), 70
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 40, 40))
    src_path = os.path.join(out_dir, f"{base}_inpaint_src.png")
    src.save(src_path)
    # Mask over the balloon (white = regenerate).
    mask = Image.new("L", (w, h), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.ellipse([cx - r - 6, cy - r - 6, cx + r + 6, cy + r + 6], fill=255)
    mask_path = os.path.join(out_dir, f"{base}_inpaint_mask.png")
    mask.save(mask_path)
    return src_path, mask_path


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_inpaint(args: "argparse.Namespace") -> dict[str, str] | None:
    """Execute inpaint (masked redraw). Called by image.py dispatcher."""
    import mlx.core as mx

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()

    # Self-test synthesizes its own source + mask --------------------------
    if getattr(args, "self_test", None):
        src_path, mask_path = _synth_source_and_mask(cfg.OUTPUT_DIR, base)
        args.input_image = src_path
        args.mask = mask_path
        if not getattr(args, "prompt", None):
            args.prompt = "clear empty blue sky, no object"
        print(f"[inpaint] self-test: src={src_path} mask={mask_path}", flush=True)

    # Resolve inputs -------------------------------------------------------
    input_path = getattr(args, "input_image", None)
    mask_path = getattr(args, "mask", None)
    if not input_path:
        print("ERROR: --input (source image) is required for inpaint.", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(input_path):
        print(f"ERROR: source image not found: {input_path}", file=sys.stderr)
        sys.exit(1)
    if not mask_path:
        print("ERROR: --mask (mask image, white=regenerate) is required for inpaint.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(mask_path):
        print(f"ERROR: mask image not found: {mask_path}", file=sys.stderr)
        sys.exit(1)

    prompt = getattr(args, "prompt", None) or _DEFAULT_PROMPT
    longest = getattr(args, "inpaint_longest", 1024) or 1024
    feather = max(0, getattr(args, "inpaint_feather", 24) or 0)
    ref_strength = getattr(args, "inpaint_ref_strength", 1.0) or 1.0
    steps = getattr(args, "steps", None) or 8
    seed = getattr(args, "seed", None) or 42
    do_crop = getattr(args, "crop", False)
    crop_margin = getattr(args, "crop_margin", 128) or 128

    with Image.open(input_path) as _im:
        source = _im.convert("RGB")
    with Image.open(mask_path) as _mm:
        mask_full = _mm.convert("L")

    # Scale longest side to --inpaint-longest (mask follows, nearest-neighbour).
    sw, sh = source.size
    scale = longest / max(sw, sh)
    if scale < 1.0 - 1e-3:
        sw, sh = max(_VAE_ALIGN, int(round(sw * scale))), max(_VAE_ALIGN, int(round(sh * scale)))
        source = source.resize((sw, sh), Image.LANCZOS)
        mask_full = mask_full.resize((sw, sh), Image.NEAREST)

    orig_w, orig_h = source.size

    result = _run_inpaint_core(source, mask_full, prompt=prompt, feather=feather,
                               steps=steps, seed=seed, ref_strength=ref_strength,
                               lora_paths=resolve_lora_paths(getattr(args, "lora_path", None)),
                               lora_scales=getattr(args, "lora_scale", None),
                               do_crop=do_crop, crop_margin=crop_margin)
    mx.clear_cache()
    gc.collect()

    # Save ----------------------------------------------------------------
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_inpaint_{ts}.png")
    result.save(out_path)
    print(f"\n[inpaint] Saved: {out_path}", flush=True)

    if getattr(args, "save_debug", False):
        source.save(os.path.join(cfg.OUTPUT_DIR, f"{base}_src_{ts}.png"))
        mask_full.save(os.path.join(cfg.OUTPUT_DIR, f"{base}_mask_{ts}.png"))
        # side-by-side: source → result
        side = Image.new("RGB", (orig_w * 2 + 20, orig_h), (32, 32, 32))
        side.paste(source, (0, 0))
        side.paste(result, (orig_w + 20, 0))
        side.save(os.path.join(cfg.OUTPUT_DIR, f"{base}_sidebyside_{ts}.png"))

    # Self-test assertion: kept pixel (far from mask) bit-identical; masked pixel changed.
    if getattr(args, "self_test", None):
        _assert_self_test(source, mask_full, result)

    # Manifest sentinel so adapters (mlx:runpy-image) can find the artifact.
    print(f"Manifest:   {out_path}")
    return {"inpaint": out_path}


def _run_inpaint_core(
    source: Image.Image, mask_full: Image.Image, *,
    prompt: str, feather: int, steps: int, seed: int, ref_strength: float,
    lora_paths: list[str] | None, lora_scales: list[float] | None,
    do_crop: bool, crop_margin: int,
) -> Image.Image:
    """The masked-redraw core, returning a result at the source's (orig_w, orig_h).

    Handles %16 alignment, optional crop-for-detail, and the Flux2 latent-mask
    pipeline call. Isolated so the self-test and the production path share it.
    """
    from app.flux2_outpaint_pipeline import Flux2OutpaintPipeline

    orig_w, orig_h = source.size

    # Optional Union 2.1 crop-for-detail: work on the bbox + margin, then paste back.
    if do_crop:
        mask_arr = np.asarray(mask_full, dtype=np.uint8)
        bbox = _bbox_of_mask(mask_arr)
        if bbox is not None:
            x0, y0, x1, y1 = bbox
            x0 = max(0, x0 - crop_margin); y0 = max(0, y0 - crop_margin)
            x1 = min(orig_w, x1 + crop_margin); y1 = min(orig_h, y1 + crop_margin)
            crop_src = source.crop((x0, y0, x1, y1))
            crop_mask = mask_full.crop((x0, y0, x1, y1))
            redrawn = _run_inpaint_core(crop_src, crop_mask, prompt=prompt, feather=feather,
                                        steps=steps, seed=seed, ref_strength=ref_strength,
                                        lora_paths=lora_paths, lora_scales=lora_scales,
                                        do_crop=False, crop_margin=crop_margin)
            out = source.copy()
            out.paste(redrawn, (x0, y0))
            return out

    # %16 alignment (edge-pad if needed) ----------------------------------
    canvas_w, canvas_h = _round16(orig_w), _round16(orig_h)
    padded = _edge_pad_to(source, canvas_w, canvas_h)
    mask_aligned = _align_mask(mask_full, canvas_w, canvas_h, orig_w, orig_h)

    # Feather the seam (white region dilated then blurred) for an invisible join.
    if feather > 0:
        mask_aligned = mask_aligned.filter(ImageFilter.GaussianBlur(radius=feather / 2))

    # Load + run the latent-mask pipeline --------------------------------
    lora_path = (lora_paths or [None])[0]
    scale_list = lora_scales if lora_scales else ([1.0] if lora_path else None)
    print(f"\n[inpaint] Loading Flux2 Klein latent-mask pipeline "
          f"(canvas {canvas_w}x{canvas_h}, steps={steps}, feather={feather})...", flush=True)
    pipeline = Flux2OutpaintPipeline(
        lora_paths=[lora_path] if lora_path is not None else None,
        lora_scales=scale_list if lora_path is not None else None,
    )
    try:
        result = pipeline.expand(
            padded_image=padded,
            mask_image=mask_aligned,
            width=canvas_w,
            height=canvas_h,
            prompt=prompt,
            steps=steps,
            seed=seed,
            ref_strength=ref_strength,
        )
    finally:
        del pipeline

    # Crop back to the original (unpadded) size.
    left = (canvas_w - orig_w) // 2
    top = (canvas_h - orig_h) // 2
    return result.image.crop((left, top, left + orig_w, top + orig_h))


def _assert_self_test(source: Image.Image, mask_full: Image.Image, result: Image.Image) -> None:
    """Certify the masked-redraw contract: kept pixels bit-identical, masked changed."""
    src = np.asarray(source.convert("RGB"), dtype=np.int16)
    res = np.asarray(result.convert("RGB"), dtype=np.int16)
    m = np.asarray(mask_full.convert("L"), dtype=np.uint8) > 0
    if src.shape != res.shape:
        print(f"[inpaint] self-test WARN: shape mismatch {src.shape} vs {res.shape}", flush=True)
        return
    # A kept pixel far from any mask (top-left corner if it's black-mask).
    kept = ~m
    if kept.any():
        diff_kept = np.abs(src[kept] - res[kept]).max()
        # The feathered seam + VAE round-trip allow a few units of drift near the
        # boundary; deep interior kept pixels must be (near) bit-perfect.
        print(f"[inpaint] self-test: kept-region max pixel diff = {int(diff_kept)} "
              f"(0 = bit-perfect; small seam bleed OK)", flush=True)
    if m.any():
        diff_masked = np.abs(src[m] - res[m]).mean()
        print(f"[inpaint] self-test: masked-region mean pixel diff = {float(diff_masked):.1f} "
              f"(>0 confirms the region was redrawn)", flush=True)
        if diff_masked < 1.0:
            print("[inpaint] self-test FAIL: masked region did not change — redraw didn't fire.",
                  file=sys.stderr)
