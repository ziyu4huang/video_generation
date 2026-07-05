#!/usr/bin/env python3
"""esrgan_upscale.py — native ESRGAN upscale entry for the movie-director ext.

Spawned by the Bun `esrganAdapter` (providers.ts). Loads a spandrel-compatible
ESRGAN model (.pth) and upscales an image on Apple Silicon MPS via PyTorch —
the SAME code path as `app/pipeline.py:upscale_esrgan` (run.py upscale), just
factored into a standalone entry so it can run in the lightweight
`python/vision-venv` (spandrel + torch + pillow) without the full MLX stack.

This is the Item I sibling: closes the `enhancement:upscale` GAP in the
provider menu with a native director (ESRGAN on Apple Silicon MPS), on-thesis
with the repo's existing upscale path.

Contract (JSON, written to --output or stdout):
  {
    "ok": true,
    "image": "<abspath>",
    "model": "<model-path>",
    "scale": 4,
    "in_w": 512, "in_h": 512,
    "out_w": 2048, "out_h": 2048,
    "out": "<abspath of upscaled PNG>",
    "duration_s": 1.23
  }

On failure: { "ok": false, "error": "<message>" } with a non-zero exit code.
"""
from __future__ import annotations

import argparse
import os
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser(description="ESRGAN upscale entry (spandrel + torch MPS)")
    ap.add_argument("--image", required=True, help="path to the input image")
    ap.add_argument(
        "--model",
        default=os.environ.get(
            "MD_ESRGAN_MODEL",
            # Mirror run.py's DEFAULT_UPSCALE_MODEL (config.py): 4xNomosWebPhoto_RealPLKSR.
            # Resolved by the adapter; the python entry only trusts this arg.
            "4xNomosWebPhoto_RealPLKSR.pth",
        ),
        help="spandrel-compatible ESRGAN .pth path (default: 4xNomosWebPhoto_RealPLKSR).",
    )
    ap.add_argument(
        "--scale",
        type=int,
        default=4,
        help="ignored — scale is inferred from the .pth (kept for contract symmetry).",
    )
    ap.add_argument("--output", default=None, help="write JSON here; stdout if omitted.")
    ap.add_argument("--out-image", default=None, help="write the upscaled PNG here (default: <dir>/<stem>_4x.png).")
    args = ap.parse_args()

    if not os.path.isfile(args.image):
        return _emit(args.output, {"ok": False, "error": f"image not found: {args.image}"}, exit_code=2)
    if not os.path.isfile(args.model):
        return _emit(args.output, {"ok": False, "error": f"model not found: {args.model}"}, exit_code=2)

    try:
        import numpy as np  # noqa: F401
        import torch
        import spandrel
        from PIL import Image
    except Exception as exc:  # pragma: no cover - env-dependent
        return _emit(args.output, {"ok": False, "error": f"import failed: {exc}"}, exit_code=3)

    t0 = time.time()
    try:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        loader = spandrel.ModelLoader(device=device)
        model_sr = loader.load_from_file(args.model)
        model_sr.eval()

        img = Image.open(args.image).convert("RGB")
        in_w, in_h = img.size
        img_np = np.array(img).astype(np.float32) / 255.0
        img_pt = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0).to(device)
        with torch.no_grad():
            result_pt = model_sr(img_pt)
        result_np = result_pt.squeeze(0).permute(1, 2, 0).cpu().float().numpy()
        result_np = np.clip(result_np * 255, 0, 255).round().astype("uint8")
        out_img = Image.fromarray(result_np)
        out_w, out_h = out_img.size

        out_path = args.out_image or _default_out_path(args.image, model_sr)
        out_dir = os.path.dirname(out_path)
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        out_img.save(out_path, "PNG")
    except Exception as exc:
        return _emit(args.output, {"ok": False, "error": f"upscale failed: {exc}"}, exit_code=4)

    payload = {
        "ok": True,
        "image": os.path.abspath(args.image),
        "model": os.path.abspath(args.model),
        "scale": max(1, out_w // max(1, in_w)),
        "in_w": in_w,
        "in_h": in_h,
        "out_w": out_w,
        "out_h": out_h,
        "out": os.path.abspath(out_path),
        "duration_s": round(time.time() - t0, 3),
    }
    return _emit(args.output, payload, exit_code=0)


def _default_out_path(image: str, model_sr) -> str:
    """Derive <stem>_<scale>x.png next to the input — mirrors run.py convention."""
    scale = 4
    try:
        scale = int(getattr(getattr(model_sr, "scale", None), "__index__", lambda: 4)())
    except Exception:
        scale = 4
    base = os.path.splitext(image)[0]
    return f"{base}_{scale}x.png"


def _emit(output: str | None, payload: dict, exit_code: int) -> int:
    import json

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if output:
        with open(output, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
