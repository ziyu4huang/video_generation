"""schema-defaults — Export command schema defaults + self-test metadata as JSON for GUI sync.

Prints a JSON object mapping each GUI action to its effective default values
and available self-test names. No model loading, no generation — safe to call
at server startup.

Usage:
  run.py schema-defaults
"""

import argparse
import importlib
import json
import sys

from app.transformer_defaults import all_transformer_defaults

PARSER_META = {
    "help": "Output command schema defaults as JSON (for GUI sync)",
    "description": "Print action defaults + self-test names as JSON. No model loading.",
}


def add_args(parser: argparse.ArgumentParser) -> None:
    pass


def run(args: argparse.Namespace) -> None:
    json.dump(_build(), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


# Mapping from test type → GUI action name
_TEST_TYPE_TO_ACTION = {
    "t2i": "t2i",
    "vae": "t2i",
    "lora": "t2i",
    "lora-sweep": "t2i",
    "multi-lora": "t2i",
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
    pipeline_resolution = {k: list(v) for k, v in _t2i._PIPELINE_DEFAULT_RESOLUTION.items()}

    # Angle presets (named → [azimuth, elevation]) drive the GUI --angle dropdown.
    # Loaded from the command module so the preset names can never drift from what
    # the server resolves (never hardcode in the Bun schema).
    _angle = importlib.import_module("app.commands.image-angle")
    angle_presets = {k: list(v) for k, v in _angle.ANGLE_PRESETS.items()}

    # Build self-test metadata grouped by GUI action
    self_tests = _build_self_tests()

    return {
        "t2i": {
            "pipeline": "zimage",
            "width": 640,
            "height": 960,
            "seed": 777,
            "lora_scale": 1.0,
            "count": 1,
            "draft": False,
            "upscale": False,
            "pipeline_steps": pipeline_steps,
            "pipeline_resolution": pipeline_resolution,
            # T2I-applicable transformers, dynamically enumerated from
            # models/transformer/*/manifest.json (drives the GUI dropdown — never
            # hardcoded in the Bun schema). Tagged with the GUI pipeline so the
            # frontend can filter by the selected pipeline.
            "transformers": _build_t2i_transformers(),
            # Per-transformer built-in params (app/transformer_defaults.py). The GUI
            # applies these when the user picks a transformer (unless already edited).
            "transformer_defaults": all_transformer_defaults(),
            # T2I-compatible VAEs, dynamically enumerated from models/vae/*/manifest.json.
            # One entry per (vae, gui-pipeline) pair; frontend filters by selected pipeline.
            "vaes": _build_vaes(),
            "self_tests": self_tests.get("t2i", []),
        },
        "i2i": {
            "pipeline": "zimage",
            "denoise_strength": 0.4,
            "controlnet_strength": 1.0,
            "seed": 777,
            "pipeline_steps": pipeline_steps,
            "self_tests": self_tests.get("i2i", []),
        },
        "workflow": {
            "pipeline": "zimage",
            "width": 640,
            "height": 960,
            "seed": 777,
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
            "seed": 777,
            "self_tests": self_tests.get("anime2real", []),
        },
        "controlnet": {
            "controlnet_type": "canny",
            "controlnet_strength": 1.0,
            "seed": 777,
            "pipeline_steps": pipeline_steps,
            "self_tests": self_tests.get("controlnet", []),
        },
        "faceswap": {
            "mode": "head",
            "seed": 777,
            "self_tests": self_tests.get("faceswap", []),
        },
        "expansion": {
            "pixels": 1024,
            "expansion_feather": 96,
            "overlap": 128,
            "longest": 1024,
            "expansion_ref_strength": 1.0,
            "seed": 777,
            "self_tests": self_tests.get("expansion", []),
        },
        "angle": {
            "angle": None,
            "azimuth": 90,
            "elevation": 0,
            "ref_count": _angle._ANGLE_DEFAULT_REF_COUNT,
            "transformer": "klein-9b",
            "resolution": None,
            "steps": _angle._ANGLE_DEFAULT_STEPS,
            "seed": 777,
            # Named (azimuth, elevation) presets — drives the GUI --angle dropdown.
            "angle_presets": angle_presets,
            "self_tests": self_tests.get("angle", []),
        },
        "profile": {
            "views": "front,back,side",
            "ratio": "standing",
            "ref_count": 3,
            "seed": 777,
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
            "seed": 777,
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
            "seed": 777,
            "restore_scale": 1.0,
            "restore_cond_strength": 1.0,
            "restoration_scale": 1.0,
            "upscale_scale": 1.0,
            "no_upscale_lora": False,
            "restore_no_audio": False,
            "self_tests": self_tests.get("video-restore", []),
        },
        "video-relay": {
            "width": 704,
            "height": 448,
            "fps": 24.0,
            "seed": 777,
            "cfg_scale": 1.0,
            "stg_scale": 0.0,
            "stage1_steps": 8,
            "stage2_steps": 3,
            "lora_scale": 1.0,
            "distilled": True,
            "low_ram": False,
            "lora_path": "vbvr-ltx2.3",   # best overall: 3★ kitchen + 3★ physics
            "relay_duration": 8.0,
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


# arch → GUI pipeline. Only these archs are offered in the T2I transformer dropdown;
# ltx / seedvr2 / other archs are excluded (not T2I image transformers).
_T2I_ARCH_TO_PIPELINE = {"zimage-turbo": "zimage", "flux2-klein-9b": "flux2-klein"}

# Manifest pipeline names → GUI pipeline names for VAE filtering.
_VAE_MANIFEST_PIPELINE_TO_GUI = {
    "zimage-turbo": "zimage",
    "flux2-klein": "flux2-klein",
    "flux2-klein-edit": "flux2-klein",
}


def _build_vaes():
    """Enumerate T2I-compatible VAEs for the GUI dropdown.

    Returns a list with a leading "Default" entry (value="", no pipeline filter) followed
    by one entry per (vae, gui-pipeline) pair — the same VAE may appear twice if it is
    compatible with both zimage and flux2-klein. The frontend filters by the selected
    pipeline using the same mechanism as the Transformer dropdown.
    """
    from app import config as cfg
    from app.model_registry import ModelRegistry

    out = [{"value": "", "label": "Default"}]
    seen = set()
    try:
        for m in ModelRegistry(cfg.MODELS_DIR).list("vae"):
            name = m.get("name", "")
            manifest_pipelines = m.get("pipeline", [])
            gui_pipelines = sorted({
                _VAE_MANIFEST_PIPELINE_TO_GUI[p]
                for p in manifest_pipelines
                if p in _VAE_MANIFEST_PIPELINE_TO_GUI
            })
            for gui_pipeline in gui_pipelines:
                key = (name, gui_pipeline)
                if key in seen:
                    continue
                seen.add(key)
                out.append({"value": name, "label": name, "pipeline": gui_pipeline})
    except Exception:
        pass
    return out


def _build_t2i_transformers():
    """Enumerate T2I-applicable transformers for the GUI dropdown.

    Pulled dynamically from models/transformer/*/manifest.json (never hardcoded in the
    Bun schema). Each entry: {"value", "label", "arch", "pipeline"}; the frontend filters
    the list by the selected pipeline. Imports are local to avoid pulling in mlx at module
    load (schema-defaults must stay a no-model-load command).
    """
    from app import config as cfg
    from app.model_registry import ModelRegistry

    out = []
    try:
        for m in ModelRegistry(cfg.MODELS_DIR).list("transformer"):
            arch = m.get("arch", "")
            pipeline = _T2I_ARCH_TO_PIPELINE.get(arch)
            if not pipeline:
                continue
            name = m.get("name", "")
            out.append({"value": name, "label": name, "arch": arch, "pipeline": pipeline})
    except Exception:
        pass
    return out
