"""CLI definition for mlx-movie-director — the single source of truth for the run.py surface.

This module is importable without side effects (no sys.argv mutation, no main()).
run.py is the thin entry point; it imports COMMAND_NAMES / build_parser from here.
app/commands/schema.py also imports build_parser from here to introspect the real
argparse contract — so argparse stays authoritative and is never duplicated.
"""

import argparse
import importlib

# ---------------------------------------------------------------------------
# Subcommand registry (order = display order in --help)
# ---------------------------------------------------------------------------

COMMAND_NAMES = [
    "image", "refine", "upscale", "caption", "replay",
    "video", "import-lora", "import-workflow", "check-model",
    "schema-defaults", "schema",
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
            print(f"WARNING: skipping broken command module '{module_name}': {e}", file=__import__("sys").stderr)
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
