"""schema-defaults — Export command schema defaults as JSON for GUI sync.

Prints a JSON object mapping each GUI action to its effective default values.
No model loading, no generation — safe to call at server startup.

Usage:
  run.py schema-defaults
"""

import importlib
import json
import sys

PARSER_META = {
    "help": "Output command schema defaults as JSON (for GUI sync)",
    "description": "Print action defaults as JSON. No model loading.",
}


def add_args(parser):
    pass


def run(args):
    json.dump(_build(), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _build():
    # Load pipeline step defaults from image-t2i without importing mlx
    _t2i = importlib.import_module("app.commands.image-t2i")
    pipeline_steps = dict(_t2i._PIPELINE_DEFAULT_STEPS)

    return {
        "t2i": {
            "pipeline": "zimage",
            "width": 640,
            "height": 960,
            "seed": 42,
            "lora_scale": 1.0,
            "count": 1,
            "draft": False,
            "upscale": False,
            "pipeline_steps": pipeline_steps,
        },
        "i2i": {
            "pipeline": "zimage",
            "denoise_strength": 0.4,
            "controlnet_strength": 1.0,
            "seed": 42,
            "pipeline_steps": pipeline_steps,
        },
        "workflow": {
            "pipeline": "zimage",
            "width": 640,
            "height": 960,
            "seed": 42,
            "face_detail": False,
            "film_grain": 0.0,
            "sharpening": 0.0,
            "upscale": False,
        },
        "anime2real": {
            "realism_style": "civitai-chinese",
            "ref_strength": 1.0,
            "anime2real_ref_count": 1,
            "steps": 8,
            "seed": 42,
        },
        "controlnet": {
            "controlnet_type": "canny",
            "controlnet_strength": 1.0,
            "seed": 42,
            "pipeline_steps": pipeline_steps,
        },
        "faceswap": {
            "mode": "head",
            "seed": 42,
        },
        "expansion": {
            "pixels": 1024,
            "expansion_feather": 96,
            "overlap": 128,
            "longest": 1024,
            "expansion_ref_strength": 1.0,
            "seed": 42,
        },
        "angle": {
            "azimuth": 90,
            "elevation": 0,
        },
        "profile": {
            "views": "front,back,side",
            "ratio": "standing",
            "ref_count": 3,
            "seed": 42,
            "pipeline_steps": pipeline_steps,
        },
        "swap": {
            "sam_threshold": 0.3,
            "feather": 10,
        },
    }
