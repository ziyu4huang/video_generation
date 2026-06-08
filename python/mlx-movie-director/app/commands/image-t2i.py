"""image-t2i — T2I sub-action for 'run.py image t2i'.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_t2i_args(parser)  — register T2I-specific CLI arguments
  run_t2i(args)         — execute T2I generation
"""

from app.commands._shared import execute_generation, execute_ab_test
from app.run_config import RunConfig

_PIPELINE_DEFAULT_STEPS = {"zimage": 9, "flux2-klein": 4}


def add_t2i_args(parser):
    """Register T2I-specific arguments on an argparse parser."""
    parser.add_argument("--width", type=int, default=None,
                        help="Image width in pixels (default: 640)")
    parser.add_argument("--height", type=int, default=None,
                        help="Image height in pixels (default: 960)")
    parser.add_argument(
        "--pipeline", choices=["zimage", "flux2-klein", "auto"], default="zimage",
        help="Generation pipeline: zimage (default) or flux2-klein",
    )
    parser.add_argument(
        "--ab-test", action="store_true", default=False,
        help="Run both pipelines sequentially for A/B comparison",
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


def run_t2i(args):
    """Execute T2I generation. Called by image.py dispatcher."""
    pipeline_type = getattr(args, "pipeline", "zimage")
    if args.steps is None:
        args.steps = _PIPELINE_DEFAULT_STEPS.get(pipeline_type, 9)
    # Apply t2i defaults for shared args (profile resolves its own)
    if args.width is None:
        args.width = 640
    if args.height is None:
        args.height = 960
    run_config = RunConfig.from_args(args, command="image generate")
    if getattr(args, "ab_test", False):
        execute_ab_test(run_config)
    else:
        execute_generation(run_config, pipeline_type=pipeline_type)
