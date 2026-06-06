"""video — LTX 22B video generation (coming soon)."""

import sys
from app.commands._shared import add_common_generation_args

PARSER_META = {
    "help": "LTX 22B video generation from text/image (coming soon)",
    "description": (
        "Generate videos using LTX-2.3 22B bf16 on Apple Silicon.\n"
        "⚠  Not yet implemented — this stub defines the future CLI interface.\n\n"
        "Planned usage:\n"
        "  run.py video --prompt 'cinematic scene' --frames 49 --fps 24\n"
        "  run.py video --prompt '...' --input-image keyframe.png --frames 49"
    ),
}


def add_args(parser):
    add_common_generation_args(parser)

    # Resolution
    parser.add_argument("--width", type=int, default=768,
                        help="Video width (default: 768)")
    parser.add_argument("--height", type=int, default=512,
                        help="Video height (default: 512)")

    # Video-specific
    parser.add_argument("--frames", type=int, default=49,
                        help="Number of frames to generate (default: 49)")
    parser.add_argument("--fps", type=int, default=24,
                        help="Output frames per second (default: 24)")

    # Optional conditioning frame
    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Conditioning keyframe image (optional)")

    # Model path override
    parser.add_argument("--video-model", type=str, default=None, metavar="PATH",
                        help="Path to LTX 22B model directory (default: auto-detect from comfyui_data)")


def run(args):
    print("Video generation is not yet implemented.")
    print("Planned: LTX-2.3 22B MLX pipeline for Apple Silicon.")
    print("Track progress: python/mlx-movie-director/docs/todo.md")
    sys.exit(0)
