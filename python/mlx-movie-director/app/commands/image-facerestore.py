"""image-facerestore — CodeFormer/GFPGAN face restoration (OM image gap I, NOW REAL).

OpenMontage demands CodeFormer/GFPGAN face restoration with a fidelity slider
(0-1) + optional Real-ESRGAN ``bg_upsampler`` (OM ``tools/enhancement/
face_restore.py``). The MLX ``image restore`` path is I2I-denoise (NOT a face
model) and ``image purify`` is SeedVR2 -- neither is a true face model, so OM
image gap I was real.

This command is now WIRED (2026-07-09, next-goal-20260709-093000 Step 2): it
restores faces via GFPGAN running in a DEDICATED ``python/face-venv``. The
face-restore stack (gfpgan / basicsr / facexlib / realesrgan) pulls torch 2.13 +
scipy + numba + opencv AND downgrades numpy 2.5.1 -> 2.4.6 -- installing that
into the shared MLX ``python/venv`` would risk regressing the certified
image/video generation pipeline (transformers<5, mlx-vlm 0.6.2). So this command
SPAWNS ``python/face-venv/bin/python app/face_restore_bridge.py`` (the parent,
``run.py``, stays in ``python/venv``; the actual model runs in face-venv).
This mirrors how the repo already isolates vision-venv (CLIP/ESRGAN) and
whisper-venv from the main MLX venv -- face-venv is the fourth isolated member.

The bridge detects faces (facexlib RetinaFace), restores each via GFPGAN, then
composites back with ``paste_back=True`` -- a face-parse mask restores ONLY the
face region, so non-face pixels are bit-preserved (distinct from ``image
restore`` which stays a full I2I denoise). CodeFormer (``--model codeformer``)
is structurally wired but source-install only -- the bridge reports the install
command if absent; GFPGAN is the certified path.

CLI surface::

    run.py image facerestore --input <photo> [--model codeformer|gfpgan] \
        [--fidelity 0.5] [--bg-upsampler]

If ``python/face-venv`` is absent (it is per-machine, gitignored, NOT
auto-created -- like the MLX venv), this command fails LOUDLY with the exact
recreate steps.

Imported by app.commands.image via importlib (hyphen in filename).

Public API:
  add_facerestore_args(p)  -- register the CLI surface
  run_facerestore(args)    -- spawn face-venv bridge, parse manifest, emit output
"""
import argparse
import os
import subprocess
import sys

from app import config as cfg
from app.commands._shared import generate_base_name

# Marker line emitted by the bridge before its JSON manifest; everything after
# the last occurrence is the result the parent parses.
_BRIDGE_MANIFEST_MARKER = "__FACE_RESTORE_MANIFEST__"


def add_facerestore_args(parser: "argparse.ArgumentParser") -> None:
    """Register the facerestore CLI surface.

    Common args (--input->input_image, --self-test) are added by
    add_common_generation_args. Registered here before the common args so the
    facerestore-specific defaults/win.
    """
    if not any(getattr(a, "dest", None) == "face_model" for a in parser._actions):  # noqa: SLF001
        parser.add_argument(
            "--model", type=str, default="gfpgan", dest="face_model",
            choices=["codeformer", "gfpgan"],
            help="Face-restore model (default gfpgan). codeformer is source-install only.",
        )
    if not any(getattr(a, "dest", None) == "fidelity" for a in parser._actions):  # noqa: SLF001
        parser.add_argument(
            "--fidelity", type=float, default=0.5,
            help="Fidelity slider 0-1 (0=more creative, 1=more faithful). "
                 "CodeFormer only; GFPGAN ignores it.",
        )
    if not any(getattr(a, "dest", None) == "bg_upsampler" for a in parser._actions):  # noqa: SLF001
        parser.add_argument(
            "--bg-upsampler", action="store_true", default=False, dest="bg_upsampler",
            help="Also Real-ESRGAN upscale the non-face background.",
        )


def _resolve_face_python() -> str | None:
    """Find python/face-venv/bin/python (env override MD_FACE_PYTHON wins)."""
    env_override = os.environ.get("MD_FACE_PYTHON")
    if env_override and os.path.exists(env_override):
        return env_override
    candidate = os.path.join(cfg.REPO_DIR, "python", "face-venv", "bin", "python")
    return candidate if os.path.exists(candidate) else None


