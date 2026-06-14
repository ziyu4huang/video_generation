"""image-t2i — T2I sub-action for 'run.py image t2i'.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_t2i_args(parser)  — register T2I-specific CLI arguments
  run_t2i(args)         — execute T2I generation
"""

import argparse

from app.commands._shared import execute_generation, execute_ab_test, apply_draft_overrides
from app.run_config import RunConfig

_PIPELINE_DEFAULT_STEPS = {"zimage": 9, "flux2-klein": 4}

# Default prompt for bare `--self-test` (no test name). Named self-tests (e.g.
# --self-test vae:ultraflux) are routed to the review selftest dispatcher in
# image.py before reaching run_t2i; only bare --self-test falls through here.
# Inject a standard portrait prompt so the pipeline runs end-to-end instead of
# failing with "No prompt provided".
_T2I_DEFAULT_PROMPT = (
    "A young woman standing in a simple pose, facing the camera, wearing "
    "casual clothes, clean white background, studio lighting, high quality "
    "portrait photography."
)


def add_t2i_args(parser: argparse.ArgumentParser) -> None:
    """Register T2I-specific arguments on an argparse parser."""
    parser.add_argument("--width", type=int, default=None,
                        help="Image width in pixels (default: 640)")
    parser.add_argument("--height", type=int, default=None,
                        help="Image height in pixels (default: 960)")
    parser.add_argument(
        "--pipeline", choices=["zimage", "flux2-klein", "auto"], default="zimage",
        help="Pipeline: 'zimage' (Moody 12.6 DPO, ~14s/9steps) or "
             "'flux2-klein' (Klein 9B, ~40s/4steps, better for consistent characters)",
    )
    parser.add_argument(
        "--ab-test", action="store_true", default=False,
        help="Generate with both 'zimage' and 'flux2-klein' pipelines then "
             "open manifest review for A/B comparison",
    )
    # Flux2-Klein model options (used by t2i with flux2-klein and by angle)
    parser.add_argument(
        "--variant", choices=["4b", "9b"], default="9b",
        help="Klein model variant (default: 9b; use 4b for lower memory)",
    )
    parser.add_argument(
        "--transformer", default="klein-9b", metavar="NAME",
        help="Transformer instance dir under models/transformer/ (default: klein-9b)",
    )
    parser.add_argument(
        "--flux2-model-path", default=None, metavar="PATH",
        help="Local Klein model path (HF dir layout). Omit to auto-download.",
    )
    parser.add_argument(
        "--quantize", type=int, choices=[4, 8], default=None, metavar="BITS",
        help="Quantization bits for HF download mode (4 or 8).",
    )


def run_t2i(args: argparse.Namespace) -> None:
    """Execute T2I generation. Called by image.py dispatcher."""
    pipeline_type = getattr(args, "pipeline", "zimage")

    apply_draft_overrides(args)

    # Bare --self-test (no test name) falls through to here after image.py routes
    # only named tests to the review dispatcher. Inject a default prompt so the
    # pipeline runs end-to-end instead of failing with "No prompt provided".
    if getattr(args, "self_test", False) is True and not getattr(args, "prompt", None) \
            and not getattr(args, "prompt_file", None):
        args.prompt = _T2I_DEFAULT_PROMPT

    if args.steps is None:
        args.steps = _PIPELINE_DEFAULT_STEPS.get(pipeline_type, 9)
    # Apply t2i defaults for shared args (profile resolves its own)
    if args.width is None:
        args.width = 640
    if args.height is None:
        args.height = 960
    run_config = RunConfig.from_args(args, command="image generate")
    json_summary = getattr(args, "json_summary", False)

    if getattr(args, "ab_test", False):
        execute_ab_test(run_config, json_summary=json_summary)
    else:
        execute_generation(run_config, pipeline_type=pipeline_type,
                           json_summary=json_summary)
