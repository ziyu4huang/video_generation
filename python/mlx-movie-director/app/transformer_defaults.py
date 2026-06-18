"""Per-transformer built-in parameter defaults.

Different transformer checkpoints have different optimal settings (e.g. CFG scale).
This registry is the single source of truth for transformer-specific built-in
defaults. It is applied in `RunConfig.from_args()` and emitted by
`run.py schema-defaults` so the Bun GUI can load it dynamically.

Apply rule (enforced in run_config.py): a registry default is applied ONLY when the
user did NOT pass that flag on the CLI (detected via the argparse `default=None`
sentinel — `getattr(args, key) is None`). An explicit user flag always wins. This
avoids the magic-number-compare trap (see memory argparse-sentinel-for-user-override).

Add an entry only after an A/B test confirms the value — record the test in
`models/transformer/<name>/kb.jsonl` and reference it here.
"""

# transformer instance name → {param: value, ...}
# Only params that differ from the global RunConfig defaults belong here.
TRANSFORMER_DEFAULTS: dict[str, dict] = {
    "dark-beast-dbzit9": {
        # cfg≈3.0 proven optimal on this ZImageTurbo finetune: overall 4→6,
        # prompt_adherence 8→10, sharpness 7→8 (kb.jsonl group D, 2026-06-18).
        # ZImagePipeline runs CFG only when cfg_scale > 1.0 (dual forward/step).
        "cfg_scale": 3.0,
    },
}


def get_transformer_defaults(name: str | None) -> dict:
    """Return built-in defaults for a transformer instance, or {} if none registered."""
    return TRANSFORMER_DEFAULTS.get(name or "", {})


def all_transformer_defaults() -> dict[str, dict]:
    """Return the full registry (used by schema-defaults to publish to the GUI)."""
    return {k: dict(v) for k, v in TRANSFORMER_DEFAULTS.items()}
