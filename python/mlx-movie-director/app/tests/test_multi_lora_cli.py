"""Tests for multi-LoRA CLI wiring: --lora-path / --lora-scale use action="append"
so repeated flags stack into ordered lists (paired by position)."""

import argparse

from app.commands._shared import add_common_generation_args


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    add_common_generation_args(p)
    return p


def test_lora_path_append_single_wraps_to_list():
    args = _parser().parse_args(["--lora-path", "/a.safetensors"])
    assert args.lora_path == ["/a.safetensors"]


def test_lora_path_append_multiple_stacks_in_order():
    args = _parser().parse_args(["--lora-path", "/a", "--lora-path", "/b"])
    assert args.lora_path == ["/a", "/b"]


def test_lora_scale_append_paired_with_path():
    args = _parser().parse_args([
        "--lora-path", "/a", "--lora-path", "/b",
        "--lora-scale", "0.5", "--lora-scale", "0.8",
    ])
    assert args.lora_path == ["/a", "/b"]
    assert args.lora_scale == [0.5, 0.8]


def test_lora_absent_is_none():
    args = _parser().parse_args([])
    assert args.lora_path is None
    assert args.lora_scale is None
