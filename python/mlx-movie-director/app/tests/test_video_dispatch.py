"""Dispatch validation + mock tests for video commands and replay."""
import ast
import importlib
from pathlib import Path

import pytest

_VIDEO_PY = Path(__file__).resolve().parent.parent.parent / "app" / "commands" / "video.py"


def _video_actions() -> dict[str, tuple[str, str]]:
    """Parse run() in video.py extracting explicit action→(alias, func)."""
    tree = ast.parse(_VIDEO_PY.read_text(encoding="utf-8"))
    run_fn = next(n for n in ast.walk(tree)
                   if isinstance(n, ast.FunctionDef) and n.name == "run")

    mapping = {}
    for node in ast.walk(run_fn):
        if not isinstance(node, ast.If):
            continue
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


def _video_imports() -> dict[str, str]:
    """Parse all importable variable assignments mapping alias → module_path."""
    tree = ast.parse(_VIDEO_PY.read_text(encoding="utf-8"))
    imports = {}
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


class TestVideoDispatchActions:
    def test_actions_resolve(self):
        mapping = _video_actions()
        imports = _video_imports()
        for action, (alias, func_name) in mapping.items():
            assert alias in imports, f"Missing import for alias '{alias}'"
            mod_path = imports[alias]
            try:
                mod = importlib.import_module(mod_path)
            except ImportError as e:
                pytest.fail(f"Action '{action}': cannot import {mod_path}: {e}")
            assert hasattr(mod, func_name), (
                f"Action '{action}': {mod_path} has no '{func_name}'"
            )

    def test_explicit_actions_present(self):
        mapping = _video_actions()
        for action in ("relay", "vbvr", "restore", "compare", "quality"):
            assert action in mapping, f"Missing action: {action}"

    def test_review_action_recognized(self):
        """review has its own internal dispatch; verify the review module exists."""
        _review = importlib.import_module("app.commands.video-review")
        assert hasattr(_review, "run_review_from_generation")
        assert hasattr(_review, "run_review_from_manifests")

    def test_else_branch_is_generate(self):
        mod = importlib.import_module("app.commands.video-generate")
        assert hasattr(mod, "run_generate")


class TestReplayRun:
    """replay.py: deserializes .run.json and dispatches to execute_generation."""

    def _valid_json(self, **overrides) -> str:
        import json
        base = {
            "schema_version": 12,
            "command": "generate",
            "seed": 42,
            "steps": 9,
            "prompt": "test",
            "width": 640,
            "height": 960,
            "pipeline": "zimage",
        }
        base.update(overrides)
        return json.dumps(base)

    def test_replay_valid_call(self, tmp_path, monkeypatch):
        run_json = tmp_path / "test.run.json"
        run_json.write_text(self._valid_json())
        executed = []
        monkeypatch.setattr(
            "app.commands.replay.execute_generation",
            lambda rc, pipeline_type="zimage": executed.append((rc, pipeline_type)),
        )
        import app.commands.replay as replay_mod
        replay_mod.run(type("Args", (), {"file": str(run_json)})())
        assert len(executed) == 1

    def test_replay_missing_file(self, tmp_path, capsys):
        import app.commands.replay as replay_mod
        with pytest.raises(SystemExit):
            replay_mod.run(type("Args", (), {"file": str(tmp_path / "missing.json")})())
        err = capsys.readouterr().err
        assert "not found" in err

    def test_replay_bad_json(self, tmp_path, capsys):
        run_json = tmp_path / "bad.run.json"
        run_json.write_text("not json")
        import app.commands.replay as replay_mod
        with pytest.raises(SystemExit):
            replay_mod.run(type("Args", (), {"file": str(run_json)})())
        err = capsys.readouterr().err
        assert "loading run config" in err

    def test_replay_unsupported_command(self, tmp_path, capsys):
        run_json = tmp_path / "test.run.json"
        run_json.write_text(self._valid_json(command="unknown_cmd"))
        import app.commands.replay as replay_mod
        with pytest.raises(SystemExit):
            replay_mod.run(type("Args", (), {"file": str(run_json)})())
        err = capsys.readouterr().err
        assert "not supported" in err
