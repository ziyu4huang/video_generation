"""schema — Introspect run.py argparse and emit the FULL CLI contract as JSON.

This is the single source of truth for the run.py CLI surface. argparse is
authoritative; this command only reflects it. The GUI (bun/gui-movie-director)
and the generation workflows derive from this output instead of re-maintaining
flags, so there is exactly one definition of every --flag.

Unlike schema-defaults (a hand-written defaults dict), this introspects the live
parser — types/defaults/choices/help come straight from add_argument() calls.

No model loading, no generation — safe to call at server startup.

Usage:
  run.py schema             # full schema as indented JSON
  run.py schema --compact   # compact JSON (no indent)
"""

import argparse
import json
import sys

from app.cli import build_parser, DEPRECATED_ALIASES

PARSER_META = {
    "help": "Emit the full run.py CLI schema as JSON (argparse introspection)",
    "description": (
        "Print every subcommand's flags/types/defaults/choices/help as JSON, "
        "derived directly from the argparse parser. Single source of truth for "
        "the CLI surface. No model loading."
    ),
}


def add_args(parser):
    parser.add_argument(
        "--compact", action="store_true", default=False,
        help="Emit compact JSON (no indent)",
    )


def run(args):
    data = build()
    indent = None if getattr(args, "compact", False) else 2
    json.dump(data, sys.stdout, ensure_ascii=False, indent=indent, sort_keys=True)
    sys.stdout.write("\n")


# ---------------------------------------------------------------------------
# Introspection
# ---------------------------------------------------------------------------

# Argparse action classes that carry no CLI value (filtered from output).
_NO_VALUE_DESTS = {"help"}


def _json_safe(value):
    """Coerce a default to something json.dump accepts (defaults are usually scalars)."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def _type_name(action):
    t = getattr(action, "type", None)
    if t is None:
        return None
    return getattr(t, "__name__", str(t))


def _nargs(action):
    n = getattr(action, "nargs", None)
    return None if n is None else (n if isinstance(n, str) else int(n))


def _arg_dict(action):
    """Extract the JSON contract for a single argparse action."""
    d = {
        "flags": list(action.option_strings),   # [] for positionals
        "dest": action.dest,
        "action": type(action).__name__,         # _StoreAction / _StoreTrueAction / ...
        "required": bool(getattr(action, "required", False)),
        "default": _json_safe(action.default),
        "help": action.help,
    }
    tn = _type_name(action)
    if tn:
        d["type"] = tn
    choices = getattr(action, "choices", None)
    # dict choices belong to a _SubParsersAction (handled by recursion); scalars are real choices.
    if choices is not None and not isinstance(choices, dict):
        d["choices"] = list(choices)
    n = _nargs(action)
    if n is not None:
        d["nargs"] = n
    return d


def _collect(parser):
    """Split a parser's actions into optionals, positionals, and (optional) subparsers action."""
    optionals, positionals = [], []
    sub_action = None
    for a in parser._actions:
        if isinstance(a, argparse._SubParsersAction):
            sub_action = a
        elif a.dest in _NO_VALUE_DESTS:
            continue
        elif a.option_strings:
            optionals.append(a)
        else:
            positionals.append(a)
    return optionals, positionals, sub_action


def _parser_to_dict(parser):
    optionals, positionals, sub_action = _collect(parser)
    result = {
        "args": [_arg_dict(a) for a in optionals],
        "positionals": [_arg_dict(a) for a in positionals],
    }
    if sub_action is not None:
        result["subcommands"] = {
            name: _parser_to_dict(sub)
            for name, sub in sub_action.choices.items()
        }
    return result


def build():
    """Build the full schema dict by introspecting the run.py parser.

    Top-level: {"commands": {<name>: {args, positionals, [subcommands]}}}
    Deprecated aliases are omitted (they duplicate their canonical parser).
    """
    main_parser = build_parser()
    _, _, sub_action = _collect(main_parser)
    if sub_action is None:
        return {"commands": {}}
    commands = {}
    for name, sub in sub_action.choices.items():
        if name in DEPRECATED_ALIASES:
            continue
        commands[name] = _parser_to_dict(sub)
    return {"commands": commands}
