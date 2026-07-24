"""Unit tests for app/commands/tts.py — edge-tts (cloud) + mlx (local Kokoro
via mlx-audio) narration/dialogue synthesis.

The mlx path is exercised via monkeypatching `tts._synthesize_mlx` — no real
Kokoro model load happens in this suite, keeping it fast and offline.
"""

import argparse
import os

import pytest

from app.commands import tts
from app.commands.tts import (
    PARSER_META,
    _DEFAULT_EDGE_VOICE,
    _DEFAULT_MLX_MODEL,
    _DEFAULT_MLX_VOICE,
    _parse_rate_to_speed,
    _validate_mlx_voice,
    add_args,
    run,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    add_args(parser)
    return parser


class TestParserMeta:
    def test_meta_has_required_keys(self):
        assert "help" in PARSER_META
        assert "description" in PARSER_META


class TestAddArgsDefaults:
    def test_engine_defaults_to_edge_tts(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.engine == "edge-tts"

    def test_engine_choices_include_mlx(self):
        ns, _ = _build_parser().parse_known_args(["--engine", "mlx"])
        assert ns.engine == "mlx"

    def test_engine_rejects_unknown_value(self):
        with pytest.raises(SystemExit):
            _build_parser().parse_known_args(["--engine", "bogus"])

    def test_voice_defaults_to_none(self):
        # Resolved per-engine in run(), not at argparse time.
        ns, _ = _build_parser().parse_known_args([])
        assert ns.voice is None

    def test_mlx_model_default(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.mlx_model == _DEFAULT_MLX_MODEL

    def test_rate_default_unchanged(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.rate == "+0%"


class TestParseRateToSpeed:
    def test_zero_percent_is_speed_one(self):
        assert _parse_rate_to_speed("+0%") == 1.0

    def test_positive_percent(self):
        assert _parse_rate_to_speed("+15%") == pytest.approx(1.15)

    def test_negative_percent(self):
        assert _parse_rate_to_speed("-10%") == pytest.approx(0.90)

    def test_missing_percent_sign_raises(self):
        with pytest.raises(ValueError):
            _parse_rate_to_speed("10")


class TestValidateMlxVoice:
    def test_valid_prefixes_pass(self):
        _validate_mlx_voice("am_michael")
        _validate_mlx_voice("af_heart")
        _validate_mlx_voice("bm_daniel")

    def test_edge_tts_style_voice_exits(self):
        with pytest.raises(SystemExit):
            _validate_mlx_voice("en-US-AriaNeural")


class TestRunDispatchMlx:
    def test_mlx_engine_calls_synthesize_mlx_with_defaults(self, tmp_path, monkeypatch):
        calls = []

        def fake_synth(text, voice, model, speed, out_path):
            calls.append((text, voice, model, speed, out_path))
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)

        out_path = str(tmp_path / "line1.wav")
        args = argparse.Namespace(
            text="You're late.", text_flag=None, text_file=None,
            engine="mlx", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        run(args)

        assert len(calls) == 1
        text, voice, model, speed, path = calls[0]
        assert text == "You're late."
        assert voice == _DEFAULT_MLX_VOICE
        assert model == _DEFAULT_MLX_MODEL
        assert speed == 1.0
        assert path == out_path
        assert os.path.exists(out_path)

    def test_mlx_engine_honors_explicit_voice_and_rate(self, tmp_path, monkeypatch):
        calls = []

        def fake_synth(text, voice, model, speed, out_path):
            calls.append((text, voice, model, speed, out_path))
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)

        out_path = str(tmp_path / "line2.wav")
        args = argparse.Namespace(
            text="I had to lose someone.", text_flag=None, text_file=None,
            engine="mlx", voice="am_adam", mlx_model=_DEFAULT_MLX_MODEL,
            rate="+15%", output=out_path,
        )
        run(args)

        _, voice, _, speed, _ = calls[0]
        assert voice == "am_adam"
        assert speed == pytest.approx(1.15)

    def test_mlx_engine_rejects_edge_tts_voice(self, tmp_path, monkeypatch):
        monkeypatch.setattr(tts, "_synthesize_mlx", lambda *a, **k: None)
        out_path = str(tmp_path / "line.wav")
        args = argparse.Namespace(
            text="Hi", text_flag=None, text_file=None,
            engine="mlx", voice="en-US-AriaNeural", mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        with pytest.raises(SystemExit):
            run(args)

    def test_mlx_engine_defaults_to_wav_output_without_explicit_output(self, monkeypatch):
        """Issue 1: mlx engine should default to .wav, not .mp3."""
        calls = []

        def fake_synth(text, voice, model, speed, out_path):
            calls.append(out_path)
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)
        monkeypatch.setenv("HOME", "/tmp")

        args = argparse.Namespace(
            text="Hello world", text_flag=None, text_file=None,
            engine="mlx", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=None,  # No explicit output
        )
        run(args)

        assert len(calls) == 1
        out_path = calls[0]
        assert out_path.endswith(".wav"), f"Expected .wav output, got: {out_path}"
        assert os.path.exists(out_path)

    def test_mlx_engine_malformed_rate_exits_cleanly(self, tmp_path, monkeypatch):
        """Issue 2: malformed --rate should exit cleanly, not raise ValueError."""
        monkeypatch.setattr(tts, "_synthesize_mlx", lambda *a, **k: None)

        out_path = str(tmp_path / "line.wav")
        args = argparse.Namespace(
            text="Hi", text_flag=None, text_file=None,
            engine="mlx", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="10",  # Missing % sign — malformed
            output=out_path,
        )
        with pytest.raises(SystemExit):
            run(args)


class TestRunDispatchEdgeTts:
    def test_edge_tts_engine_still_used_by_default(self, tmp_path, monkeypatch):
        saved = {}

        class FakeCommunicate:
            def __init__(self, text, voice, rate):
                saved["text"] = text
                saved["voice"] = voice
                saved["rate"] = rate

            async def save(self, out_path):
                with open(out_path, "wb") as f:
                    f.write(b"fake-mp3-bytes")

        fake_edge_tts = type("FakeModule", (), {"Communicate": FakeCommunicate})
        monkeypatch.setitem(__import__("sys").modules, "edge_tts", fake_edge_tts)

        out_path = str(tmp_path / "narration.mp3")
        args = argparse.Namespace(
            text="Hello world", text_flag=None, text_file=None,
            engine="edge-tts", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        run(args)

        assert saved["voice"] == _DEFAULT_EDGE_VOICE
        assert os.path.exists(out_path)


class TestManifestEngineField:
    def test_explicit_output_skips_manifest_and_just_writes_audio(self, tmp_path, monkeypatch):
        # --output given explicitly => run() takes the `paths is None` branch
        # and never writes a run.json/manifest (that's the pre-existing
        # edge-tts behavior too — this just confirms the mlx branch didn't
        # change it). The manifest-writing branch (`paths is not None`, the
        # auto-generated-output path) is exercised for real by a manual smoke
        # test outside this suite (Kokoro is a heavy real model load, not
        # something to run in the unit test loop).
        def fake_synth(text, voice, model, speed, out_path):
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)

        out_path = str(tmp_path / "line.wav")
        args = argparse.Namespace(
            text="Hi", text_flag=None, text_file=None,
            engine="mlx", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        run(args)

        assert os.path.exists(out_path)
        assert not os.path.exists(str(tmp_path / "line.run.json"))
