"""Regression tests for app/commands/video-storyboard.py — the storyboard→video bridge.

Mocks both halves (image-storyboard's panel generation, video-relay's segment
generation) — this module's only real job is translating a storyboard payload's
`shots` into `--relay-prompts`/`--relay-images`, so tests verify that
translation, not real generation.
"""

import importlib
import json
import types

import pytest


def _mod():
    return importlib.import_module("app.commands.video-storyboard")


def _fake_shot(scene_id: str, prompt: str, image: str) -> dict:
    return {
        "scene_id": scene_id,
        "character_id": "hero",
        "hero_moment": False,
        "character_locked": True,
        "prompt": prompt,
        "image": image,
        "manifest": f"/fake/{scene_id}.manifest.json",
    }


class TestRunStoryboardVideo:
    def test_generates_panels_then_derives_relay_args(self, monkeypatch):
        mod = _mod()
        shots = [
            _fake_shot("beat-1", "a detective in an alley, wide shot", "/fake/beat-1.png"),
            _fake_shot("beat-2", "the detective in a diner, medium shot", "/fake/beat-2.png"),
        ]
        payload = {"shots": shots, "out_dir": "/fake/out"}

        monkeypatch.setattr(mod._img_storyboard, "run_storyboard", lambda args: payload)

        captured = {}
        def fake_run_relay(args):
            captured["relay_prompts"] = args.relay_prompts
            captured["relay_images"] = args.relay_images
            captured["relay_prompt_file"] = args.relay_prompt_file
        monkeypatch.setattr(mod._relay, "run_relay", fake_run_relay)

        args = types.SimpleNamespace(storyboard_json=None, story="a detective story")
        mod.run_storyboard_video(args)

        assert captured["relay_prompts"] == [
            "a detective in an alley, wide shot",
            "the detective in a diner, medium shot",
        ]
        assert captured["relay_images"] == ["/fake/beat-1.png", "/fake/beat-2.png"]
        assert captured["relay_prompt_file"] is None

    def test_storyboard_json_path_skips_regeneration(self, monkeypatch, tmp_path):
        mod = _mod()
        shots = [_fake_shot("beat-1", "a wide establishing shot", "/fake/beat-1.png")]
        sb_path = tmp_path / "storyboard.json"
        sb_path.write_text(json.dumps({"shots": shots}))

        def fail_if_called(args):
            raise AssertionError("should not regenerate panels when --storyboard-json is given")
        monkeypatch.setattr(mod._img_storyboard, "run_storyboard", fail_if_called)

        captured = {}
        monkeypatch.setattr(mod._relay, "run_relay", lambda args: captured.setdefault("ran", True))

        args = types.SimpleNamespace(storyboard_json=str(sb_path))
        mod.run_storyboard_video(args)

        assert captured.get("ran") is True

    def test_no_shots_raises(self, monkeypatch):
        mod = _mod()
        monkeypatch.setattr(mod._img_storyboard, "run_storyboard", lambda args: {"shots": []})
        args = types.SimpleNamespace(storyboard_json=None)
        with pytest.raises(RuntimeError, match="no shots"):
            mod.run_storyboard_video(args)

    def test_shot_missing_image_raises(self, monkeypatch):
        mod = _mod()
        shots = [_fake_shot("beat-1", "prompt", "")]
        monkeypatch.setattr(mod._img_storyboard, "run_storyboard", lambda args: {"shots": shots})
        args = types.SimpleNamespace(storyboard_json=None)
        with pytest.raises(RuntimeError, match="no image"):
            mod.run_storyboard_video(args)

    def test_preserves_panel_order(self, monkeypatch):
        """Relay segment order must match storyboard panel order — no reordering."""
        mod = _mod()
        shots = [_fake_shot(f"beat-{i}", f"prompt {i}", f"/fake/{i}.png") for i in range(5)]
        monkeypatch.setattr(mod._img_storyboard, "run_storyboard", lambda args: {"shots": shots})

        captured = {}
        def fake_run_relay(args):
            captured["images"] = args.relay_images
        monkeypatch.setattr(mod._relay, "run_relay", fake_run_relay)

        args = types.SimpleNamespace(storyboard_json=None)
        mod.run_storyboard_video(args)

        assert captured["images"] == [f"/fake/{i}.png" for i in range(5)]
