"""Mock-based integration tests for _shared.py — run_session, execute_generation,
execute_ab_test, execute_upscale.

All heavy deps (Manifest, ZImagePipeline, etc.) are imported INSIDE the
function bodies, so we patch at their source modules.
"""

import json
import os
import posixpath
from unittest.mock import MagicMock, patch

import pytest

from app.commands._shared import (
    run_session,
    execute_generation,
    execute_ab_test,
    execute_upscale,
    OutputPaths,
)
from app import config as cfg
from app.run_config import RunConfig


# ==========================================================================
# Fixture: proper Manifest mock class
# ==========================================================================

@pytest.fixture
def mock_manifest_class():
    """Return a MagicMock that acts as the Manifest class.

    Manifest.from_success() and Manifest.from_error() return a manifest
    instance that has .to_json().
    """
    mf_cls = MagicMock()
    mf_instance = MagicMock()
    mf_cls.from_success.return_value = mf_instance
    mf_cls.from_error.return_value = mf_instance
    # When called as Manifest(...), return the instance
    mf_cls.return_value = mf_instance
    return mf_cls


# ==========================================================================
# run_session — context manager
# ==========================================================================

class TestRunSession:
    def _paths(self, tmp_path) -> OutputPaths:
        return OutputPaths(
            base_name="test", run_file=str(tmp_path / "t.run.json"),
            manifest_file=str(tmp_path / "t.manifest.json"),
            output_file=str(tmp_path / "t.png"),
        )

    def test_success_creates_manifest(self, tmp_path, mock_manifest_class):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with run_session(paths, run_config=RunConfig()) as ctx:
                ctx["timings"] = {"denoise": 1.5}
                ctx["outputs"] = [{"path": "/out.png", "seed": 42}]
                ctx["models"] = {"t": {"size": 100}}

        mock_manifest_class.from_success.assert_called_once()
        instance = mock_manifest_class.from_success.return_value
        instance.to_json.assert_called_once_with(paths.manifest_file)

    def test_success_prints_paths(self, tmp_path, mock_manifest_class, capsys):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with run_session(paths, run_config=RunConfig()) as ctx:
                ctx["timings"] = {}
                ctx["outputs"] = []
                ctx["models"] = {}

        out = capsys.readouterr().out
        assert paths.run_file in out
        assert paths.manifest_file in out

    def test_error_creates_error_manifest(self, tmp_path, mock_manifest_class):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with pytest.raises(SystemExit):
                with run_session(paths, run_config=RunConfig()) as ctx:
                    ctx["timings"] = {}
                    ctx["outputs"] = []
                    ctx["models"] = {}
                    raise RuntimeError("GPU OOM")

        mock_manifest_class.from_error.assert_called_once()
        call_args_str = str(mock_manifest_class.from_error.call_args)
        assert "GPU OOM" in call_args_str

    def test_error_prints_to_stderr(self, tmp_path, mock_manifest_class, capsys):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with pytest.raises(SystemExit):
                with run_session(paths, run_config=RunConfig()) as ctx:
                    ctx["timings"] = {}
                    ctx["outputs"] = []
                    ctx["models"] = {}
                    raise ValueError("bad prompt")

        err = capsys.readouterr().err
        assert "bad prompt" in err

    def test_error_json_summary(self, tmp_path, mock_manifest_class, capsys):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with pytest.raises(SystemExit):
                with run_session(paths, run_config=RunConfig(), json_summary=True) as ctx:
                    ctx["timings"] = {}
                    ctx["outputs"] = [{"path": "/out.png"}]
                    ctx["models"] = {}
                    raise ValueError("bad prompt")

        out = capsys.readouterr().out
        assert "JSON_SUMMARY:" in out
        d = json.loads(out.split("JSON_SUMMARY:", 1)[1].strip())
        assert d["status"] == "error"
        assert "bad prompt" in d["error"]

    def test_success_json_summary(self, tmp_path, mock_manifest_class, capsys):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with run_session(paths, run_config=RunConfig(), json_summary=True) as ctx:
                ctx["timings"] = {}
                ctx["outputs"] = [{"path": "/out.png"}]
                ctx["models"] = {}

        out = capsys.readouterr().out
        assert "JSON_SUMMARY:" in out
        d = json.loads(out.split("JSON_SUMMARY:", 1)[1].strip())
        assert d["status"] == "success"

    def test_no_config_still_writes_manifest(self, tmp_path, mock_manifest_class):
        paths = self._paths(tmp_path)
        with patch("app.manifest.Manifest", mock_manifest_class):
            with run_session(paths, run_config=None) as ctx:
                ctx["timings"] = {}
                ctx["outputs"] = []
                ctx["models"] = {}

        mock_manifest_class.from_success.assert_called_once()


