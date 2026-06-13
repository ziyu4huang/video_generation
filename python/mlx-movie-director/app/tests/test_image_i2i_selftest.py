"""Regression tests for the I2I self-test dispatch chain <-> variation lists.

`_run_self_test()` selects a variation list per mode via a long `elif st_val ==
"<mode>"` chain, each branch assigning `variations = _I2I_<NAME>_VARIATIONS`.
The classic regression here is drift: adding an `elif` that references a list
that was never defined (NameError at runtime) or defining a list that no branch
ever selects (dead code). These tests pin that contract WITHOUT running any GPU
pipeline — pure AST + module-constant inspection.
"""

import ast
import importlib
from pathlib import Path

image_i2i = importlib.import_module("app.commands.image-i2i")


def _stval_string(node) -> str | None:
    """Return the string literal compared against in a `st_val == "<s>"` test."""
    for n in ast.walk(node):
        if isinstance(n, ast.Compare):
            for comp in n.comparators:
                if isinstance(comp, ast.Constant) and isinstance(comp.value, str):
                    return comp.value
    return None


def _dispatch_mapping() -> dict[str, str]:
    """Parse `_run_self_test` and map each dispatched mode -> variation list name.

    Walks every `ast.If` inside `_run_self_test`, extracts the `st_val == "<mode>"`
    string from its test, and the `variations = _I2I_<NAME>` target from its body.
    The trailing `else` (default fallthrough) has no string compare, so it is
    correctly excluded.
    """
    tree = ast.parse(Path(image_i2i.__file__).read_text())
    fn = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == "_run_self_test"
    )
    out: dict[str, str] = {}
    for ifn in ast.walk(fn):
        if not isinstance(ifn, ast.If):
            continue
        mode = _stval_string(ifn.test)
        if not mode:
            continue
        for stmt in ifn.body:
            if (isinstance(stmt, ast.Assign)
                    and len(stmt.targets) == 1
                    and isinstance(stmt.targets[0], ast.Name)
                    and stmt.targets[0].id == "variations"
                    and isinstance(stmt.value, ast.Name)):
                out[mode] = stmt.value.id
    return out


def _all_variation_lists() -> set[str]:
    """Every `_I2I_*_VARIATIONS` module-level attribute actually defined."""
    return {
        a for a in dir(image_i2i)
        if a.startswith("_I2I_") and a.endswith("_VARIATIONS")
    }


class TestDispatchResolvesToDefinedLists:
    def test_dispatch_handles_at_least_12_modes(self):
        # Guards against accidental truncation of the elif chain.
        assert len(_dispatch_mapping()) >= 12

    def test_every_dispatched_mode_resolves_to_defined_nonempty_list(self):
        # Catches: an elif references a constant that doesn't exist (NameError)
        # or selects an empty list (zero-variant self-test).
        for mode, const_name in _dispatch_mapping().items():
            assert hasattr(image_i2i, const_name), (
                f"{mode}: dispatch references undefined {const_name}"
            )
            actual = getattr(image_i2i, const_name)
            assert isinstance(actual, list) and len(actual) > 0, (
                f"{mode}: {const_name} is not a non-empty list"
            )

    def test_each_mode_selects_a_distinct_list(self):
        # Two modes silently sharing one list usually means a copy-paste error.
        mapping = _dispatch_mapping()
        assert len(set(mapping.values())) == len(mapping), (
            "modes do not map 1:1 to variation lists"
        )


class TestNoOrphanOrMissingLists:
    def test_every_variation_list_is_dispatched_or_is_the_default(self):
        # Catches: a list defined but never selected (dead code), which usually
        # means a mode's elif was deleted while its list stayed behind.
        dispatched = set(_dispatch_mapping().values())
        default_suite = "_I2I_SELF_TEST_VARIATIONS"
        for const_name in _all_variation_lists():
            assert const_name in dispatched or const_name == default_suite, (
                f"{const_name} is defined but never dispatched"
            )

    def test_default_fallthrough_suite_exists_and_nonempty(self):
        # The trailing `else` branch selects _I2I_SELF_TEST_VARIATIONS.
        assert hasattr(image_i2i, "_I2I_SELF_TEST_VARIATIONS")
        default = getattr(image_i2i, "_I2I_SELF_TEST_VARIATIONS")
        assert isinstance(default, list) and len(default) > 0
