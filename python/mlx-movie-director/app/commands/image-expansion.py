"""image-expansion — Flux2 Klein outpainting / image expansion on MLX.

Ports the ComfyUI "Flux2_Klein_Image expansion" workflow (CivitAI 2326854 /
version 2617507) to the app's native MLX pipeline. Extends an image's canvas
and synthesises coherent new content in the added margins while preserving the
original pixels bit-for-bit.

Pipeline (latent-mask outpaint, see app/flux2_outpaint_pipeline.py):
  1. Scale source longest side to --longest (16-aligned).
  2. Pad the canvas (--expand directional, or --ratio target aspect) with
     edge-extension fill; build a feathered mask (white = regenerate margin,
     black = keep original).
  3. Flux2 Klein 9B masked denoising (8 steps default, euler, cfg=1) — original region
     latent re-injected each step, only margins denoise.
  4. (Optional --upscale) SeedVR2 super-resolution of the expanded result.

Imported by app.commands.image via importlib (hyphen in filename prevents a
regular import statement).

Public API:
  add_expansion_args(parser)  — register expansion-specific CLI arguments
  run_expansion(args)         — execute expansion
"""

import gc
import os
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageFilter

from app import config as cfg
from app.commands._shared import (
    DEFAULT_UPSCALE_MODEL,
    execute_upscale,
    generate_base_name,
    resolve_lora_path,
)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_PROMPT = (
    "Seamlessly extend the scene beyond the original frame. Maintain consistent "
    "lighting, color grading, perspective, and texture. Fill the expanded area "
    "with natural, coherent content that blends with no visible seam."
)

_VAE_ALIGN = 16  # Flux2 canvas sides must be multiples of 16


# ---------------------------------------------------------------------------
# Canvas + mask construction
# ---------------------------------------------------------------------------

