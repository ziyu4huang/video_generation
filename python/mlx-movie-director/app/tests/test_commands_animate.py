"""Unit tests for app/commands/animate.py — the frame-to-frame animation stub.

Covers the fully CPU-pure surface: PARSER_META metadata, add_args() argparse
registration (defaults, types, choices, option strings), and the run() stub's
"not yet implemented" message + sys.exit(0).

No MLX / GPU / model loading is touched — the entire module is argparse glue
plus a print-and-exit stub, so it runs under plain pytest with no flags.
"""

import argparse

import pytest

from app.commands import animate
from app.commands.animate import PARSER_META, add_args, run


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    add_args(parser)
    return parser


class TestParserMeta:
    def test_meta_has_required_keys(self):
        assert "help" in PARSER_META
        assert "description" in PARSER_META

    def test_help_is_nonempty_string(self):
        assert isinstance(PARSER_META["help"], str)
        assert PARSER_META["help"].strip()

    def test_description_mentions_coming_soon_or_not_implemented(self):
        # The stub explicitly advertises itself as not-yet-implemented.
        text = (PARSER_META["description"] + " " + PARSER_META["help"]).lower()
        assert "not yet implemented" in text or "coming soon" in text

    def test_description_mentions_planned_usage_examples(self):
        # The docstring surfaces planned usage; guard against accidentally
        # dropping the example that GUI schema help may surface.
        assert "run.py animate" in PARSER_META["description"]


class TestAddArgsDefaults:
    def test_animation_specific_defaults(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.width == 640
        assert ns.height == 960
        assert ns.frames == 24
        assert ns.fps == 12

    def test_conditioning_defaults_are_none(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.input_image is None
        assert ns.control_image is None
        assert ns.control_type is None

    def test_control_strength_default(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.control_strength == 1.0

    def test_types_are_coerced(self):
        ns, _ = _build_parser().parse_known_args([
            "--width", "320", "--height", "480",
            "--frames", "12", "--fps", "6",
            "--control-strength", "0.5",
        ])
        assert isinstance(ns.width, int)
        assert isinstance(ns.height, int)
        assert isinstance(ns.frames, int)
        assert isinstance(ns.fps, int)
        assert isinstance(ns.control_strength, float)
        assert ns.width == 320
        assert ns.height == 480
        assert ns.frames == 12
        assert ns.fps == 6
        assert ns.control_strength == 0.5


class TestAddArgsRegistration:
    def test_common_generation_args_inherited(self):
        # add_args delegates to add_common_generation_args, so a couple of
        # well-known common dests must be present.
        parser = _build_parser()
        dests = {a.dest for a in parser._actions}
        assert "prompt" in dests
        assert "steps" in dests
        assert "seed" in dests

    def test_animation_specific_dests_present(self):
        dests = {a.dest for a in _build_parser()._actions}
        for d in ("width", "height", "frames", "fps",
                  "input_image", "control_image",
                  "control_type", "control_strength"):
            assert d in dests, f"missing dest: {d}"

    def test_control_type_choices(self):
        action = next(a for a in _build_parser()._actions
                      if a.dest == "control_type")
        assert action.choices == ["pose", "depth", "canny", "normal"]
        assert action.default is None

    def test_control_type_rejects_invalid_choice(self):
        with pytest.raises(SystemExit):
            _build_parser().parse_args(["--control-type", "scribble"])

    def test_control_type_accepts_each_valid_choice(self):
        for choice in ("pose", "depth", "canny", "normal"):
            ns, _ = _build_parser().parse_known_args(["--control-type", choice])
            assert ns.control_type == choice

    def test_metavar_used_for_path_args(self):
        # --input-image and --control-image use metavar="PATH".
        path_actions = {a.dest: a for a in _build_parser()._actions
                        if a.dest in ("input_image", "control_image")}
        assert path_actions["input_image"].metavar == "PATH"
        assert path_actions["control_image"].metavar == "PATH"


class TestRunStub:
    def test_run_prints_not_implemented_and_exits_zero(self, capsys):
        # run() is a stub: prints a notice then sys.exit(0).
        with pytest.raises(SystemExit) as excinfo:
            run(argparse.Namespace())
        assert excinfo.value.code == 0
        out = capsys.readouterr().out
        assert "not yet implemented" in out.lower()

    def test_run_mentions_controlnet_or_animation(self, capsys):
        with pytest.raises(SystemExit):
            run(argparse.Namespace())
        out = capsys.readouterr().out.lower()
        assert "animation" in out or "controlnet" in out

    def test_run_module_reexport_is_same_callable(self):
        # Defensive: ensure both `from animate import run` and the attribute on
        # the module agree (guards against accidental shadowing).
        assert animate.run is run
