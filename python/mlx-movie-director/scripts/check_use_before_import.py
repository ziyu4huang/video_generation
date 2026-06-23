#!/usr/bin/env python3
"""Detect function-local USE-BEFORE-IMPORT bugs (the iter-8 class, PR #77).

A function-local lazy import whose name is USED at a line that lexically
precedes the import statement is a runtime ``NameError`` on every path reaching
the use. Two layers miss it:

* **pyflakes** sees the name imported *somewhere* in the scope (not the order).
* **pytest** misses it when the function is GPU-gated / outside the CPU suite.

This is the deterministic backstop for the operation-lesson
``fix-relocate-call-relocate-import``. It targets imports specifically (the
observed iter-8 shape: a call hoisted above its own ``from ... import``), so the
logic stays simple and low-false-positive:

For each function, collect its function-local imports (name -> earliest import
line) and its Load-uses (name -> earliest use line), neither descending into
nested scopes. A name is flagged when its earliest USE line precedes its earliest
IMPORT line AND the name is not a builtin / module-level name / parameter /
enclosing-scope name. Enclosing-scope names are naturally exempt (they are not
this function's local imports).

Output: JSON array of ``{"file","function","line","name","kind"}`` on stdout.
Exit 0 always (advisory) unless a file failed to parse.

Usage: python scripts/check_use_before_import.py <file.py> [...]
"""

from __future__ import annotations

import ast
import builtins
import json
import sys
from typing import Iterable, Iterator

_BUILTINS = set(dir(builtins))
_SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
_COMP_NODES = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _import_binding_names(node: ast.Import | ast.ImportFrom) -> set[str]:
    names: set[str] = set()
    if isinstance(node, ast.Import):
        for alias in node.names:
            names.add(alias.asname or alias.name.split(".")[0])
    else:  # ImportFrom
        for alias in node.names:
            if alias.name == "*":
                continue
            names.add(alias.asname or alias.name)
    return names


def _module_level_names(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names |= _import_binding_names(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                names |= _target_names(tgt)
        elif isinstance(node, ast.AnnAssign):
            names |= _target_names(node.target)
    return names


def _target_names(node: ast.expr | None) -> set[str]:
    names: set[str] = set()
    if node is None:
        return names
    if isinstance(node, ast.Name):
        names.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        names |= {n for elt in node.elts for n in _target_names(elt)}
    elif isinstance(node, ast.Starred):
        names |= _target_names(node.value)
    return names


def _params(func: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    names: set[str] = set()
    args = func.args
    for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs):
        names.add(arg.arg)
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)
    return names


def _iter_func_local_imports(body: list[ast.stmt]) -> Iterator[ast.stmt]:
    """Yield Import/ImportFrom within a function body, recursing through
    compound statements (if/for/while/try/with) but NOT into nested scopes
    (def/class/lambda bodies — those are their own scopes)."""
    for node in body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            yield node
            continue
        if isinstance(node, _SCOPE_NODES):
            continue  # nested scope — skip its body
        for child_body in _compound_bodies(node):
            yield from _iter_func_local_imports(child_body)


def _compound_bodies(node: ast.stmt) -> list[list[ast.stmt]]:
    if isinstance(node, ast.If):
        return [b for b in (node.body, node.orelse) if b]
    if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
        return [b for b in (node.body, node.orelse) if b]
    if isinstance(node, (ast.With, ast.AsyncWith)):
        return [node.body]
    if isinstance(node, ast.Try):
        bodies = [node.body, *(h.body for h in node.handlers), node.orelse, node.finalbody]
        return [b for b in bodies if b]
    return []


def _load_uses(body: list[ast.stmt]) -> Iterator[tuple[int, str]]:
    """Yield (lineno, name) for Name(Load) within a function body, recursing
    through compound statements and expressions but NOT into nested scopes
    (def/class/lambda) NOR comprehension/lambda bodies (own scopes)."""
    for node in body:
        if isinstance(node, _SCOPE_NODES):
            continue  # nested scope — its body uses its own/enclosing scope
        yield from _expr_load_uses(_stmt_expr_roots(node))
        for child_body in _compound_bodies(node):
            yield from _load_uses(child_body)


def _stmt_expr_roots(node: ast.stmt) -> list[ast.expr]:
    """Expression children of a statement that live in the current scope
    (excludes nested-scope bodies)."""
    roots: list[ast.expr] = []
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.expr):
            roots.append(child)
        elif isinstance(child, ast.arguments):
            roots.extend(child.defaults)
            roots.extend(d for d in child.kw_defaults if d is not None)
    return roots


