"""schema-defaults — Export command schema defaults + self-test metadata as JSON for GUI sync.

Prints a JSON object mapping each GUI action to its effective default values
and available self-test names. No model loading, no generation — safe to call
at server startup.

Usage:
  run.py schema-defaults
"""

import importlib
import json
import sys

PARSER_META = {
    "help": "Output command schema defaults as JSON (for GUI sync)",
    "description": "Print action defaults + self-test names as JSON. No model loading.",
}


def add_args(parser):
    pass


def run(args):
    json.dump(_build(), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


# Mapping from test type → GUI action name
_TEST_TYPE_TO_ACTION = {
    "t2i": "t2i",
    "vae": "t2i",
    "lora": "t2i",
    "lora-sweep": "t2i",
    "workflow": "workflow",
    "lora-i2i": "i2i",
    "controlnet-i2i": "i2i",
    "lora-ref": "anime2real",
    "faceswap": "faceswap",
    "swap": "swap",
    "swap-all": "swap",
    "profile": "profile",
    "expansion": "expansion",
    "video": "video-generate",
    "flf2v": "video-generate",
    "nomodel": "workflow",
}


def _build():
    # Load pipeline step defaults from image-t2i without importing mlx
    _t2i = importlib.import_module("app.commands.image-t2i")
    pipeline_steps = dict(_t2i._PIPELINE_DEFAULT_STEPS)

    # Build self-test metadata grouped by GUI action
    self_tests = _build_self_tests()

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
            "self_tests": self_tests.get("t2i", []),
        },
        "i2i": {
            "pipeline": "zimage",
            "denoise_strength": 0.4,
            "controlnet_strength": 1.0,
            "seed": 42,
            "pipeline_steps": pipeline_steps,
            "self_tests": self_tests.get("i2i", []),
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
            "self_tests": self_tests.get("workflow", []),
        },
        "anime2real": {
            "realism_style": "civitai-chinese",
            "ref_strength": 1.0,
            "anime2real_ref_count": 1,
            "steps": 8,
            "seed": 42,
            "self_tests": self_tests.get("anime2real", []),
        },
        "controlnet": {
            "controlnet_type": "canny",
            "controlnet_strength": 1.0,
            "seed": 42,
            "pipeline_steps": pipeline_steps,
            "self_tests": self_tests.get("controlnet", []),
        },
        "faceswap": {
            "mode": "head",
            "seed": 42,
            "self_tests": self_tests.get("faceswap", []),
        },
        "expansion": {
            "pixels": 1024,
            "expansion_feather": 96,
            "overlap": 128,
            "longest": 1024,
            "expansion_ref_strength": 1.0,
            "seed": 42,
            "self_tests": self_tests.get("expansion", []),
        },
        "angle": {
            "azimuth": 90,
            "elevation": 0,
            "self_tests": self_tests.get("angle", []),
        },
        "profile": {
            "views": "front,back,side",
            "ratio": "standing",
            "ref_count": 3,
            "seed": 42,
            "pipeline_steps": pipeline_steps,
            "self_tests": self_tests.get("profile", []),
        },
        "swap": {
            "sam_threshold": 0.3,
            "feather": 10,
            "self_tests": self_tests.get("swap", []),
        },

        # ─── Video ─────────────────────────────────────────────────────
        "video-generate": {
            "width": 704,
            "height": 448,
            "frames": 97,
            "fps": 24.0,
            "seed": 42,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
            "begin_strength": 1.0,
            "end_strength": 1.0,
            "lora_scale": 1.0,
            "low_ram": False,
            "hq": False,
            "distilled": False,
            "teacache": False,
            "temporal_upscale": False,
            "enhance_prompt": False,
            "self_tests": self_tests.get("video-generate", []),
        },
        "video-restore": {
            "seed": 42,
            "restore_scale": 1.0,
            "restore_cond_strength": 1.0,
            "restoration_scale": 1.0,
            "upscale_scale": 1.0,
            "no_upscale_lora": False,
            "restore_no_audio": False,
            "self_tests": self_tests.get("video-restore", []),
        },
    }


def _build_self_tests():
    """Import test registry and group tests by GUI action.

    Returns dict: { action: [{"name": str, "desc": str}, ...] }
    """
    try:
        mod = importlib.import_module("app.test_prompts_image")
        all_tests = getattr(mod, "_ALL_TESTS", {})
    except Exception:
        return {}

    result = {}
    for name, cfg in all_tests.items():
        test_type = cfg.get("type", "")
        action = _TEST_TYPE_TO_ACTION.get(test_type)
        if not action:
            continue
        entry = {"name": name, "desc": cfg.get("description", name)}
        result.setdefault(action, []).append(entry)

    return result
