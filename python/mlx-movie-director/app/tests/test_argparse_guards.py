"""Regression tests for app/commands/_argparse.py — guard functions and
add_common_generation_args duplicate-safe registration.

These tests verify that guards prevent double-registration of argparse
arguments — a critical invariant when sub-command modules call
add_common_generation_args after already registering some args themselves.
"""

import argparse

import pytest

from app.commands._argparse import (
    _arg_registered,
    _option_registered,
    add_common_generation_args,
)


# ==========================================================================
# _arg_registered
# ==========================================================================

class TestArgRegistered:
    def test_not_registered_before_add(self):
        parser = argparse.ArgumentParser()
        assert _arg_registered(parser, "steps") is False

    def test_registered_after_add(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--steps", type=int)
        assert _arg_registered(parser, "steps") is True

    def test_wrong_dest_returns_false(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--steps", type=int)
        assert _arg_registered(parser, "seed") is False

    def test_empty_parser(self):
        parser = argparse.ArgumentParser()
        assert _arg_registered(parser, "anything") is False

    def test_registered_via_add_argument(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--my-arg", dest="my_arg")
        assert _arg_registered(parser, "my_arg") is True

    def test_positional_arg(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("input", type=str)
        assert _arg_registered(parser, "input") is True

    def test_multiple_args_after_several_additions(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--foo", dest="foo")
        parser.add_argument("--bar", dest="bar")
        assert _arg_registered(parser, "foo") is True
        assert _arg_registered(parser, "bar") is True
        assert _arg_registered(parser, "baz") is False


# ==========================================================================
# _option_registered
# ==========================================================================

class TestOptionRegistered:
    def test_not_registered_before(self):
        parser = argparse.ArgumentParser()
        assert _option_registered(parser, "--steps") is False

    def test_registered_after_add(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--steps", type=int)
        assert _option_registered(parser, "--steps") is True

    def test_different_flag_not_registered(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--steps", type=int)
        assert _option_registered(parser, "--seed") is False

    def test_short_option(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("-v", "--verbose", action="store_true")
        assert _option_registered(parser, "-v") is True
        assert _option_registered(parser, "--verbose") is True

    def test_empty_parser(self):
        parser = argparse.ArgumentParser()
        assert _option_registered(parser, "--anything") is False


# ==========================================================================
# add_common_generation_args — guard behavior
# ==========================================================================

class TestAddCommonGenerationArgs:
    def test_registers_all_args_on_fresh_parser(self):
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        # Spot-check a few key args that should exist
        assert _arg_registered(parser, "steps")
        assert _arg_registered(parser, "seed")
        assert _arg_registered(parser, "prompt")
        assert _arg_registered(parser, "lora_path")
        assert _arg_registered(parser, "vae_path")
        assert _arg_registered(parser, "draft")
        assert _arg_registered(parser, "upscale")
        assert _arg_registered(parser, "count")

    def test_idempotent_when_called_twice(self):
        """Calling add_common_generation_args twice should not raise."""
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        # Second call should be a no-op due to guards
        add_common_generation_args(parser)
        # Verify args are still there exactly as expected
        assert _arg_registered(parser, "steps")

    def test_does_not_overwrite_existing_arg(self):
        """If an arg is pre-registered, the guard skips it."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--steps", type=int, default=99)
        add_common_generation_args(parser)
        # The default from add_common_generation_args is None, but
        # our pre-registered default=99 should survive
        ns, _ = parser.parse_known_args([])
        assert ns.steps == 99, (
            f"Pre-registered default should survive, got {ns.steps}"
        )

    def test_pre_registered_lora_scale_preserved(self):
        """If lora_scale is registered elsewhere first, its default survives."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--lora-scale", type=float, default=None)
        add_common_generation_args(parser)
        ns, _ = parser.parse_known_args([])
        # add_common declares default=1.0, but our pre-reg has default=None
        assert ns.lora_scale is None, (
            f"Pre-registered lora_scale default=None should survive, got {ns.lora_scale}"
        )

    def test_mutually_exclusive_prompt_group(self):
        """--prompt and --prompt-file are mutually exclusive."""
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        with pytest.raises(SystemExit):
            parser.parse_args(["--prompt", "hello", "--prompt-file", "file.txt"])

    def test_argument_names_correct(self):
        """Verify known option strings exist."""
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        assert _option_registered(parser, "--steps")
        assert _option_registered(parser, "--seed")
        assert _option_registered(parser, "--prompt")
        assert _option_registered(parser, "--prompt-file")
        assert _option_registered(parser, "--draft")
        assert _option_registered(parser, "--upscale")
        assert _option_registered(parser, "--count")
        assert _option_registered(parser, "--seed-start")
        assert _option_registered(parser, "--json-summary")

    def test_input_option_guard(self):
        """--input is registered via _option_registered check."""
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        assert _option_registered(parser, "--input")

    def test_denoise_strength_guard(self):
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        assert _arg_registered(parser, "denoise_strength")

    def test_upscale_method_choices(self):
        parser = argparse.ArgumentParser()
        add_common_generation_args(parser)
        action = next(a for a in parser._actions if a.dest == "upscale_method")
        assert sorted(action.choices) == ["esrgan", "seedvr2"]
