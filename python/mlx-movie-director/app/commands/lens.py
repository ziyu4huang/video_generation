"""lens — text-to-image with Microsoft Lens 3.8B (pure MLX), invoked via
``run.py image t2i --pipeline lens``.

Lens is an independent model family from the Flux/Z-Image pipelines: a 3.8B
dual-stream MMDiT (Flux-derived) paired with the GPT-OSS-20B MoE text encoder
and the Flux2 VAE. It runs entirely in MLX on Apple Silicon and does NOT share
the Flux/Z-Image surface — no LoRA, no ControlNet, no i2i, no latent-upscale —
so it is a ``--pipeline lens`` option of ``image t2i`` (alongside ``zimage`` and
``flux2-klein``), not a sub-action of its own.

Latents are Flux2 VAE 32-ch at H//8 × W//8, patchified 2×2 → 128-ch at
H//16 × W//16. width/height MUST be divisible by 16 (enforced in run_t2i).

Usage:
  run.py image t2i --pipeline lens --prompt 'a cute corgi puppy, photorealistic'
  run.py image t2i --pipeline lens --prompt '...' --width 1024 --height 1024
  run.py image t2i --pipeline lens --self-test                 # built-in prompt
  run.py image t2i --pipeline lens --prompt '...' --json-summary
"""

import argparse
import os
import sys

from app import config as cfg
from app.commands._shared import make_output_paths, run_session, seed_sequence

# Built-in self-test prompt (used by bare --self-test). A concrete, verifiable
# subject so a VLM caption check has an identity to match against.
_LENS_SELF_TEST_PROMPT = (
    "a cute corgi puppy sitting in a sunny garden, highly detailed, photorealistic"
)


# Lens supports ONLY two base resolutions (1024 and 1440) crossed with nine
# aspect ratios, per microsoft/Lens lens/resolution.py. Lens is a high-res
# model — its gallery is entirely at these buckets, and resolutions below the
# 1024 base (e.g. 640×960) are out-of-distribution → soft, low-detail, weak
# anatomy. We snap non-bucket (width, height) to the nearest bucket so the model
# always runs on a resolution it was trained on. Values are (width, height).
_LENS_BUCKETS: set[tuple[int, int]] = {
    # base 1024
    (736, 1472), (768, 1376), (832, 1248), (864, 1152), (1024, 1024),
    (1152, 864), (1248, 832), (1376, 768), (1472, 736),
    # base 1440
    (1040, 2080), (1088, 1936), (1168, 1760), (1216, 1616), (1440, 1440),
    (1616, 1216), (1760, 1168), (1936, 1088), (2080, 1040),
}


def _snap_to_lens_bucket(width: int, height: int) -> tuple[tuple[int, int], bool]:
    """Return ((width, height), is_exact_bucket).

    If ``(width, height)`` is a Lens bucket, return it unchanged. Otherwise snap
    to the nearest bucket: closest aspect ratio first, then prefer the smallest
    area >= requested (so we never downscale below the requested detail level).
    e.g. 640×960 (2:3) → 832×1248 (the base-1024 2:3 bucket).
    """
    if (width, height) in _LENS_BUCKETS:
        return (width, height), True
    req_ratio = width / height
    req_area = width * height

    def _key(b: tuple[int, int]):
        bw, bh = b
        area = bw * bh
        return (
            abs((bw / bh) - req_ratio),   # closest aspect ratio first
            0 if area >= req_area else 1,  # prefer not to downscale
            area,                          # then smallest sufficient area
        )

    return min(_LENS_BUCKETS, key=_key), False


