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

    # Lens cfg-scale default is 4.0 (per microsoft/Lens). The shared --cfg-scale
    # arg defaults to None (unused by zimage/flux2); resolve it here.
    cfg_scale = getattr(args, "cfg_scale", None)
    if cfg_scale is None:
        cfg_scale = 4.0

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
