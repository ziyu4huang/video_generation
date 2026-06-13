"""import-lora — Import a LoRA .safetensors file into the model registry.

Canonical command name for LoRA import. Replaces the misleading
'import-lora-image' (which doesn't import images).

Re-exports all symbols from the implementation module import-lora-image.
"""

import importlib

_mod = importlib.import_module("app.commands.import-lora-image")

PARSER_META = {
    **_mod.PARSER_META,
    "help": "Import a LoRA .safetensors file into the model registry",
}

add_args = _mod.add_args
run = _mod.run
