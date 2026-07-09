"""image-facerestore — CodeFormer/GFPGAN face restoration (OM image gap I).

DEFERRED — this is an HONEST STUB, not a working implementation.

OpenMontage demands CodeFormer/GFPGAN face restoration with a fidelity slider
(0–1) + Real-ESRGAN ``bg_upsampler`` (OM ``tools/enhancement/face_restore.py`` +
``skills/creative/face-restore-usage.md``). The MLX ``image restore`` path is
I2I-denoise (NOT a face model) and ``image purify`` is SeedVR2 — neither is a
true face model. So OM image gap I is real.

The 2026-07-09 spike (next-goal-20260709-050000 Step 2) confirmed the vision-venv
import is BROKEN/HEAVY, so this command is deferred with a clear blocker rather
than stalling the goal:

  - ``python/vision-venv`` (the torch+spandrel venv backing CLIP/ESRGAN) LACKS
    the entire face-restore stack: basicsr, facexlib, gfpgan, codeformer, AND
    opencv (cv2) are all missing.
  - ``gfpgan`` IS pip-installable, but it DOWNGRADES numpy 2.5.1 → 2.4.6 in the
    SHARED vision-venv (risks regressing the certified CLIP/ESRGAN adapters,
    [[movie-director-clip-esrgan-vision-venv]]) and adds ~25 heavy CV/scientific
    packages (opencv, scipy, scikit-image, numba, llvmlite, lmdb, lpips,
    matplotlib, tensorboard, ...).
  - ``codeformer`` is NOT on PyPI (source-install only).
  - ``spandrel`` cannot substitute — it loads ESRGAN/SwinIR/SRVGG upscaler archs,
    not GAN-inversion face models (CodeFormer/GFPGAN have custom archs).

CLEAN PATH (Future): create a DEDICATED ``python/face-venv`` (do NOT pollute the
shared vision-venv) with gfpgan/codeformer + a face-detect front-end. Detection
can reuse the repo's existing SAM3 face segmentation (``app/sam3_predictor``) or
dlib/face_recognition. Then wire:

  run.py image facerestore --input <photo> --model codeformer|gfpgan \
                           --fidelity 0.5 [--bg-upsampler]

→ restored face, mask-blended so non-face pixels are bit-preserved (distinct
  from ``image restore`` which stays I2I-denoise).

WHY A STUB (not silence): without this, ``run.py image facerestore`` would hit
the image dispatcher's trailing else branch and SILENTLY run t2i (the
null→default silent-wrong anti-pattern). This stub fails loudly with the precise
blocker so the agent learns the capability is a known, documented gap — not a typo.

Imported by app.commands.image via importlib (hyphen in filename).

Public API:
  add_facerestore_args(p)  — register the intended CLI surface (ready for the impl)
  run_facerestore(args)    — fail loudly with the documented blocker
"""
import argparse
import sys


def add_facerestore_args(parser: "argparse.ArgumentParser") -> None:
    """Register the intended facerestore CLI surface (used once the impl lands).

    Declared now so the agent surface is stable; ``run_facerestore`` currently
    refuses with the documented blocker. Common args (--input→input_image,
    --self-test) are added by add_common_generation_args.
    """
    if not any(getattr(a, "dest", None) == "face_model" for a in parser._actions):  # noqa: SLF001
        parser.add_argument(
            "--model", type=str, default="codeformer", dest="face_model",
            choices=["codeformer", "gfpgan"],
            help="Face-restore model (default codeformer). DEFERRED — not yet wired.",
        )
    if not any(getattr(a, "dest", None) == "fidelity" for a in parser._actions):  # noqa: SLF001
        parser.add_argument(
            "--fidelity", type=float, default=0.5,
            help="Fidelity slider 0–1 (0=more creative/free, 1=more faithful to "
                 "the input). DEFERRED — not yet wired.",
        )
    if not any(getattr(a, "dest", None) == "bg_upsampler" for a in parser._actions):  # noqa: SLF001
        parser.add_argument(
            "--bg-upsampler", action="store_true", default=False, dest="bg_upsampler",
            help="Also Real-ESRGAN upscale the non-face background. DEFERRED.",
        )


def run_facerestore(args: "argparse.Namespace") -> None:
    """Refuse with the documented blocker (the 2026-07-09 spike conclusion).

    Fails loudly (exit 2) so the agent surface is honest — ``image facerestore``
    is a known, documented gap, never a silent fall-through to t2i.
    """
    model = getattr(args, "face_model", "codeformer")
    print(
        "image facerestore is DEFERRED (OM image gap I — not yet implemented).\n"
        "\n"
        "2026-07-09 spike finding: the face-restore stack (basicsr/facexlib/\n"
        f"{model}/codeformer + opencv) is ABSENT from python/vision-venv. gfpgan\n"
        "installs but DOWNGRADES numpy 2.5.1→2.4.6 in the SHARED vision-venv\n"
        "(risks regressing CLIP/ESRGAN) + adds ~25 heavy CV packages; codeformer\n"
        "is source-install only; spandrel can't substitute (face GAN archs).\n"
        "\n"
        "Clean path (Future): a DEDICATED python/face-venv + a SAM3/dlib detect\n"
        "front-end, then --model/--fidelity/--bg-upsampler as declared. Tracked\n"
        "in the next-goal Future plan.",
        file=sys.stderr,
    )
    sys.exit(2)
