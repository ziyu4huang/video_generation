"""replay — re-run a previous generation from its .run.json file."""

import argparse
import json
import sys

from app.run_config import RunConfig
from app.commands._shared import execute_generation

PARSER_META = {
    "help": "Replay a previous run from its .run.json config file",
    "description": (
        "Load a .run.json file written by a previous run and execute it again.\n"
        "Useful for reproducing exact outputs or iterating on a seed.\n\n"
        "Examples:\n"
        "  run.py replay output/output_20260606_222819.run.json\n"
        "  run.py replay output/i2i_dn0.4_9st-s42.run.json\n"
        "  run.py --replay output/output_20260606_222819.run.json  ← backward compat"
    ),
}


def add_args(parser: "argparse.ArgumentParser") -> None:
    parser.add_argument("file", type=str, metavar="RUN_JSON",
                        help="Path to the .run.json file to replay")


def run(args: "argparse.Namespace") -> None:
    # Load the raw JSON once. A .run.json is either a versioned RunConfig
    # (t2i/generate/img2img/upscale) or a hand-written image run.json
    # (purify/i2i/controlnet/expansion — written with command="image" + an
    # "action" field, NOT the RunConfig schema). Peek at the shape to dispatch.
    try:
        with open(args.file, "r") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: run config not found: {args.file}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR loading run config: {exc}", file=sys.stderr)
        sys.exit(1)

    # Hand-written image run.json: rebuild an argparse Namespace and re-dispatch
    # through the canonical image entry point (reuses self-test / list-loras /
    # sub-action routing). RunConfig.from_json would mis-parse these (no schema
    # version) and the dispatch keyed on `command` never matches "image".
    if isinstance(data, dict) and data.get("command") == "image" and data.get("action"):
        return _replay_image(data)

    try:
        run_config = RunConfig.from_json(args.file)
    except ValueError as exc:
        print(f"ERROR loading run config: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Replaying: {args.file}")
    print(f"  command={run_config.command}  seed={run_config.seed}  steps={run_config.steps}")

    if run_config.command in ("generate", "refine", "text2img", "img2img"):
        pipeline_type = getattr(run_config, "pipeline", "zimage")
        execute_generation(run_config, pipeline_type=pipeline_type)
    elif run_config.command == "upscale":
        from app.commands._shared import DEFAULT_UPSCALE_MODEL, execute_upscale
        model = run_config.upscale_model or DEFAULT_UPSCALE_MODEL
        execute_upscale(run_config.input_image, model, output_path=None)
    else:
        print(f"ERROR: replay not supported for command '{run_config.command}'", file=sys.stderr)
        sys.exit(1)


def _replay_image(data: dict) -> None:
    """Replay a hand-written image run.json (purify/i2i/controlnet/...) in-process.

    Rebuilds an argparse Namespace from the run.json dict — the stored keys already
    use argparse dest names (input_image, purify_mode, denoise_strength, ...) so the
    Namespace is equivalent to the originally parsed args. Extra keys (command,
    backend, resolved `softness`) are harmless unused attributes. Re-dispatches
    through app.commands.image.run so sub-action routing + normalization is reused
    rather than re-implemented here.
    """
    from app.commands import image as _image

    action = data.get("action")
    print(f"Replaying: image/{action}  seed={data.get('seed')}  "
          f"input={data.get('input_image')}")

    ns = argparse.Namespace(**data)
    # Control-flow fields the dispatcher reads but a hand-written run.json omits.
    for key, default in (
        ("self_test", None),
        ("list_loras", False),
        ("sub_action", None),
    ):
        if not hasattr(ns, key):
            setattr(ns, key, default)
    _image.run(ns)