def _missing_venv_help() -> str:
    return (
        "python/face-venv is absent (it is per-machine, gitignored, NOT auto-created).\n"
        "The face-restore stack is isolated there so its numpy downgrade never risks\n"
        "the MLX generation venv. Recreate it:\n"
        "  uv venv python/face-venv --python 3.12\n"
        "  uv pip install --python python/face-venv/bin/python gfpgan opencv-python lpips realesrgan\n"
        "  # weights auto-download to gfpgan/weights on first run:\n"
        "  python/face-venv/bin/python python/mlx-movie-director/app/face_restore_bridge.py "
        "--input <img> --output <out> --model gfpgan"
    )


def run_facerestore(args: "argparse.Namespace") -> None:
    """Spawn the face-venv bridge, parse its manifest, emit the output path.

    ``run.py`` (the parent) stays in python/venv; the GFPGAN model runs in
    python/face-venv via app/face_restore_bridge.py. Fails loudly (exit 2) on a
    missing venv or subprocess failure so the gap is never a silent t2i
    fall-through.
    """
    input_path = getattr(args, "input_image", None)
    if not input_path:
        print("ERROR: --input <photo> is required for facerestore.", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(input_path):
        print(f"ERROR: input image not found: {input_path}", file=sys.stderr)
        sys.exit(2)

    face_python = _resolve_face_python()
    if not face_python:
        print(f"ERROR: image facerestore cannot run — {_missing_venv_help()}", file=sys.stderr)
        sys.exit(2)

    bridge = os.path.join(cfg.REPO_DIR, "python", "mlx-movie-director", "app", "face_restore_bridge.py")
    if not os.path.exists(bridge):
        print(f"ERROR: bridge script missing: {bridge}", file=sys.stderr)
        sys.exit(2)

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = generate_base_name()
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_facerestore.png")

    model = getattr(args, "face_model", "gfpgan")
    fidelity = getattr(args, "fidelity", 0.5)
    bg_upsampler = getattr(args, "bg_upsampler", False)
    weights_dir = os.path.join(cfg.REPO_DIR, "gfpgan", "weights")

    argv = [
        face_python, bridge,
        "--input", os.path.abspath(input_path),
        "--output", os.path.abspath(out_path),
        "--model", model,
        "--fidelity", str(fidelity),
        "--weights-dir", weights_dir,
    ]
    if bg_upsampler:
        argv.append("--bg-upsampler")

    # Offline propagation: when the parent run.py is --offline, tell the bridge
    # (a) to treat the MLX upscale store as a candidate for the vendored
    # Real-ESRGAN weight, and (b) to NEVER download (FACE_RESTORE_OFFLINE=1).
    # The bridge runs in python/face-venv (no app. imports), so env vars are the
    # only clean channel. mlx-models/upscale/realesrgan/ is the vendor location.
    env = os.environ.copy()
    realesrgan_vendor_dir = os.path.join(cfg.MODELS_DIR, "upscale", "realesrgan")
    env["FACE_RESTORE_EXTRA_WEIGHTS_DIRS"] = realesrgan_vendor_dir
    if bool(getattr(cfg, "OFFLINE", False)):
        env["FACE_RESTORE_OFFLINE"] = "1"

    print(f"[facerestore] spawning face-venv bridge ({model}, fidelity={fidelity}, "
          f"bg_upsampler={bg_upsampler})...", file=sys.stderr)
    proc = subprocess.run(argv, cwd=cfg.REPO_DIR, capture_output=True, text=True, env=env)
    sys.stderr.write(proc.stderr)
    manifest = _parse_manifest(proc.stdout)
    if proc.returncode != 0 or not manifest or not manifest.get("ok"):
        err = (manifest or {}).get("error", f"bridge exited {proc.returncode}")
        print(f"ERROR: face restore failed: {err}", file=sys.stderr)
        sys.exit(2)

    # The bridge writes the absolute out_path it used; surface that canonical path.
    final_out = manifest.get("output", out_path)
    print(f"\n[facerestore] model={manifest.get('model')} "
          f"faces={manifest.get('num_faces')} device={manifest.get('device')}")
    print(f"[facerestore] Saved: {final_out}")


def _parse_manifest(stdout: str) -> dict | None:
    """Extract the JSON manifest the bridge emits after its marker line."""
    idx = stdout.rfind(_BRIDGE_MANIFEST_MARKER)
    if idx < 0:
        return None
    tail = stdout[idx + len(_BRIDGE_MANIFEST_MARKER):].strip()
    for line in reversed(tail.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                import json

                return json.loads(line)
            except Exception:
                return None
    return None
