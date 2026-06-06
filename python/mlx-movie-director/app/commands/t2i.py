"""t2i — alias for generate (text-to-image)."""

from app.commands.generate import (  # noqa: F401
    PARSER_META,
    add_args,
    run,
)

PARSER_META = {
    **PARSER_META,
    "help": "Alias for generate — text-to-image",
}
