"""Tests for run_session threading ctx['events'] into the manifest.

The events field (runtime trace: model loads w/ quant+seconds, VAE overflow) was
wired into Manifest.from_success/from_error but run_session — the context manager
purify/i2i/controlnet use — never passed it, so ctx['events'] was silently dropped.
These tests pin the plumbing: events set in the with-block land in the manifest
on both success and error paths. No GPU — run_session is exercised directly with
a tmp OutputPaths.
"""

import json

import pytest

try:
    import mlx.core as mx  # noqa: F401  (sibling skip-pattern)
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.commands._shared import run_session, OutputPaths
from app.seedvr2.pipeline import SeedVR2Upscaler

_SAMPLE_EVENTS = [
    {"event": "model_loaded", "target": "transformer",
     "detail": {"quant": "4bit", "group_size": 32}, "seconds": 1.23},
    {"event": "vae_overflow", "target": "vae_decode",
     "detail": {"nan_inf_pixels": 12, "total_pixels": 4096, "ratio": 0.0029},
     "seconds": None},
]


def _paths(tmp_path):
    return OutputPaths(
        base_name="t",
        run_file=str(tmp_path / "t.run.json"),
        manifest_file=str(tmp_path / "t.manifest.json"),
        output_file=str(tmp_path / "t.png"),
    )


def _load_manifest(paths):
    with open(paths.manifest_file) as f:
        return json.load(f)


class TestRunSessionEvents:
    def test_success_threads_events(self, tmp_path):
        paths = _paths(tmp_path)
        with run_session(paths, run_config=None) as ctx:
            ctx["outputs"] = [{"path": paths.output_file, "seed": 42,
                               "size_bytes": 10, "width": 64, "height": 64}]
            ctx["models"] = {"seedvr2_dit": {"path": "x"}}
            ctx["events"] = _SAMPLE_EVENTS
        m = _load_manifest(paths)
        assert m["status"] == "success"
        assert m["events"] == _SAMPLE_EVENTS

    def test_error_threads_events(self, tmp_path):
        paths = _paths(tmp_path)
        with pytest.raises(SystemExit):
            with run_session(paths, run_config=None) as ctx:
                ctx["events"] = _SAMPLE_EVENTS
                raise RuntimeError("boom")
        m = _load_manifest(paths)
        assert m["status"] == "error"
        # events recorded before the crash survive into the error manifest
        assert m["events"] == _SAMPLE_EVENTS

    def test_empty_events_becomes_none(self, tmp_path):
        paths = _paths(tmp_path)
        with run_session(paths, run_config=None) as ctx:
            ctx["outputs"] = [{"path": paths.output_file, "seed": 1,
                               "size_bytes": 1, "width": 1, "height": 1}]
            ctx["events"] = []  # nothing recorded (e.g. a clean run)
        m = _load_manifest(paths)
        assert m["status"] == "success"
        assert m["events"] is None  # no clutter on clean runs


class TestUpscalerEventsAttribute:
    def test_default_empty_list(self):
        u = SeedVR2Upscaler(model_size="7b")
        assert u.events == []
        assert isinstance(u.events, list)
