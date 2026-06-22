"""Referential-integrity checks for the self-test registry.

These tests guard against the "model-deletion cascade" class of bug: deleting a
model under ``models/lora/`` (discovery is dynamic) still leaves the model's name
hardcoded in the self-test registry, alias tables, and the ``image review lora``
default. Without these checks those references rot silently (``--help`` lists
non-existent self-tests, a bare ``image review lora`` crashes, an alias resolves
to a deleted test).

What is enforced
----------------
1. Every LoRA referenced by any self-test (``lora_path`` / ``lora_paths``, both
   top-level and inside ``variants``) resolves to a real file under models/lora/.
2. ``image review lora``'s default test exists and satisfies run_review_lora's
   contract (type=="lora", exactly 2 variants).
3. Every alias maps to a real registry test, and every deprecated name has an
   alias mapping.

CPU-only and fast (no MLX, no model loading — resolve_lora_path only does
os.path checks). Runs unconditionally in the standard suite.
"""

import importlib

from app.test_prompts_image import (
    _ALL_TESTS,
    _ALL_TESTS_ALIASES,
    _DEPRECATED_NAMES,
)


def _iter_lora_refs(test_cfg: dict) -> list[str]:
    """Collect every raw LoRA reference declared in a self-test config.

    LoRA refs live in several shapes: top-level ``lora_path`` / ``lora_paths``,
    and inside per-variant dicts (``variants[].lora_path`` / ``lora_paths``).
    ``None`` / empty values are skipped.
    """
    refs: list[str] = []
    containers = [test_cfg] + list(test_cfg.get("variants") or [])
    for c in containers:
        if not isinstance(c, dict):
            continue
        for key in ("lora_path", "lora_paths"):
            val = c.get(key)
            if val is None:
                continue
            if isinstance(val, (list, tuple)):
                refs.extend(v for v in val if v)
            elif val:
                refs.append(val)
    return refs


def test_selftest_lora_refs_resolve():
    """Every LoRA named by a self-test must resolve under models/lora/."""
    from app.commands._shared import resolve_lora_path

    unresolved: list[str] = []
    for name, cfg_ in _ALL_TESTS.items():
        for raw in _iter_lora_refs(cfg_):
            # resolve_lora_path raises ValueError on failure — treat as unresolved.
            try:
                resolved = resolve_lora_path(raw)
            except ValueError:
                resolved = None
            if not resolved:
                unresolved.append(f"{name}: lora_path={raw!r}")

    assert not unresolved, (
        "self-tests reference LoRAs that do not resolve under models/lora/. "
        "Either delete the self-test or repoint it to an existing lora:\n  "
        + "\n  ".join(unresolved)
    )


def test_review_lora_default_exists_and_valid():
    """`image review lora`'s default must be a 2-variant type:'lora' registry test.

    run_review_lora() asserts exactly 2 variants; a bare `image review lora`
    (no --self-test) falls back to DEFAULT_REVIEW_LORA_TEST, so that name must
    stay valid whenever a model is added/removed.
    """
    # image-review.py has a hyphen in its filename → importlib, not `import`.
    _ir = importlib.import_module("app.commands.image-review")
    default = _ir.DEFAULT_REVIEW_LORA_TEST

    assert default in _ALL_TESTS, (
        f"`image review lora` default {default!r} is not in the self-test "
        f"registry — update DEFAULT_REVIEW_LORA_TEST in image-review.py"
    )
    test_cfg = _ALL_TESTS[default]
    assert test_cfg.get("type") == "lora", (
        f"`image review lora` default must be type:'lora' (2-variant A/B), "
        f"got type={test_cfg.get('type')!r}"
    )
    n_variants = len(test_cfg.get("variants", []))
    assert n_variants == 2, (
        f"run_review_lora needs exactly 2 variants, default {default!r} has "
        f"{n_variants}"
    )


def test_aliases_resolve_to_existing_tests():
    """No alias may point at a deleted test; every deprecated name needs a mapping."""
    dangling = {k: v for k, v in _ALL_TESTS_ALIASES.items() if v not in _ALL_TESTS}
    assert not dangling, (
        "alias entries point to non-existent self-tests "
        "(remove the alias or repoint it):\n  "
        + "\n  ".join(f"{k} -> {v}" for k, v in sorted(dangling.items()))
    )

    orphan_deprecated = sorted(_DEPRECATED_NAMES - set(_ALL_TESTS_ALIASES))
    assert not orphan_deprecated, (
        "deprecated names have no alias mapping (dead back-compat names):\n  "
        + "\n  ".join(orphan_deprecated)
    )
