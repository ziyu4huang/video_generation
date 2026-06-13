"""Argparse helpers — guarded argument registration, shared CLI args.

Split from _shared.py (was ~903 lines).
"""

import argparse

from app import config as cfg


def _arg_registered(parser: argparse.ArgumentParser, dest: str) -> bool:
    """Check if an argument with the given dest is already registered on the parser."""
    return any(getattr(a, 'dest', None) == dest for a in parser._actions)


def _option_registered(parser: argparse.ArgumentParser, option: str) -> bool:
    """Check if an option string (e.g. '--input') is already registered."""
    return any(option in getattr(a, 'option_strings', []) for a in parser._actions)


def add_common_generation_args(parser: argparse.ArgumentParser) -> None:
    """Register args shared by generate, refine, and video subcommands.

    Uses guards to avoid conflicts when sub-command modules register
    overlapping args (--steps, --seed, --prompt, etc.) on the same parser.
    """
    if not _arg_registered(parser, "prompt"):
        prompt_grp = parser.add_mutually_exclusive_group()
        prompt_grp.add_argument("--prompt", type=str, help="Text prompt")
        prompt_grp.add_argument("--prompt-file", type=str,
                                help="Path to a text file containing the prompt")

    if not _arg_registered(parser, "steps"):
        parser.add_argument("--steps", type=int, default=None,
                            help="Denoising steps (default: 9 for zimage, 4 for flux2-klein)")
    if not _arg_registered(parser, "seed"):
        parser.add_argument("--seed", type=int, default=42,
                            help="Random seed (default: 42)")
    if not _arg_registered(parser, "self_test"):
        parser.add_argument("--self-test", nargs="*", default=None,
                            dest="self_test", metavar="TEST_ID",
                            help="Run named self-test (e.g. --self-test ultraflux), "
                                 "bare --self-test for the command default, "
                                 "or multiple names for a unified multi-report")
    if not _arg_registered(parser, "lora_path"):
        parser.add_argument("--lora-path", type=str, default=None,
                            help="LoRA weights: full path, dir, or short name "
                                 "(e.g. 'klein-slider-anatomy') — auto-resolved from models/lora/")
    if not _arg_registered(parser, "lora_scale"):
        # CAUTION: Some subcommands (e.g. anime2real) register their own
        # dedicated --lora-scale variant with default=None BEFORE this
        # function runs.  When that happens, _arg_registered returns True
        # and this block is skipped — the shared --lora-scale default=1.0
        # is NOT applied.  Other commands must use
        #   getattr(args, "lora_scale", None) or 1.0
        # to safely handle the None case.
        parser.add_argument("--lora-scale", type=float, default=1.0,
                            help="LoRA conditioning strength 0–2 (default: 1.0; "
                                 "try 0.7–0.9 to soften style influence)")
    if not _arg_registered(parser, "vae_path"):
        parser.add_argument("--vae-path", type=str, default=None,
                            help="VAE weights: full dir path or short name "
                                 "(e.g. 'ultraflux') — auto-resolved from models/vae/")

    # img2img / I2I (unified with t2i via --input)
    # NOTE: --input may already be registered by add_angle_args() with dest="input"
    if not _option_registered(parser, "--input"):
        parser.add_argument("--input", type=str, default=None, dest="input_image",
                            help="Input image for I2I / img2img mode")
    if not _arg_registered(parser, "denoise_strength"):
        parser.add_argument("--denoise-strength", type=float, default=1.0,
                            help="Denoise strength for I2I (0.0 = keep input, 1.0 = full redraw)")
    if not _arg_registered(parser, "latent_upscale"):
        parser.add_argument("--latent-upscale", type=float, default=1.0,
                            help="Latent space upscale factor before denoising (default: 1.0)")

    # Draft mode (quick preview)
    if not _arg_registered(parser, "draft"):
        parser.add_argument("--draft", action="store_true", default=False,
                            help="Draft mode: fewer steps (4), smaller resolution (512x512)")

    # Post-process upscale
    if not _arg_registered(parser, "upscale"):
        parser.add_argument("--upscale", action="store_true", default=False,
                            help=f"ESRGAN 4× upscale after generation (default model: 4xNomosWebPhoto_RealPLKSR.pth)")
    if not _arg_registered(parser, "upscale_model"):
        parser.add_argument("--upscale-model", type=str, default=None,
                            help="Path to ESRGAN .pth model (overrides default)")
    if not _arg_registered(parser, "upscale_method"):
        parser.add_argument("--upscale-method", choices=["esrgan", "seedvr2"], default="esrgan",
                            help="Upscale method when --upscale is set (default: esrgan)")

    # Batch
    if not _arg_registered(parser, "count"):
        parser.add_argument("--count", type=int, default=1,
                            help="Number of outputs to generate (default: 1). "
                                 "Use with --seed-start for distinct seeds per output.")
    if not _arg_registered(parser, "seed_start"):
        parser.add_argument("--seed-start", type=int, default=None,
                            help="First seed for a batch run; overrides --seed. "
                             "Output i uses seed seed_start+i.")

    # Machine-readable output for automation / CI
    if not _arg_registered(parser, "json_summary"):
        parser.add_argument("--json-summary", action="store_true", default=False,
                            dest="json_summary",
                            help="Print a JSON summary line to stdout after generation "
                                 "(for workflow integration)")
