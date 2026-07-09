#!/usr/bin/env python3
"""face_restore_bridge — thin subprocess entry that runs the face-restore stack.

Invoked by ``app.commands.image-facerestore`` as::

    python/face-venv/bin/python app/face_restore_bridge.py \
        --input <abs> --output <abs> --model gfpgan --fidelity 0.5 [--bg-upsampler]

WHY A SEPARATE PROCESS: the face-restore stack (gfpgan / basicsr / facexlib /
realesrgan) pulls torch 2.13 + scipy + numba + opencv AND downgrades numpy
2.5.1 -> 2.4.6, which would risk regressing the certified MLX generation stack
that lives in ``python/venv`` (transformers<5, mlx-vlm 0.6.2). It is isolated in
a DEDICATED ``python/face-venv``; ``run.py`` (in ``python/venv``) spawns this
bridge under that venv. This script MUST NOT import anything from ``app.`` —
``face-venv`` is a bare torch venv with no MLX/pipeline code.

The bridge prints a single JSON manifest as its LAST stdout line so the parent
can parse the result deterministically (mirrors how run.py surfaces outputs)::

    {"ok": true, "output": "<abs>", "model": "gfpgan", "num_faces": 1,
     "bg_upsampler": false, "weights_dir": "<abs>"}

On failure it prints ``{"ok": false, "error": "..."}`` and exits non-zero.

Compat shim: basicsr 1.4.2 imports ``torchvision.transforms.functional_tensor``,
removed in torchvision >= 0.28. We inject a sys.modules shim before importing
gfpgan (kept in-process here rather than mutating face-venv's site-packages, per
the repo's vendor-patch-in-code philosophy).

CodeFormer is structurally supported (--model codeformer) but is source-install
only (not on PyPI); the bridge reports the install command if it is absent.
GFPGAN is the working path and is what the certification uses today. ``--fidelity``
is a CodeFormer concept (w); GFPGAN ignores it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
import warnings


def _apply_torchvision_shim() -> None:
    """basicsr 1.4.2 imports a torchvision submodule removed in 0.28."""
    import types

    import torchvision.transforms.functional as F

    shim = types.ModuleType("torchvision.transforms.functional_tensor")
    for name in (
        "rgb_to_grayscale",
        "adjust_brightness",
        "adjust_contrast",
        "adjust_hue",
        "adjust_saturation",
    ):
        if hasattr(F, name):
            setattr(shim, name, getattr(F, name))
    sys.modules["torchvision.transforms.functional_tensor"] = shim


def _emit(payload: dict) -> None:
    """Print the JSON manifest as the final stdout line (parent parses last line)."""
    sys.stdout.write("\n__FACE_RESTORE_MANIFEST__\n" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _resolve_weights_dir(raw: str) -> str:
    return os.path.abspath(raw)


def _make_bg_upsampler(weights_dir: str, device: str):
    """Real-ESRGAN background upsampler (optional --bg-upsampler).

    Weight resolution order (offline-safe):
      1. ``weights_dir/RealESRGAN_x4plus.pth`` (the legacy gfpgan/weights dir).
      2. Any dir in ``FACE_RESTORE_EXTRA_WEIGHTS_DIRS`` (colon-separated; the
         MLX model store's upscale dir is passed here so a vendored copy wins).
      3. Under ``FACE_RESTORE_OFFLINE=1`` → FAIL LOUD (never download).
      4. Otherwise (online) → download from the GitHub release (legacy path).
    """
    from realesrgan import RealESRGANer
    from basicsr.archs.rrdbnet_arch import RRDBNet

    fname = "RealESRGAN_x4plus.pth"
    candidate_dirs = [weights_dir]
    extra = os.environ.get("FACE_RESTORE_EXTRA_WEIGHTS_DIRS", "")
    candidate_dirs += [d for d in extra.split(os.pathsep) if d]
    model_path = next(
        (os.path.join(d, fname) for d in candidate_dirs if os.path.exists(os.path.join(d, fname))),
        None,
    )

    if not model_path:
        if os.environ.get("FACE_RESTORE_OFFLINE") == "1":
            raise RuntimeError(
                f"Real-ESRGAN bg weight '{fname}' not found in any of "
                f"{candidate_dirs} and FACE_RESTORE_OFFLINE=1 forbids download. "
                f"Vendor it ONLINE first into mlx-models/upscale/realesrgan/{fname} "
                f"(or gfpgan/weights/) and re-run."
            )
        # Legacy online path — only reached when NOT offline.
        import urllib.request

        model_path = os.path.join(weights_dir, fname)
        url = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
        print(f"[face-restore] downloading Real-ESRGAN bg model to {model_path}", file=sys.stderr)
        urllib.request.urlretrieve(url, model_path)  # noqa: S310 — fixed release URL
    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
    half = device != "cpu" and sys.platform != "darwin"  # MPS has no half; fp32 on Apple Silicon
    return RealESRGANer(
        scale=4, model_path=model_path, model=model, tile=400, tile_pad=10, pre_pad=0, half=half, device=device
    )


def _run_gfpgan(input_path: str, output_path: str, weights_dir: str, fidelity: float,
                bg_upsampler: bool, device: str) -> dict:
    import cv2

    from gfpgan import GFPGANer

    bg = _make_bg_upsampler(weights_dir, device) if bg_upsampler else None
    restorer = GFPGANer(
        model_path=os.path.join(weights_dir, "GFPGANv1.4.pth"),
        upscale=1,            # restore only; resolution unchanged (no global enlarge)
        arch="clean",
        channel_multiplier=2,
        bg_upsampler=bg,
        device=device,
    )
    img = cv2.imread(input_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"cv2 could not read input image: {input_path}")
    # paste_back=True composites the restored face back onto the ORIGINAL image
    # via a face-parse mask, so non-face pixels are bit-preserved (distinct from
    # image restore = full I2I denoise). fidelity is a CodeFormer-only knob.
    cropped, restored, restored_img = restorer.enhance(
        img, has_aligned=False, only_center_face=False, paste_back=True
    )
    num_faces = len(restored) if restored is not None else 0
    if restored_img is None:
        raise RuntimeError("GFPGANer.enhance returned no output image (no face restored).")
    cv2.imwrite(output_path, restored_img)
    return {"num_faces": num_faces, "fidelity_applied": False}


def _run_codeformer(input_path: str, output_path: str, weights_dir: str, fidelity: float,
                    bg_upsampler: bool, device: str) -> dict:
    # CodeFormer is NOT on PyPI (source-install only) and its inference + paste-back
    # wiring is the documented follow-up. GFPGAN (--model gfpgan) is the certified
    # path today. Surface a precise install command rather than silently no-op'ing.
    # The install is a `git clone` (network) — gated as an EXPLICIT enable step,
    # never attempted at runtime; under offline we just report it is unavailable.
    import importlib.util

    installed = importlib.util.find_spec("codeformer") is not None
    offline = os.environ.get("FACE_RESTORE_OFFLINE") == "1"
    suffix = (" Use --model gfpgan (the certified path) for now."
              + (" (offline: the CodeFormer source-install is a network step — skipped.)" if offline else ""))
    raise RuntimeError(
        "CodeFormer is " + ("installed but inference wiring is not implemented yet"
                            if installed else "not installed in python/face-venv (source-install only)")
        + ". To enable: git clone https://github.com/sczhou/CodeFormer ../CodeFormer && "
        "uv pip install --python python/face-venv/bin/python -e ../CodeFormer, then wire "
        "_run_codeformer." + suffix
    )


def main() -> int:
    warnings.filterwarnings("ignore")
    parser = argparse.ArgumentParser(description="face_restore_bridge (runs in python/face-venv)")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", choices=["gfpgan", "codeformer"], default="gfpgan")
    parser.add_argument("--fidelity", type=float, default=0.5,
                        help="CodeFormer fidelity weight (0=creative,1=faithful). GFPGAN ignores it.")
    parser.add_argument("--bg-upsampler", action="store_true", help="Also Real-ESRGAN upscale the background.")
    parser.add_argument("--weights-dir", default="gfpgan/weights",
                        help="Dir holding GFPGANv1.4.pth + facexlib detection/parsing weights.")
    parser.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"])
    args = parser.parse_args()

    weights_dir = _resolve_weights_dir(args.weights_dir)

    try:
        import torch

        device = args.device
        if device == "auto":
            device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"[face-restore] model={args.model} device={device} weights={weights_dir} "
              f"fidelity={args.fidelity} bg_upsampler={args.bg_upsampler}", file=sys.stderr)

        _apply_torchvision_shim()

        if not os.path.exists(args.input):
            raise FileNotFoundError(f"input image not found: {args.input}")
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

        runner = _run_gfpgan if args.model == "gfpgan" else _run_codeformer
        meta = runner(args.input, args.output, weights_dir, args.fidelity, args.bg_upsampler, device)

        _emit({
            "ok": True,
            "output": os.path.abspath(args.output),
            "model": args.model,
            "num_faces": meta["num_faces"],
            "bg_upsampler": args.bg_upsampler,
            "device": device,
            "weights_dir": weights_dir,
        })
        return 0
    except Exception as exc:  # noqa: BLE001 — surface to parent as JSON
        sys.stderr.write(traceback.format_exc())
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
