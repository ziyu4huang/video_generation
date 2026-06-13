#!/usr/bin/env python3
"""mlx-movie-director — Z-Image / LTX generation on Apple Silicon.

Run `./python/venv/bin/python python/mlx-movie-director/run.py --help` for help.
Run `./python/venv/bin/python python/mlx-movie-director/run.py <command> --help` for command help.

Backward-compatible: `run.py --prompt "..."` still works (defaults to generate).

The CLI surface (subcommand registry + parser factory) lives in app/cli.py so it
can be introspected by `run.py schema` and imported without side effects.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.cli import (
    build_parser,
    DEPRECATED_ALIASES,
    SUBCOMMANDS,
)


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
# GPU-guarded dispatch
# ---------------------------------------------------------------------------

def _run_with_gpu_guard(args) -> None:
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
        print(f"⚠  DEPRECATED: '{args.command}' is deprecated. {DEPRECATED_ALIASES[args.command]}", file=sys.stderr)

    _run_with_gpu_guard(args)


if __name__ == "__main__":
    main()