def _round16(n: int) -> int:
    n = int(n)
    return max(_VAE_ALIGN, (n // _VAE_ALIGN) * _VAE_ALIGN)


def _parse_ratio(ratio: str) -> tuple[float, float]:
    """Parse a 'W:H' (or 'WxH') aspect-ratio string into (w_ratio, h_ratio)."""
    sep = ":" if ":" in ratio else "x"
    parts = ratio.split(sep)
    if len(parts) != 2:
        raise ValueError(f"Invalid --ratio '{ratio}'. Use W:H (e.g. 16:9).")
    return float(parts[0]), float(parts[1])


def compute_canvas(
    src_w: int, src_h: int,
    *,
    expand_dirs: set[str] | None,
    pixels: int,
    ratio: str | None,
    longest: int,
) -> tuple[int, int, int, int, int, int]:
    """Compute the expanded canvas geometry.

    Returns (scaled_src_w, scaled_src_h, left, top, canvas_w, canvas_h).
    """
    # 1. Scale source so its longest side == `longest`, keep aspect, 16-align.
    scale = longest / float(max(src_w, src_h))
    sw = _round16(src_w * scale)
    sh = _round16(src_h * scale)

    # 2. Determine padding margins.
    if ratio:
        rw, rh = _parse_ratio(ratio)
        target_aspect = rw / rh
        src_aspect = sw / sh
        if target_aspect >= src_aspect:
            # Widen: fixed height, expand width to hit the target aspect.
            canvas_w = _round16(sh * target_aspect)
            canvas_h = sh
            if canvas_w <= sw:                       # ensure room to expand
                canvas_w = _round16(sw + _VAE_ALIGN)
        else:
            # Lengthen: fixed width, expand height.
            canvas_w = sw
            canvas_h = _round16(sw / target_aspect)
            if canvas_h <= sh:
                canvas_h = _round16(sh + _VAE_ALIGN)
        left = (canvas_w - sw) // 2
        top = (canvas_h - sh) // 2
    else:
        dirs = expand_dirs or set()
        left = pixels if "left" in dirs else 0
        right = pixels if "right" in dirs else 0
        top = pixels if "up" in dirs else 0
        bottom = pixels if "down" in dirs else 0
        raw_w = sw + left + right
        raw_h = sh + top + bottom
        canvas_w = _round16(raw_w)
        canvas_h = _round16(raw_h)
        # Distribute the 16-alignment rounding delta onto the expanded sides,
        # honouring directionality: --expand right pads only the right, etc.
        # Only when BOTH sides of an axis are requested do we centre the delta.
        dw = canvas_w - raw_w
        dh = canvas_h - raw_h
        if "left" in dirs and "right" in dirs:
            left += dw // 2
            right += dw - dw // 2
        elif "right" in dirs:
            right += dw
        elif "left" in dirs:
            left += dw
        if "up" in dirs and "down" in dirs:
            top += dh // 2
            bottom += dh - dh // 2
        elif "down" in dirs:
            bottom += dh
        elif "up" in dirs:
            top += dh

    right = canvas_w - sw - left
    bottom = canvas_h - sh - top
    # Sanity: every margin non-negative
    left, top = max(0, left), max(0, top)
    right, bottom = max(0, right), max(0, bottom)
    return sw, sh, left, top, canvas_w, canvas_h


def build_padded_and_mask(
    source: Image.Image,
    sw: int, sh: int, left: int, top: int, canvas_w: int, canvas_h: int,
    feather: int,
    overlap: int = 0,
) -> tuple[Image.Image, Image.Image]:
    """Build the edge-extended padded image and the feathered outpaint mask.

    Returns (padded_rgb, mask_L) both sized (canvas_w, canvas_h).

    ``overlap`` extends the regeneration band INTO the original on every expanded
    side, so the model paints across the seam and reconciles lighting/texture/
    perspective there (instead of generating the margin in isolation, which leaves
    a visible seam). The final composite then fades back to the bit-perfect
    original across the feathered overlap band — the deep interior is untouched.
    """
    # Scale source to the target (sw, sh).
    src_resized = source.convert("RGB").resize((sw, sh), Image.LANCZOS)
    src_arr = np.asarray(src_resized, dtype=np.uint8)

    right = canvas_w - sw - left
    bottom = canvas_h - sh - top
    # Edge-extend the source into the padding (gives the VAE real content at the
    # boundary → smoother seam than a flat fill).
    padded = np.pad(
        src_arr,
        ((top, bottom), (left, right), (0, 0)),
        mode="edge",
    )
    padded_img = Image.fromarray(padded, mode="RGB")

    # Mask: 255 (regenerate) over each margin PLUS an `overlap`-wide band inside
    # the original on every EXPANDED side. Non-expanded sides (margin 0) touch the
    # canvas edge with pure original → no seam there → nothing to regenerate.
    # Then Gaussian-feather so the final composite tapers generated→original.
    mask = np.zeros((canvas_h, canvas_w), dtype=np.float32)
    if left > 0:
        mask[:, : left + overlap] = 1.0
    if right > 0:
        mask[:, canvas_w - (right + overlap):] = 1.0
    if top > 0:
        mask[: top + overlap, :] = 1.0
    if bottom > 0:
        mask[canvas_h - (bottom + overlap):, :] = 1.0
    mask_img_full = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    if feather and feather > 0:
        mask_img_full = mask_img_full.filter(ImageFilter.GaussianBlur(radius=feather))
    return padded_img, mask_img_full


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_expansion_args(parser: "argparse.ArgumentParser") -> None:
    """Register expansion-specific arguments.

    Common args (--input→input_image, --prompt, --steps, --seed, --lora-path,
    --lora-scale, --upscale, --upscale-method) are added by add_common_generation_args.
    """
    parser.add_argument(
        "--expand", type=str, default=None, metavar="DIRS",
        help="Comma list of directions to expand: left,right,up,down "
             "(e.g. 'left,right'). Mutually exclusive with --aspect.",
    )
    parser.add_argument(
        "--pixels", type=int, default=1024,
        help="Pixels to expand per direction with --expand (default: 1024).",
    )
    parser.add_argument(
        "--aspect", type=str, default=None, metavar="W:H",
        help="Target aspect ratio for the expanded canvas, e.g. '16:9' or '4:3'. "
             "Margins are computed automatically. Mutually exclusive with --expand.",
    )
    parser.add_argument(
        "--expansion-feather", type=int, default=96, dest="expansion_feather",
        help="Mask feathering in pixels for a smooth seam (default: 96). "
             "Keep ≤ overlap to avoid visible blur bands.",
    )
    parser.add_argument(
        "--overlap", type=int, default=128,
        help="Pixels to regenerate INTO the original on each expanded side, so the "
             "model paints across the seam and reconciles lighting/texture (default: 128). "
             "Larger = more seamless but edits more of the original near the edges.",
    )
    parser.add_argument(
        "--longest", type=int, default=1024,
        help="Scale the source's longest side to this before expanding (default: 1024).",
    )
    parser.add_argument(
        "--expansion-ref-strength", type=float, default=1.0, dest="expansion_ref_strength",
        help="Reference conditioning strength for content coherence (default: 1.0). "
             "Lower lets the model deviate more from the source in the new margins.",
    )
    parser.add_argument(
        "--save-debug", action="store_true", default=False,
        help="Save the padded canvas and mask alongside the result for inspection.",
    )
    parser.add_argument(
        "--upscale-resolution", type=str, default="2x", metavar="N|x",
        help="With --upscale --upscale-method seedvr2: target pixels (e.g. 2160) or "
             "scale (e.g. 2x, 3x). Default 2x.",
    )
    parser.add_argument(
        "--upscale-softness", type=float, default=0.5,
        help="With --upscale --upscale-method seedvr2: input softness 0.0-1.0 (default: 0.5).",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_expansion(args: "argparse.Namespace") -> dict[str, str] | None:
    """Execute image expansion (outpainting). Called by image.py dispatcher."""
    import mlx.core as mx

    # Resolve arguments ------------------------------------------------------
    input_path = getattr(args, "input_image", None) or getattr(args, "input", None)
    if not input_path:
        print("ERROR: --input (source image) is required for expansion.", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(input_path):
        print(f"ERROR: source image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    expand_raw = getattr(args, "expand", None)
    ratio = getattr(args, "aspect", None)
    if expand_raw and ratio:
        print("ERROR: --expand and --aspect are mutually exclusive.", file=sys.stderr)
        sys.exit(1)
    if not expand_raw and not ratio:
        expand_raw = "left,right"  # sensible default: widen horizontally

    expand_dirs = {d.strip().lower() for d in expand_raw.split(",")} if expand_raw else None
    if expand_dirs:
        bad = expand_dirs - {"left", "right", "up", "down"}
        if bad:
            print(f"ERROR: invalid --expand directions: {bad}. "
                  f"Use left,right,up,down.", file=sys.stderr)
            sys.exit(1)

    pixels = getattr(args, "pixels", 1024)
    feather = getattr(args, "expansion_feather", 96)
    overlap = getattr(args, "overlap", 128)
    longest = getattr(args, "longest", 1024)
    ref_strength = getattr(args, "expansion_ref_strength", 1.0)
    steps = getattr(args, "steps", None) or 8
    seed = getattr(args, "seed", 42)
    prompt = getattr(args, "prompt", None) or _DEFAULT_PROMPT

    # Load source + compute geometry ----------------------------------------
    source = Image.open(input_path).convert("RGB")
    src_w, src_h = source.size
    sw, sh, left, top, canvas_w, canvas_h = compute_canvas(
        src_w, src_h,
        expand_dirs=expand_dirs, pixels=pixels, ratio=ratio, longest=longest,
    )

    mode = f"ratio {ratio}" if ratio else f"expand {sorted(expand_dirs)}"
    print(f"\n[expansion] Source: {src_w}x{src_h} → scaled {sw}x{sh}")
    print(f"[expansion] Mode: {mode}  | canvas {canvas_w}x{canvas_h} "
          f"(margins L={left} T={top} R={canvas_w-sw-left} B={canvas_h-sh-top})")
    print(f"[expansion] Feather: {feather}px  | overlap: {overlap}px  | steps: {steps}  | seed: {seed}")

    padded_img, mask_img = build_padded_and_mask(
        source, sw, sh, left, top, canvas_w, canvas_h, feather, overlap=overlap,
    )

    # Output paths ----------------------------------------------------------
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()

    # Build + run the outpaint pipeline -------------------------------------
    from app.flux2_outpaint_pipeline import Flux2OutpaintPipeline

    lora_path = resolve_lora_path(getattr(args, "lora_path", None))
    _lora_scale_raw = getattr(args, "lora_scale", None)
    lora_scale = 1.0 if _lora_scale_raw is None else _lora_scale_raw

    print(f"\n[expansion] Loading Flux2 Klein outpaint pipeline...")
    pipeline = Flux2OutpaintPipeline(
        lora_paths=[lora_path] if lora_path is not None else None,
        lora_scales=[lora_scale] if lora_path is not None else None,
    )
    try:
        result = pipeline.expand(
            padded_image=padded_img,
            mask_image=mask_img,
            width=canvas_w,
            height=canvas_h,
            prompt=prompt,
            steps=steps,
            seed=seed,
            ref_strength=ref_strength,
        )
    finally:
        del pipeline
        mx.clear_cache()
        gc.collect()

    # Save result -----------------------------------------------------------
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_expand_{ts}.png")
    result.image.save(out_path)
    print(f"\n[expansion] Saved: {out_path}")

    if getattr(args, "save_debug", False):
        padded_img.save(os.path.join(cfg.OUTPUT_DIR, f"{base}_padded_{ts}.png"))
        mask_img.save(os.path.join(cfg.OUTPUT_DIR, f"{base}_mask_{ts}.png"))
        # Side-by-side source → expanded for quick visual check
        side = Image.new("RGB", (src_w + canvas_w + 20, max(sh, canvas_h)), (32, 32, 32))
        side.paste(source.resize((sw, sh), Image.LANCZOS), (0, 0))
        side.paste(result.image, (sw + 20, 0))
        side.save(os.path.join(cfg.OUTPUT_DIR, f"{base}_sidebyside_{ts}.png"))

    # Optional super-resolution --------------------------------------------
    if getattr(args, "upscale", False):
        _run_upscale(out_path, args)

    return {"expand": out_path, "canvas": (canvas_w, canvas_h)}


def _run_upscale(input_path: str, args) -> str | None:
    """Run SeedVR2 (or ESRGAN) super-resolution on the expanded result."""
    method = getattr(args, "upscale_method", "esrgan")
    res_str = getattr(args, "upscale_resolution", None) or "2x"
    softness = getattr(args, "upscale_softness", 0.5)

    print(f"\n[expansion] Upscaling via {method} ({res_str})...")
    if method == "seedvr2":
        from app.seedvr2.pipeline import SeedVR2Upscaler
        res_str_s = str(res_str)
        if res_str_s.lower().endswith("x"):
            resolution = float(res_str_s.lower().rstrip("x"))
        else:
            resolution = int(res_str_s)
        image = Image.open(input_path).convert("RGB")
        upscaler = SeedVR2Upscaler(model_size="7b")
        try:
            result = upscaler.upscale(image=image, resolution=resolution, softness=softness,
                                      seed=getattr(args, "seed", 42))
        finally:
            upscaler.unload()
    else:
        # ESRGAN fallback — fast pixel upscale (writes directly to out_path).
        base, ext = os.path.splitext(input_path)
        out_path = f"{base}_esrgan{ext or '.png'}"
        execute_upscale(input_path, DEFAULT_UPSCALE_MODEL, out_path)
        print(f"[expansion] Saved upscaled: {out_path}")
        return out_path

    base, ext = os.path.splitext(input_path)
    out_path = f"{base}_{method}{ext or '.png'}"
    result.save(out_path)
    print(f"[expansion] Saved upscaled: {out_path}")
    return out_path
