#!/usr/bin/env python3
"""mlx-movie-director — Z-Image generation on Apple Silicon.

Run `./python/venv/bin/python python/mlx-movie-director/run.py --help` for help.
Run `./python/venv/bin/python python/mlx-movie-director/run.py <command> --help` for command help.

Backward-compatible: `run.py --prompt "..."` still works (defaults to generate).
"""

import importlib
import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# Subcommand registry (order = display order in --help)
# ---------------------------------------------------------------------------

COMMAND_NAMES = [
    "image", "refine", "upscale", "caption", "replay",
    "video", "import-lora", "import-workflow", "check-model",
    "schema-defaults",
]

# Aliases — backward-compat names that load a different module.
# Registered as subcommands so old invocation patterns still work.
# DEPRECATED_ALIASES controls deprecation hints in help text + runtime.
COMMAND_ALIASES = {
    "generate": "image",
    "t2i": "t2i",
    "check-manifests": "check-model",
    "import-lora-image": "import-lora",
}

DEPRECATED_ALIASES = {
    "generate": "Use 'image' instead.",
    "t2i": "Use 'image t2i' instead.",
    "check-manifests": "Use 'check-model' instead.",
    "import-lora-image": "Use 'import-lora' instead.",
}

SUBCOMMANDS = set(COMMAND_NAMES) | set(COMMAND_ALIASES)


# ---------------------------------------------------------------------------
# Backward-compat: inject default subcommand before argparse sees argv
# ---------------------------------------------------------------------------

def _inject_default_subcommand() -> None:
    """Mutate sys.argv to inject a subcommand when none is given.

    Rules (checked before argparse):
      - run.py                      → show main help (no injection)
      - run.py --help / -h          → show main help (no injection)
      - run.py generate ...         → already has subcommand, no injection
      - run.py --prompt "..."       → inject 'generate'
      - run.py --replay file.json   → inject 'replay', transform --replay to positional
    """
    argv = sys.argv[1:]
    if not argv or argv[0] in ("--help", "-h"):
        return  # let argparse show top-level help

    # Backward compat: --replay path.json → replay path.json
    # Must be checked BEFORE the loop — the path value would look like a non-subcommand positional.
    if "--replay" in argv:
        idx = sys.argv.index("--replay")
        sys.argv.pop(idx)           # remove --replay flag; path becomes bare positional
        sys.argv.insert(1, "replay")
        return

    # Find first non-flag token to detect explicit subcommand
    for token in argv:
        if not token.startswith("-"):
            if token not in SUBCOMMANDS:
                sys.argv.insert(1, "generate")
            return  # subcommand already present or injected

    # All args are flags (e.g. --prompt "..." with no positional) → default to generate
    sys.argv.insert(1, "generate")


# ---------------------------------------------------------------------------
# Parser factory
# ---------------------------------------------------------------------------

# Global arguments inherited by all subcommands
_global_parser = argparse.ArgumentParser(add_help=False)
_global_parser.add_argument(
    "--force", "--skip-gpu-lock",
    action="store_true", default=False, dest="force_gpu",
    help="Bypass GPU busy detection — run even when another GPU-heavy process is active",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run.py",
        description=(
            "mlx-movie-director: Z-Image / LTX generation on Apple Silicon.\n\n"
            "Quick start:\n"
            "  run.py --prompt 'Moody portrait'                  # text-to-image (default)\n"
            "  run.py generate --prompt '...' --upscale          # explicit + ESRGAN\n"
            "  run.py refine --input-image base.png --prompt '.' # img2img refine\n"
            "  run.py upscale base.png                           # ESRGAN only, no diffusion\n"
            "  run.py replay output/run.json                     # re-run previous"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run `run.py <command> --help` for per-command options.",
    )

    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    subparsers.required = True

    for name in list(COMMAND_NAMES) + list(COMMAND_ALIASES):
        module_name = COMMAND_ALIASES.get(name, name)
        try:
            mod = importlib.import_module(f"app.commands.{module_name}")
        except ImportError as e:
            print(f"WARNING: skipping broken command module '{module_name}': {e}", file=sys.stderr)
            continue

        # Inject deprecation prefix into help/description for deprecated aliases
        parser_kwargs = dict(mod.PARSER_META)
        if name in DEPRECATED_ALIASES:
            msg = DEPRECATED_ALIASES[name]
            parser_kwargs["help"] = f"[DEPRECATED] {msg} {parser_kwargs.get('help', '')}"
            parser_kwargs["description"] = (
                f"[DEPRECATED] {msg}\n\n{parser_kwargs.get('description', '')}"
            )

        sub = subparsers.add_parser(
            name,
            formatter_class=argparse.RawDescriptionHelpFormatter,
            parents=[_global_parser],
            **parser_kwargs,
        )
        mod.add_args(sub)
        sub.set_defaults(func=mod.run)

    return parser


# ---------------------------------------------------------------------------
# GPU-guarded dispatch
# ---------------------------------------------------------------------------

def _run_with_gpu_guard(args: argparse.Namespace) -> None:
    """Acquire GPU lock if the command is GPU-heavy, then dispatch."""
    from app.gpu_monitor import GpuLock, is_gpu_heavy_command

    force = getattr(args, "force_gpu", False)
    if is_gpu_heavy_command(args) and not force:
        with GpuLock():
            args.func(args)
    else:
        args.func(args)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    _inject_default_subcommand()
    parser = build_parser()
    args = parser.parse_args()

    # Runtime deprecation warning
    if args.command in DEPRECATED_ALIASES:
        print(f"\u26a0  DEPRECATED: '{args.command}' is deprecated. {DEPRECATED_ALIASES[args.command]}", file=sys.stderr)

    _run_with_gpu_guard(args)


if __name__ == "__main__":
    main()
