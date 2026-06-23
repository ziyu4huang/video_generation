"""Tests for scripts/check_use_before_import.py — the deterministic backstop for
the use-before-import bug class (iter-8, PR #77/#79).

These pin the checker's true-positive / false-positive contract so it stays a
reliable advisory signal in the lint lane.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

_VENV_PYTHON = sys.executable
_HERE = Path(__file__).resolve()
_SCRIPT = _HERE.parents[2] / "scripts" / "check_use_before_import.py"


def _run_src(src: str) -> list[dict]:
    with tempfile.NamedTemporaryFile(
        "w", suffix=".py", delete=False, encoding="utf-8"
    ) as f:
        f.write(src)
        path = f.name
    try:
        r = subprocess.run(
            [_VENV_PYTHON, str(_SCRIPT), path],
            capture_output=True, text=True, timeout=30,
        )
        return json.loads(r.stdout)
    finally:
        os.unlink(path)


def _run_file(path: Path) -> list[dict]:
    r = subprocess.run(
        [_VENV_PYTHON, str(_SCRIPT), str(path)],
        capture_output=True, text=True, timeout=60,
    )
    return json.loads(r.stdout)


def test_flags_use_before_conditional_import():
    """The iter-8 shape: call hoisted above its own lazy import (in a following if)."""
    src = (
        "def f(x):\n"
        "    v = helper(x)\n"                       # use before import
        "    if x:\n"
        "        from app.mod import helper\n"      # import lexically after the use
        "    return v\n"
    )
    findings = _run_src(src)
    assert len(findings) == 1
    assert findings[0]["name"] == "helper"
    assert findings[0]["kind"] == "use-before-import"
    assert findings[0]["function"] == "f"


def test_flags_top_level_use_before_import():
    src = (
        "def g():\n"
        "    print(thing(1))\n"
        "    from lib import thing\n"
        "    return thing(2)\n"
    )
    findings = _run_src(src)
    assert len(findings) == 1
    assert findings[0]["name"] == "thing"


def test_clean_lazy_import_then_use():
    """Normal lazy-import-then-use must NOT be flagged."""
    src = (
        "def f(x):\n"
        "    from app.mod import helper\n"
        "    return helper(x)\n"
    )
    assert _run_src(src) == []


def test_closure_uses_enclosing_import_not_flagged():
    """A nested function using an enclosing-scope import must NOT be flagged
    (the import is not the nested function's own local import)."""
    src = (
        "def outer():\n"
        "    from app.mod import helper\n"
        "    def inner(y):\n"
        "        return helper(y)\n"
        "    return inner\n"
    )
    assert _run_src(src) == []


def test_module_level_name_not_flagged():
    src = (
        "import os\n"
        "def f():\n"
        "    return os.getcwd()\n"
    )
    assert _run_src(src) == []


def test_param_and_builtin_not_flagged():
    src = (
        "def f(helper):\n"
        "    return helper(len([1, 2]))\n"
    )
    assert _run_src(src) == []


def test_comprehension_scope_not_flagged():
    """A name imported later but used only inside a comprehension (own scope)
    must not produce a spurious violation in the enclosing function."""
    src = (
        "def f(items):\n"
        "    out = [process(x) for x in items]\n"
        "    from lib import process\n"
        "    return out\n"
    )
    # `process` is used inside the comprehension scope, not the function body
    # directly — conservative checker does not descend into the comprehension,
    # so this is NOT flagged (acceptable; the comprehension would still NameError
    # at runtime, but the checker is deliberately conservative to avoid FPs).
    assert _run_src(src) == []


def test_real_image_profile_is_clean():
    """PR #77 fixed the iter-8 bug; the checker must report 0 on the fixed file."""
    path = _HERE.parents[1] / "commands" / "image-profile.py"
    if not path.exists():
        return
    assert _run_file(path) == []


def test_parse_error_reported_not_crash():
    """A syntactically broken file yields a parse_error entry, exit-clean JSON."""
    src = "def broken(:\n"
    findings = _run_src(src)
    assert len(findings) == 1
    assert "parse_error" in findings[0]