# ==========================================================================
# execute_generation — full orchestration (uses tmp_path for file ops)
# ==========================================================================

class TestExecuteGeneration:
    def test_success_returns_manifest_path(self, tmp_path, mock_manifest_class):
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(
            "app.commands._shared.make_output_paths",
            lambda **kw: OutputPaths(
                base_name="t", run_file=str(tmp_path / "t.run.json"),
                manifest_file=str(tmp_path / "t.manifest.json"),
                output_file=str(tmp_path / "t.png"),
            ),
        )
        mock_pipe = MagicMock()
        r = MagicMock()
        r.image.save = MagicMock()
        r.image.width = 640
        r.image.height = 960
        r.timings = {}
        mock_pipe.generate.return_value = r

        with patch("app.pipeline.ZImagePipeline", return_value=mock_pipe), \
             patch("app.manifest.Manifest", mock_manifest_class), \
             patch("app.manifest.collect_model_fingerprint", return_value={}), \
             patch.object(posixpath, "getsize", return_value=12345):

            rc = RunConfig(prompt="test", width=640, height=960, steps=4, seed=42)
            result = execute_generation(rc, pipeline_type="zimage")

        assert result == str(tmp_path / "t.manifest.json")
        mock_pipe.generate.assert_called_once()

    def test_kwargs_passed(self, tmp_path, mock_manifest_class):
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(
            "app.commands._shared.make_output_paths",
            lambda **kw: OutputPaths(
                base_name="t", run_file=str(tmp_path / "t.run.json"),
                manifest_file=str(tmp_path / "t.manifest.json"),
                output_file=str(tmp_path / "t.png"),
            ),
        )
        mock_pipe = MagicMock()
        r = MagicMock()
        r.image.save = MagicMock()
        r.image.width = 640
        r.image.height = 960
        r.timings = {}
        mock_pipe.generate.return_value = r

        with patch("app.pipeline.ZImagePipeline", return_value=mock_pipe), \
             patch("app.manifest.Manifest", mock_manifest_class), \
             patch("app.manifest.collect_model_fingerprint", return_value={}), \
             patch.object(posixpath, "getsize", return_value=12345):

            rc = RunConfig(prompt="hello", width=640, height=960, steps=4, seed=99)
            execute_generation(rc, pipeline_type="zimage")

        kw = mock_pipe.generate.call_args.kwargs
        assert kw["prompt"] == "hello"
        assert kw["seed"] == 99

    def test_error_exits(self, tmp_path, mock_manifest_class):
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(
            "app.commands._shared.make_output_paths",
            lambda **kw: OutputPaths(
                base_name="t", run_file=str(tmp_path / "t.run.json"),
                manifest_file=str(tmp_path / "t.manifest.json"),
                output_file=str(tmp_path / "t.png"),
            ),
        )
        mock_pipe = MagicMock()
        mock_pipe.generate.side_effect = RuntimeError("fail")

        with patch("app.pipeline.ZImagePipeline", return_value=mock_pipe), \
             patch("app.manifest.Manifest", mock_manifest_class), \
             patch("app.manifest.collect_model_fingerprint", return_value={}):

            rc = RunConfig(prompt="test", width=640, height=960, steps=4)
            with pytest.raises(SystemExit):
                execute_generation(rc, pipeline_type="zimage")

    def test_json_summary_on_success(self, tmp_path, mock_manifest_class, capsys):
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(
            "app.commands._shared.make_output_paths",
            lambda **kw: OutputPaths(
                base_name="t", run_file=str(tmp_path / "t.run.json"),
                manifest_file=str(tmp_path / "t.manifest.json"),
                output_file=str(tmp_path / "t.png"),
            ),
        )
        mock_pipe = MagicMock()
        r = MagicMock()
        r.image.save = MagicMock()
        r.image.width = 640
        r.image.height = 960
        r.timings = {}
        mock_pipe.generate.return_value = r

        with patch("app.pipeline.ZImagePipeline", return_value=mock_pipe), \
             patch("app.manifest.Manifest", mock_manifest_class), \
             patch("app.manifest.collect_model_fingerprint", return_value={}), \
             patch.object(posixpath, "getsize", return_value=12345):

            rc = RunConfig(prompt="test", width=640, height=960, steps=4)
            execute_generation(rc, pipeline_type="zimage", json_summary=True)

        out = capsys.readouterr().out
        assert "JSON_SUMMARY:" in out
        d = json.loads(out.split("JSON_SUMMARY:", 1)[1].strip())
        assert d["status"] == "success"

    def test_flux2_pipeline(self, tmp_path, mock_manifest_class):
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(
            "app.commands._shared.make_output_paths",
            lambda **kw: OutputPaths(
                base_name="t", run_file=str(tmp_path / "t.run.json"),
                manifest_file=str(tmp_path / "t.manifest.json"),
                output_file=str(tmp_path / "t.png"),
            ),
        )
        mock_pipe = MagicMock()
        r = MagicMock()
        r.image.save = MagicMock()
        r.image.width = 640
        r.image.height = 960
        r.timings = {}
        mock_pipe.generate.return_value = r

        with patch("app.flux2_t2i_pipeline.Flux2KleinT2IPipeline", return_value=mock_pipe), \
             patch("app.manifest.Manifest", mock_manifest_class), \
             patch("app.manifest.collect_model_fingerprint_flux2", return_value={}), \
             patch.object(posixpath, "getsize", return_value=12345):

            rc = RunConfig(prompt="test", width=640, height=960, steps=4)
            result = execute_generation(rc, pipeline_type="flux2-klein")

        assert result is not None


