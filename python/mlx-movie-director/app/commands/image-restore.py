"""image-restore — detail-preserving I2I redraw to fix lost quality.

Thin wrapper over image-i2i with ControlNet disabled and restoration-focused defaults.
Primary use: fix middle frames in video-relay that lose detail due to compression.

Examples:
  run.py image restore --input-image output/frame.png
  run.py image restore --input-image frame.png --prompt "sharp eyes, detailed face, natural skin texture" --denoise-strength 0.35
  run.py image restore --input-image frame.png --pipeline flux2-klein --denoise-strength 0.4
"""
import importlib

_i2i = importlib.import_module("app.commands.image-i2i")

PARSER_META = {
    "help": "Detail-preserving I2I redraw (fixes lost detail in video-relay frames)",
    "description": __doc__,
}


def add_restore_args(parser):
    pass  # all args already registered by add_i2i_args() and add_common_generation_args()


def run_restore(args):
    args.reference_image = None  # no ControlNet for restore
    _i2i.run_i2i(args)
