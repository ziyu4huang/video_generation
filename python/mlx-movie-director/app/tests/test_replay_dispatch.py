"""Tests for replay dispatch of hand-written image run.json files.

The manifest/audit work (PR #34) made purify / i2i / controlnet write .run.json
siblings, but `replay` only dispatched versioned RunConfig files — these new
run.json were unreachable. These tests verify the new dispatch path: replay
detects `command=="image"` + `action`, rebuilds an argparse Namespace from the
stored dict, and routes to the right sub-action through app.commands.image.run.

No models load and no GPU is touched: the leaf `run_*` functions are stubbed, so
this exercises only the format detection + Namespace reconstruction + routing.
"""

import argparse
import json

import pytest

try:
    import mlx.core as mx  # noqa: F401  (sibling skip-pattern; dispatch is pure)
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.commands import image as _image
from app.commands import replay as _replay


def _write_run_json(tmp_path, data, name="test.run.json"):
    p = tmp_path / name
    p.write_text(json.dumps(data))
    return str(p)


def _stub():
    """Return (fn, calls) where fn records the Namespace it receives."""
    calls = []

    def _rec(args):
        calls.append(args)

    return _rec, calls


class TestReplayImageDispatch:
    """command=='image' + action -> Namespace -> image.run -> sub-action."""

    def test_purify(self, tmp_path, monkeypatch):
        fn, calls = _stub()
        monkeypatch.setattr(_image._purify, "run_purify", fn)
        data = {
            "command": "image", "action": "purify", "backend": "seedvr2",
            "input_image": "/tmp/x.png", "purify_mode": "redraw",
            "softness": 0.8, "softness_override": 0.9, "resolution": "same",
            "seed": 42, "output": "/tmp/out.png",
        }
        _replay.run(argparse.Namespace(file=_write_run_json(tmp_path, data)))
        assert len(calls) == 1
        ns = calls[0]
        assert ns.action == "purify"
        assert ns.backend == "seedvr2"
        assert ns.purify_mode == "redraw"
        assert ns.seed == 42
        # replay-fidelity field carried through
        assert ns.softness_override == 0.9
        # control-flow defaults the dispatcher reads but run.json omits
        assert ns.list_loras is False
        assert ns.self_test is None

    def test_i2i(self, tmp_path, monkeypatch):
        fn, calls = _stub()
        monkeypatch.setattr(_image._i2i, "run_i2i", fn)
        data = {
            "command": "image", "action": "i2i", "pipeline": "zimage",
            "input_image": "/tmp/x.png", "prompt": "p",
            "denoise_strength": 0.4, "steps": 9, "seed": 42,
            "width": 1600, "height": 1664,
        }
        _replay.run(argparse.Namespace(file=_write_run_json(tmp_path, data)))
        assert len(calls) == 1
        ns = calls[0]
        assert ns.action == "i2i"
        assert ns.denoise_strength == 0.4
        assert ns.width == 1600
        assert ns.pipeline == "zimage"

    def test_controlnet(self, tmp_path, monkeypatch):
        fn, calls = _stub()
        monkeypatch.setattr(_image._controlnet, "run_controlnet", fn)
        data = {
            "command": "image", "action": "controlnet", "pipeline": "zimage",
            "input_image": "/tmp/x.png", "controlnet_type": "canny",
            "controlnet_strength": 1.0, "steps": 20, "seed": 7,
        }
        _replay.run(argparse.Namespace(file=_write_run_json(tmp_path, data)))
        assert len(calls) == 1
        assert calls[0].action == "controlnet"
        assert calls[0].controlnet_type == "canny"


class TestReplayRunConfigSeparation:
    """A versioned RunConfig (command != bare 'image') must NOT route to image."""

    def test_text2img_uses_runconfig_path(self, tmp_path, monkeypatch):
        gen_calls = []
        monkeypatch.setattr(_replay, "execute_generation",
                            lambda rc, pipeline_type="zimage": gen_calls.append((rc, pipeline_type)))
        image_calls = []
        monkeypatch.setattr(_replay, "_replay_image", lambda d: image_calls.append(d))
        # Minimal valid RunConfig: all dataclass fields default; command="text2img"
        # dispatches via the existing in-set branch (NOT bare "image").
        data = {"schema_version": 14, "command": "text2img", "seed": 99}
        _replay.run(argparse.Namespace(file=_write_run_json(tmp_path, data)))
        assert len(gen_calls) == 1
        assert gen_calls[0][0].command == "text2img"
        assert image_calls == []  # never treated as a hand-written image run.json