def run_lens(args: argparse.Namespace, json_summary: bool = False) -> str:
    """Execute Lens T2I generation.

    Called by ``image-t2i.run_t2i`` when ``--pipeline lens``. Writes run.json +
    manifest.json (like zimage/flux2-klein via run_session) so the output is
    gallery-consistent and replay-able. Returns the manifest path on success.

    Expects ``run_t2i`` to have already set Lens defaults (width/height 512,
    steps 20) and validated ÷16 — this function trusts those and focuses on
    prompt resolution, generation, and manifest writing.
    """
    # Resolve prompt: --prompt-file > --prompt > --self-test default
    prompt = getattr(args, "prompt", None)
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file:
        with open(prompt_file, "r") as f:
            prompt = f.read().strip()
    if not prompt:
        if getattr(args, "self_test", False):
            prompt = _LENS_SELF_TEST_PROMPT
            print(f"[lens] self-test prompt: {prompt!r}")
        else:
            print("ERROR: --prompt (or --prompt-file) is required, or use --self-test.",
                  file=sys.stderr)
            sys.exit(1)

    seeds = seed_sequence(args)
    batch = len(seeds)

    # Lens cfg-scale default is 5.0 (microsoft/Lens inference.py argparse
    # default). The shared --cfg-scale arg defaults to None (unused by
    # zimage/flux2); resolve it here. Keep the None sentinel — see the
    # argparse-sentinel-for-user-override lesson (cfg_scale was previously
    # bitten by magic-number comparison).
    cfg_scale = getattr(args, "cfg_scale", None)
    if cfg_scale is None:
        cfg_scale = 5.0

    # Snap non-bucket resolutions to the nearest Lens bucket (see
    # _LENS_BUCKETS). Lens only supports 1024/1440 bases; OOD resolutions
    # produce soft, low-detail output. Update args in place so run.json records
    # the ACTUAL bucket used in outputs[] (argv still shows what was typed).
    (args.width, args.height), _bucket_exact = _snap_to_lens_bucket(args.width, args.height)
    if not _bucket_exact:
        print(
            "[lens] WARNING: requested resolution is not a Lens bucket (Lens "
            "supports only 1024/1440 bases × 9 aspect ratios); snapped to "
            f"nearest bucket {args.width}×{args.height}. "
            "See microsoft/Lens lens/resolution.py."
        )

    print(f"[lens] {args.width}×{args.height}  steps={args.steps}  cfg={cfg_scale}  "
          f"seeds={seeds}")

    from app.run_config import RunConfig
    run_config = RunConfig.from_args(args, command="image t2i")
    paths = make_output_paths(ext=".png")

    # run_session writes run.json + manifest.json on success (and an error
    # manifest + sys.exit(1) on exception), mirroring execute_generation. The
    # LensPipeline generation loop is unchanged from the validated 9/9/9 path.
    with run_session(paths, run_config=run_config, json_summary=json_summary) as ctx:
        # Lazy import so `run.py image t2i --pipeline lens --help` (and schema
        # introspection) stays fast and does not require MLX/model weights.
        from app.lens_pipeline import LensPipeline

        pipe = LensPipeline(num_steps=args.steps, cfg_scale=cfg_scale)

        outputs: list[dict] = []
        last_timings: dict = {}
        for i, seed in enumerate(seeds):
            print(f"[lens] === generating {i + 1}/{batch}  seed={seed} ===")
            result = pipe.generate(
                prompt=prompt,
                seed=seed,
                width=args.width,
                height=args.height,
            )
            last_timings = dict(result.timings)

            suffix = f"_s{seed}" if batch > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{paths.base_name}{suffix}.png")
            result.image.save(out_path)
            print(f"[lens] saved: {out_path}  ({result.timings.get('total', 0):.1f}s)")
            outputs.append({
                "path": out_path,
                "seed": seed,
                "size_bytes": os.path.getsize(out_path),
                "width": result.image.width,
                "height": result.image.height,
            })

        ctx["outputs"] = outputs
        ctx["timings"] = last_timings
        # Lens model fingerprint: paths only (no hashing — 16 GB INT4 files).
        # Reproducibility is via argv + seed recorded in run.json.
        ctx["models"] = {
            "pipeline": "lens",
            "text_encoder": pipe.te_path,
            "unet": pipe.unet_path,
            "vae": pipe.vae_path,
        }

    return paths.manifest_file
