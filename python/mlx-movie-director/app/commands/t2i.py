"""t2i — alias for 'image t2i' (text-to-image)."""

from app.commands.image import (  # noqa: F401
    PARSER_META,
    add_args,
    run,
)

PARSER_META = {
    **PARSER_META,
    "help": "Alias for 'image t2i' — text-to-image",
}
