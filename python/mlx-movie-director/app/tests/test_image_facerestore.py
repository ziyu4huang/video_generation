"""Tests for image-facerestore: arg surface, manifest parsing, venv-missing guard.

These run in python/venv and mock the subprocess spawn, so they do NOT require
python/face-venv (the face-restore stack is isolated there). The dispatch routing
(facerestore -> run_facerestore) is covered by test_image_dispatch.py.
"""
import argparse
import importlib
from unittest.mock import MagicMock, patch

import pytest

_facerestore = importlib.import_module("app.commands.image-facerestore")
add_facerestore_args = _facerestore.add_facerestore_args
run_facerestore = _facerestore.run_facerestore
_parse_manifest = _facerestore._parse_manifest
_resolve_face_python = _facerestore._resolve_face_python


def _ns(**kw):
    base = dict(input_image=None, face_model="gfpgan", fidelity=0.5, bg_upsampler=False)
    base.update(kw)
    return argparse.Namespace(**base)


# ---------------------------------------------------------------------------
# add_facerestore_args — the CLI surface OM + the bridge expect
# ---------------------------------------------------------------------------
class TestArgSurface:
    def _parser(self):
        p = argparse.ArgumentParser()
        add_facerestore_args(p)
        return p

    def test_model_default_and_choices(self):
        ns = self._parser().parse_args([])
        assert ns.face_model == "gfpgan"
        assert ns.fidelity == 0.5
        assert ns.bg_upsampler is False

    def test_model_choices_enforced(self):
        with pytest.raises(SystemExit):
            self._parser().parse_args(["--model", "seraphim"])

    def test_idempotent_registration(self):
        p = self._parser()
        before = len(p._actions)  # noqa: SLF001
        add_facerestore_args(p)  # second call must not duplicate
        assert len(p._actions) == before  # noqa: SLF001

    def test_full_surface_parses(self):
        ns = self._parser().parse_args(["--model", "codeformer", "--fidelity", "0.9", "--bg-upsampler"])
        assert ns.face_model == "codeformer"
        assert ns.fidelity == 0.9
        assert ns.bg_upsampler is True


# ---------------------------------------------------------------------------
# _parse_manifest — the parent's contract with the bridge
# ---------------------------------------------------------------------------
class TestParseManifest:
    def test_extracts_json_after_marker(self):
        out = "stuff\n__FACE_RESTORE_MANIFEST__\n" \
              '{"ok": true, "output": "/x/y.png", "num_faces": 2}\n'
        m = _parse_manifest(out)
        assert m == {"ok": True, "output": "/x/y.png", "num_faces": 2}

    def test_no_marker_returns_none(self):
        assert _parse_manifest("no manifest here") is None

    def test_bad_json_returns_none(self):
        out = "__FACE_RESTORE_MANIFEST__\n{not json}\n"
        assert _parse_manifest(out) is None

    def test_uses_last_marker_occurrence(self):
        out = ("__FACE_RESTORE_MANIFEST__\n{\"ok\": false}\n"
               "more\n__FACE_RESTORE_MANIFEST__\n{\"ok\": true}\n")
        assert _parse_manifest(out) == {"ok": True}


# ---------------------------------------------------------------------------
# _resolve_face_python — env override wins, missing venv -> None
# ---------------------------------------------------------------------------
class TestResolveFacePython:
    def test_env_override_wins(self, tmp_path, monkeypatch):
        fake = tmp_path / "fakepython"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("MD_FACE_PYTHON", str(fake))
        assert _resolve_face_python() == str(fake)

    def test_missing_env_override_falls_through(self, monkeypatch):
        monkeypatch.setenv("MD_FACE_PYTHON", "/definitely/not/here/python")
        # falls through to the repo path; whether that exists is machine-dependent,
        # so just assert it did NOT return the bogus override.
        result = _resolve_face_python()
        assert result != "/definitely/not/here/python"


# ---------------------------------------------------------------------------
# run_facerestore — loud-fail guards + happy-path spawn argv
# ---------------------------------------------------------------------------
class TestRunFacerestore:
    def test_missing_input_exits_2(self):
        with pytest.raises(SystemExit) as ei:
            run_facerestore(_ns(input_image=None))
        assert ei.value.code == 2

    def test_nonexistent_input_exits_2(self, tmp_path):
        with pytest.raises(SystemExit) as ei:
            run_facerestore(_ns(input_image=str(tmp_path / "nope.png")))
        assert ei.value.code == 2

    def test_missing_venv_loud_fail(self, tmp_path, capsys):
        """The core anti-pattern guard: never silent — fail with the recreate steps."""
        src = tmp_path / "src.png"
        src.write_bytes(b"x")
        with patch.object(_facerestore, "_resolve_face_python", return_value=None):
            with pytest.raises(SystemExit) as ei:
                run_facerestore(_ns(input_image=str(src)))
        assert ei.value.code == 2
        err = capsys.readouterr().err
        assert "python/face-venv" in err
        assert "uv venv" in err  # the recreate command is surfaced

    def test_happy_path_spawns_and_surfaces_output(self, tmp_path, capsys):
        """Mock the spawn: verify argv is built from args + the output path is printed."""
        src = tmp_path / "src.png"
        src.write_bytes(b"x")

        def fake_run(argv, **kw):
            # the bridge writes --output; simulate the manifest the bridge emits.
            out = argv[argv.index("--output") + 1]
            manifest = f"__FACE_RESTORE_MANIFEST__\n{{\"ok\": true, \"output\": \"{out}\", " \
                       f"\"model\": \"gfpgan\", \"num_faces\": 1, \"device\": \"mps\"}}\n"
            return MagicMock(returncode=0, stdout=manifest, stderr="")

        with patch.object(_facerestore, "_resolve_face_python", return_value="/p/face-venv/bin/python"), \
             patch.object(_facerestore, "subprocess") as mock_sub, \
             patch("os.path.exists", return_value=True):
            mock_sub.run.side_effect = fake_run
            run_facerestore(_ns(input_image=str(src), face_model="gfpgan", fidelity=0.8, bg_upsampler=True))

        out = capsys.readouterr().out
        assert "Saved:" in out
        assert "_facerestore.png" in out  # canonical output filename shape

    def test_bridge_failure_exits_2(self, tmp_path, capsys):
        src = tmp_path / "src.png"
        src.write_bytes(b"x")
        manifest = "__FACE_RESTORE_MANIFEST__\n{\"ok\": false, \"error\": \"boom\"}\n"
        with patch.object(_facerestore, "_resolve_face_python", return_value="/p/python"), \
             patch.object(_facerestore, "subprocess") as mock_sub, \
             patch("os.path.exists", return_value=True):
            mock_sub.run.return_value = MagicMock(returncode=1, stdout=manifest, stderr="")
            with pytest.raises(SystemExit) as ei:
                run_facerestore(_ns(input_image=str(src)))
        assert ei.value.code == 2
        assert "boom" in capsys.readouterr().err
