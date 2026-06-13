"""animate — frame-to-frame animation with ControlNet guidance (coming soon)."""

import argparse
import sys
from app.commands._shared import add_common_generation_args

PARSER_META = {
    "help": "Frame-to-frame animation with ControlNet guidance (coming soon)",
    "description": (
        "Generate animated sequences by interpolating between keyframes,\n"
        "optionally guided by ControlNet (pose, depth, canny).\n"
        "⚠  Not yet implemented — this stub defines the future CLI interface.\n\n"
        "Planned usage:\n"
        "  run.py animate --prompt 'dancing' --control-image pose.png --control-type pose\n"
        "  run.py animate --prompt '...' --input-image start.png --frames 24 --fps 12"
    ),
}


def add_args(parser: argparse.ArgumentParser) -> None:
    add_common_generation_args(parser)

    parser.add_argument("--width", type=int, default=640, help="Frame width")
    parser.add_argument("--height", type=int, default=960, help="Frame height")

    # Animation-specific
    parser.add_argument("--frames", type=int, default=24,
                        help="Number of frames to generate (default: 24)")
    parser.add_argument("--fps", type=int, default=12,
                        help="Output frames per second (default: 12)")

    # Input / conditioning
    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Starting keyframe image (optional)")

    # ControlNet (future)
    parser.add_argument("--control-image", type=str, default=None, metavar="PATH",
                        help="ControlNet conditioning image (pose skeleton, depth map, edge map)")
    parser.add_argument("--control-type", type=str, default=None,
                        choices=["pose", "depth", "canny", "normal"],
                        help="ControlNet type: pose | depth | canny | normal")
    parser.add_argument("--control-strength", type=float, default=1.0,
                        help="ControlNet conditioning strength (default: 1.0)")


def run(args: argparse.Namespace) -> None:
    print("Frame-to-frame animation is not yet implemented.")
    print("Planned: ControlNet-guided animation on Apple Silicon.")
    print("Track progress: python/mlx-movie-director/docs/todo.md")
    sys.exit(0)
