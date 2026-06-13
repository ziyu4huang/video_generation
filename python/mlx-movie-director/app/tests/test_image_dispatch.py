"""AST-based dispatch validation for app/commands/image.py.

Verifies every action in the if/elif chain maps to an importable module
with the expected function name. Similar to test_image_i2i_selftest.py.
"""

import ast
import importlib
from pathlib import Path

import pytest


_IMAGE_PY = Path(__file__).resolve().parent.parent.parent / "app" / "commands" / "image.py"


def _action_module_map() -> dict[str, tuple[str, str]]:
    """Parse run() and extract explicit action→(alias, func) mappings.

    Does NOT capture the else branch (t2i default).
    """
    tree = ast.parse(_IMAGE_PY.read_text(encoding="utf-8"))
    run_fn = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == "run"
    )

    mapping: dict[str, tuple[str, str]] = {}
    for node in ast.walk(run_fn):
        if not isinstance(node, ast.If):
            continue
        # Only match top-level if/elif (not nested conditionals)
        if not (isinstance(node.test, ast.Compare)
                and isinstance(node.test.left, ast.Name) and node.test.left.id == "action"
                and len(node.test.comparators) == 1
                and isinstance(node.test.comparators[0], ast.Constant)
                and isinstance(node.test.comparators[0].value, str)):
            continue

        action_name = node.test.comparators[0].value
        for stmt in node.body:
            if (isinstance(stmt, ast.Expr)
                    and isinstance(stmt.value, ast.Call)
                    and isinstance(stmt.value.func, ast.Attribute)
                    and isinstance(stmt.value.func.value, ast.Name)):
                mapping[action_name] = (stmt.value.func.value.id, stmt.value.func.attr)

    return mapping


def _all_imports() -> dict[str, str]:
    """Parse all import statements mapping alias → module_path.

    Handles both `from X import Y as _Z` and `_Z = importlib.import_module('X.Y')`.
    """
    tree = ast.parse(_IMAGE_PY.read_text(encoding="utf-8"))
    imports: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname and alias.asname.startswith("_"):
                    imports[alias.asname] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                if alias.asname and alias.asname.startswith("_"):
                    imports[alias.asname] = f"{node.module}.{alias.name}"
        elif isinstance(node, ast.Assign):
            # _xxx = importlib.import_module("app.commands.xxx-xxx")
            if (len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id.startswith("_")
                    and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Attribute)
                    and node.value.func.attr == "import_module"
                    and node.value.args
                    and isinstance(node.value.args[0], ast.Constant)):
                imports[node.targets[0].id] = node.value.args[0].value
    return imports


class TestImageDispatchActions:
    """Every explicit action → importable module + function."""

    def test_all_explicit_actions_mapped(self):
        mapping = _action_module_map()
        for action in ("angle", "review", "profile", "controlnet", "i2i",
                       "faceswap", "swap", "anime2real", "quality",
                       "workflow", "expansion", "purify", "restore"):
            assert action in mapping, f"Missing action in dispatch: {action}"

    def test_every_action_module_importable(self):
        mapping = _action_module_map()
        imports = _all_imports()
        for action, (alias, func_name) in mapping.items():
            assert alias in imports, (
                f"Action '{action}' references alias '{alias}' not found in imports"
            )
            module_path = imports[alias]
            try:
                mod = importlib.import_module(module_path)
            except ImportError as e:
                pytest.fail(f"Action '{action}' module '{module_path}': {e}")
            assert hasattr(mod, func_name), (
                f"Action '{action}': {module_path} has no '{func_name}'"
            )

    def test_else_branch_is_t2i(self):
        """The trailing else branch calls _t2i.run_t2i(args)."""
        mod = importlib.import_module("app.commands.image-t2i")
        assert hasattr(mod, "run_t2i")
