"""ideogram4 — text-to-image with Ideogram 4 (pure MLX, fork-free NF4), invoked
via ``run.py image t2i --pipeline ideogram4``.

Ideogram 4 is a 9.3B×2 flow-matching DiT (conditional + unconditional, asymmetric
CFG) with a modified Qwen3-VL 8.8B text encoder and the Flux2 KL-VAE. Its stand-
out strength is rendering LEGIBLE TEXT inside images, so this pipeline is tuned
for posters / slides / deep image-text work: aspect presets, the V4 quality
preset default, and a resolution-adaptive scheduler.

NF4 weights are dequantized at load by ``app.ideogram4_nf4`` on STOCK mlx — no
custom MLX fork (which would conflict with zimage/flux2/lens/ltx in the shared
venv). It does NOT share the Flux/Z-Image surface (no LoRA / ControlNet / i2i).

width/height MUST be divisible by 16 (Flux2 VAE /8 × patchify /2); enforced in
run_t2i and re-checked here.

Usage:
  run.py image t2i --pipeline ideogram4 --prompt 'poster, bold title "SALE"'
  run.py image t2i --pipeline ideogram4 --aspect slide --ideogram-preset V4_QUALITY_48
  run.py image t2i --pipeline ideogram4 --self-test
"""

import argparse
import os
import sys
from typing import Any

from app import config as cfg
from app.commands._shared import make_output_paths, run_session, seed_sequence

# Self-test prompt — a poster with clear, verifiable title text so a VLM caption
# check has legibility to score against. Latin text renders most reliably in ideogram.
_IDEOGRAM4_SELF_TEST_PROMPT = (
    'A vibrant promotional poster, large bold title text "SUMMER SALE" at the top, '
    'subtitle "Up to 50% Off Everything" below it, "July 2026" at the bottom, '
    "colorful gradient background, clean modern graphic design, high contrast, "
    "centered composition"
)

# Aspect-ratio presets for poster/slide work. The scheduler's resolution-adaptive
# mean (get_schedule_for_resolution) auto-adjusts for non-square shapes, so a 16:9
# slide is scheduled correctly without extra config. All dims are multiples of 16.
ASPECT_PRESETS: dict[str, tuple[int, int]] = {
    "slide": (1920, 1088),   # ~16:9 presentation slide (1088 = 68×16; 1080 isn't /16)
    "poster": (1248, 1664),  # ~A4-ish portrait poster (1248×1664, both /16)
    "square": (1024, 1024),
}


def resolve_aspect(aspect: str | None, default_w: int, default_h: int) -> tuple[int, int]:
    """Resolve ``--ideogram-aspect`` (slide|poster|square|WxH|W:H) to (width, height).

    None/empty returns the passed defaults unchanged. Explicit WxH/W:H values are
    ABSOLUTE pixel dims (not ratios) snapped to the nearest multiple of 16; for a
    ratio shortcut use a named preset (e.g. ``slide`` ≈ 16:9). Used by
    image-t2i.run_t2i to map the shortcut onto --width/--height before dispatching.
    """
    if not aspect:
        return default_w, default_h
    if aspect in ASPECT_PRESETS:
        return ASPECT_PRESETS[aspect]
    sep = "x" if "x" in aspect else ":"
    try:
        w, h = (int(x) for x in aspect.lower().split(sep))
    except ValueError:
        raise SystemExit(
            f"ERROR [ideogram4]: invalid --ideogram-aspect {aspect!r} "
            "(use slide | poster | square | WxH | W:H)."
        )
    # Snap to the NEAREST multiple of 16 (Flux2 VAE /8 × patchify /2).
    w = max(round(w / 16) * 16, 16)
    h = max(round(h / 16) * 16, 16)
    if w < 256 or h < 256:
        raise SystemExit(
            f"ERROR [ideogram4]: --ideogram-aspect {aspect!r} resolves to {w}x{h}, too "
            f"small. Use a named preset (slide|poster|square) or explicit dims like "
            f"1920x1088 (ratios such as '16:9' are not accepted here — 'slide' is 16:9)."
        )
    return w, h


def run_ideogram4(args: argparse.Namespace, json_summary: bool = False) -> str:
    """Execute Ideogram 4 T2I generation.

    Called by ``image-t2i.run_t2i`` when ``--pipeline ideogram4``. Writes run.json +
    manifest.json via run_session (gallery-consistent + replay-able). Returns the
    manifest path on success.

    The preset (not bare --steps) drives step count + the asymmetric guidance
    schedule; ``--steps`` is an optional override. Expects run_t2i to have validated
    width/height ÷16.
    """
    # Resolve prompt: --prompt-file > --prompt > --self-test default
    prompt = getattr(args, "prompt", None)
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file:
        with open(prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        if getattr(args, "self_test", False):
            prompt = _IDEOGRAM4_SELF_TEST_PROMPT
            print(f"[ideogram4] self-test prompt: {prompt!r}")
        else:
            print(
                "ERROR: --prompt (or --prompt-file) is required, or use --self-test.",
                file=sys.stderr,
            )
            sys.exit(1)

    seeds = seed_sequence(args)
    preset = getattr(args, "ideogram_preset", None) or "V4_DEFAULT_20"
    # None -> pipeline resolves from the preset (DEFAULT_20=20, QUALITY_48=48, TURBO_12=12).
    steps_override = getattr(args, "steps", None)

    for dim in ("width", "height"):
        val = getattr(args, dim)
        if not isinstance(val, int) or val <= 0 or val % 16 != 0:
            print(
                f"ERROR [ideogram4]: --{dim}={val} must be a positive multiple of 16.",
                file=sys.stderr,
            )
            sys.exit(1)

    print(
        f"[ideogram4] {args.width}x{args.height}  preset={preset}  "
        f"steps={'preset' if steps_override is None else steps_override}  seeds={seeds}"
    )

    from app.run_config import RunConfig

    run_config = RunConfig.from_args(args, command="image t2i")
    paths = make_output_paths(ext=".png")

    with run_session(paths, run_config=run_config, json_summary=json_summary) as ctx:
        # Lazy import so --help / schema introspection stay fast and weight-free.
        from app.ideogram4_pipeline import Ideogram4Pipeline

        pipe = Ideogram4Pipeline()
        results = pipe.generate(
            prompt=prompt,
            seeds=seeds,
            width=args.width,
            height=args.height,
            preset=preset,
            num_steps=steps_override,
        )

        outputs: list[dict[str, Any]] = []
        last_timings: dict[str, float] = {}
        for seed, result in zip(seeds, results):
            suffix = f"_s{seed}" if len(seeds) > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{paths.base_name}{suffix}.png")
            result.image.save(out_path)
            print(
                f"[ideogram4] saved: {out_path}  ({result.timings.get('total', 0):.1f}s)",
                flush=True,
            )
            outputs.append(
                {
                    "path": out_path,
                    "seed": seed,
                    "size_bytes": os.path.getsize(out_path),
                    "width": result.image.width,
                    "height": result.image.height,
                }
            )
            last_timings = dict(result.timings)

        ctx["outputs"] = outputs
        ctx["timings"] = last_timings
        # Paths only (NF4 fingerprints are the externalized <md5> symlinks). Replay
        # via `run.py replay <run.json>`; reproducibility is the structured fields + seed.
        ctx["models"] = {
            "pipeline": "ideogram4",
            "preset": preset,
            "text_encoder": pipe.te_dir,
            "cond_transformer": pipe.cond_dir,
            "uncond_transformer": pipe.uncond_dir,
            "vae": pipe.vae_dir,
        }

    return paths.manifest_file