def _expr_load_uses(exprs: list[ast.expr]) -> Iterator[tuple[int, str]]:
    """Yield (lineno, name) for Name(Load) walking expressions, NOT descending
    into nested scope-creating expressions (lambda / comprehensions)."""
    stack: list[ast.expr] = list(exprs)
    while stack:
        n = stack.pop()
        if isinstance(n, ast.Name):
            if isinstance(n.ctx, ast.Load):
                yield n.lineno, n.id
            continue
        if isinstance(n, _COMP_NODES):
            # comprehensions: the iterable(s) are evaluated in the ENCLOSING
            # scope (fair to scan), but the element + the comp targets are a new
            # scope. Conservatively scan only the leftmost iterable.
            for gen in n.generators:
                stack.append(gen.iter)
            continue
        if isinstance(n, ast.Lambda):
            # lambda body is its own scope; defaults are evaluated in enclosing.
            stack.extend(n.args.defaults)
            continue
        for child in ast.iter_child_nodes(n):
            if isinstance(child, ast.expr):
                stack.append(child)


def check_file(path: str) -> list[dict]:
    try:
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=path)
    except (SyntaxError, OSError, ValueError) as exc:
        return [{"file": path, "parse_error": f"{type(exc).__name__}: {exc}"}]

    module_names = _module_level_names(tree)
    violations: list[dict] = []

    for func in _all_functions(tree):
        params = _params(func)
        # name -> earliest import line among this function's local imports
        import_line: dict[str, int] = {}
        for imp in _iter_func_local_imports(func.body):
            for nm in _import_binding_names(imp):
                import_line[nm] = min(import_line.get(nm, imp.lineno), imp.lineno)
        if not import_line:
            continue
        # name -> earliest use line
        use_line: dict[str, int] = {}
        for line, nm in _load_uses(func.body):
            if nm not in use_line or line < use_line[nm]:
                use_line[nm] = line
        for nm, u_line in use_line.items():
            imp_l = import_line.get(nm)
            if imp_l is None:
                continue  # not a function-local import — not our target
            if nm in module_names or nm in params or nm in _BUILTINS:
                continue  # available without the local import
            if u_line < imp_l:
                violations.append({
                    "file": path, "function": func.name,
                    "line": u_line, "name": nm, "kind": "use-before-import",
                })

    seen: set[tuple] = set()
    out: list[dict] = []
    for v in violations:
        key = (v["file"], v["function"], v["line"], v["name"])
        if key not in seen:
            seen.add(key)
            out.append(v)
    return out


def _all_functions(tree: ast.Module) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    """All function defs anywhere in the tree (nested included); each is scanned
    against its OWN local imports, so enclosing scopes are naturally exempt."""
    funcs: list[ast.FunctionDef | ast.AsyncFunctionDef] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            funcs.append(node)
    return funcs


def main(argv: Iterable[str]) -> int:
    files = [a for a in argv if not a.startswith("-")]
    results: list[dict] = []
    had_parse_error = False
    for path in files:
        for r in check_file(path):
            if "parse_error" in r:
                had_parse_error = True
            results.append(r)
    print(json.dumps(results, indent=2))
    return 1 if had_parse_error else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
