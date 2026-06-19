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
import argparse

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

    # Removed top-level commands, rewritten to their canonical `image` form.
    # These are no longer registered in COMMAND_NAMES (so they're absent from
    # --help), but kept working — WITHOUT this rewrite, the generic injection
    # below would treat the unknown token as a missing subcommand and insert
    # `generate`, silently running the WRONG model (e.g. `run.py lens` → zimage).
    # Rewriting + a deprecation nudge avoids that footgun.
    _REMOVED_REWRITES = {
        "lens": (["image", "t2i", "--pipeline", "lens"],
                 "Use 'image t2i --pipeline lens' instead."),
        "t2i": (["image", "t2i"],
                "Use 'image t2i' instead."),
    }
    first_real = next((t for t in argv if not t.startswith("-")), None)
    if first_real in _REMOVED_REWRITES:
        new_tokens, msg = _REMOVED_REWRITES[first_real]
        print(f"⚠  '{first_real}' is now a pipeline option of 'image'. {msg}",
              file=sys.stderr)
        idx = sys.argv.index(first_real, 1)   # positional token in argv[1:]
        sys.argv[idx:idx + 1] = new_tokens
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

def _run_with_gpu_guard(args: argparse.Namespace) -> None:
    """Acquire GPU lock if the command is GPU-heavy, then dispatch."""
    from app.gpu_monitor import GpuLock, GpuLockTimeout, is_gpu_heavy_command

    force = getattr(args, "force_gpu", False)
    try:
        if is_gpu_heavy_command(args) and not force:
            with GpuLock():
                args.func(args)
        else:
            args.func(args)
    except GpuLockTimeout:
        # GpuLock already printed the timeout detail; exit cleanly at the CLI
        # boundary rather than from inside the context manager.
        sys.exit(1)
    except (ValueError, FileNotFoundError) as exc:
        # User-facing input/usage errors raised by library helpers (e.g.
        # io_utils.require_file) — print a clean one-line error at the CLI
        # boundary instead of a raw traceback. These RAISE (not sys.exit) from
        # the library so tests / programmatic callers can catch them; this
        # handler preserves the clean CLI exit for the run.py dispatch path.
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    _inject_default_subcommand()
    parser = build_parser()
    args = parser.parse_args()

    # Apply --gen-output-dir override before dispatch. All command modules read
    # cfg.OUTPUT_DIR at call time, so mutating it here propagates everywhere.
    if getattr(args, "gen_output_dir", None):
        from app import config as cfg
        cfg.OUTPUT_DIR = cfg._resolve_output_dir(args.gen_output_dir)

    # Runtime deprecation warning
    if args.command in DEPRECATED_ALIASES:
        print(f"⚠  DEPRECATED: '{args.command}' is deprecated. {DEPRECATED_ALIASES[args.command]}", file=sys.stderr)

    _run_with_gpu_guard(args)


if __name__ == "__main__":
    main()
