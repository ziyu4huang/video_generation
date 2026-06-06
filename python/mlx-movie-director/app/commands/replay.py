"""replay — re-run a previous generation from its .run.json file."""

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
        "  run.py --replay output/output_20260606_222819.run.json  ← backward compat"
    ),
}


def add_args(parser):
    parser.add_argument("file", type=str, metavar="RUN_JSON",
                        help="Path to the .run.json file to replay")


def run(args):
    try:
        run_config = RunConfig.from_json(args.file)
    except FileNotFoundError:
        print(f"ERROR: run config not found: {args.file}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR loading run config: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Replaying: {args.file}")
    print(f"  command={run_config.command}  seed={run_config.seed}  steps={run_config.steps}")

    if run_config.command in ("generate", "refine", "text2img", "img2img"):
        execute_generation(run_config)
    elif run_config.command == "upscale":
        from app.commands._shared import DEFAULT_UPSCALE_MODEL, execute_upscale
        model = run_config.upscale_model or DEFAULT_UPSCALE_MODEL
        execute_upscale(run_config.input_image, model, output_path=None)
    else:
        print(f"ERROR: replay not supported for command '{run_config.command}'", file=sys.stderr)
        sys.exit(1)