# ==========================================================================
# execute_ab_test
# ==========================================================================

class TestExecuteABTest:
    def test_runs_both_configs(self, tmp_path, mock_manifest_class):
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(
            "app.commands._shared.make_output_paths",
            lambda **kw: OutputPaths(
                base_name="ab", run_file=str(tmp_path / "ab.run.json"),
                manifest_file=str(tmp_path / "ab.manifest.json"),
                output_file=str(tmp_path / "ab.png"),
            ),
        )

        # image.save must create a real file so Image.open() succeeds later
        def _fake_save(path):
            # Touch the file so os.path.getsize and Image.open work
            with open(path, "w") as f:
                f.write("")

        r = MagicMock()
        r.image.save = _fake_save
        r.image.width = 640
        r.image.height = 960
        r.timings = {}

        zimage_pipe = MagicMock()
        zimage_pipe.generate.return_value = r
        flux2_pipe = MagicMock()
        flux2_pipe.generate.return_value = r

        mock_img = MagicMock()
        mock_img.size = (640, 960)

        with patch("app.pipeline.ZImagePipeline", return_value=zimage_pipe), \
             patch("app.flux2_t2i_pipeline.Flux2KleinT2IPipeline", return_value=flux2_pipe), \
             patch("app.manifest.Manifest", mock_manifest_class), \
             patch("app.manifest.collect_model_fingerprint", return_value={}), \
             patch("app.manifest.collect_model_fingerprint_flux2", return_value={}), \
             patch.object(cfg, "OUTPUT_DIR", str(tmp_path)), \
             patch("PIL.Image.open", return_value=mock_img), \
             patch.object(posixpath, "getsize", return_value=12345), \
             patch("app.commands._shared._stitch_horizontal") as stitch:

            stitch.return_value = MagicMock()
            stitch.return_value.save = MagicMock()

            rc_a = RunConfig(prompt="A", seed=42, lora_scale=0.5)
            rc_b = RunConfig(prompt="B", seed=42, lora_scale=1.0)
            execute_ab_test(rc_a, rc_b)

        assert zimage_pipe.generate.call_count == 1
        assert flux2_pipe.generate.call_count == 1


# ==========================================================================
# execute_upscale — standalone ESRGAN
# ==========================================================================

class TestExecuteUpscale:
    def test_esrgan(self, tmp_path):
        input_path = str(tmp_path / "input.png")
        output_path = str(tmp_path / "output.png")
        model_path = str(tmp_path / "model.pth")
        tmp_path.joinpath("input.png").write_bytes(b"dummy")
        tmp_path.joinpath("model.pth").write_bytes(b"weights")

        with patch("PIL.Image.open") as mock_open, \
             patch("app.pipeline.ZImagePipeline") as mock_pipe_cls:

            # Image.open returns an Image object; .convert("RGB") returns another.
            mock_converted = MagicMock()
            mock_converted.size = (640, 960)
            mock_img = MagicMock()
            mock_img.convert.return_value = mock_converted
            mock_open.return_value = mock_img

            mock_upscaled = MagicMock()
            mock_upscaled.size = (2560, 3840)
            mock_pipe_cls.upscale_esrgan.return_value = mock_upscaled

            execute_upscale(input_path=input_path, model_path=model_path, output_path=output_path)

            mock_pipe_cls.upscale_esrgan.assert_called_once()
