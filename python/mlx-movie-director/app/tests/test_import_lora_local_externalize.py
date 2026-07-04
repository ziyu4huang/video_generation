"""Regression test: local-file LoRA import must externalize like the URL-import path.

Bug fixed in this session: `_run_local_import` copied the LoRA straight into
models/lora/<name>/ and never called `_store_to_external`, so a locally
imported LoRA sat as a raw multi-GB binary in the repo tree instead of a
symlink into ../video_generation__models/, unlike every URL-imported LoRA.
Nothing asserted this invariant, so the bug shipped unnoticed until caught
by manual inspection. This test closes that gap.
"""

import argparse
import hashlib
import importlib
import json
import os
import unittest.mock as mock

import pytest

_mod = importlib.import_module("app.commands.import-lora-image")


def _make_args(**overrides):
    defaults = dict(
        arch="zimage-turbo",
        name=None,
        source=None,
        source_url=None,
        link_file=None,
        format=None,
        description=None,
        trigger_words=None,
        test_prompt=None,
        no_ai=True,
        api_url="http://localhost:1234/v1",
        model="qwen/qwen3-vl-4b",
        civitai_token=None,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


@pytest.fixture()
def setup(tmp_path):
    store = tmp_path / "external_store"
    store.mkdir()
    models = tmp_path / "models"
    models.mkdir()

    content = b"fake lora weights " * 1000
    src = tmp_path / "my-lora.safetensors"
    src.write_bytes(content)

    return {
        "store": str(store),
        "models": str(models),
        "src": str(src),
        "content": content,
    }


def _run_local_import(setup, args):
    with mock.patch.object(_mod, "cfg") as cfg_mock:
        cfg_mock.MODELS_DIR = setup["models"]
        with mock.patch.object(_mod, "_external_store_dir", return_value=setup["store"]):
            _mod._run_local_import([setup["src"]], args)


class TestLocalImportExternalizes:
    def test_dest_file_becomes_symlink(self, setup):
        """The local-import path must produce a symlink, not a raw copy."""
        _run_local_import(setup, _make_args())
        dest = os.path.join(setup["models"], "lora", "my-lora", "my-lora.safetensors")
        assert os.path.islink(dest), (
            "Local LoRA import must externalize to a symlink, like the "
            "URL-import path already does"
        )

    def test_symlink_target_lives_under_external_store(self, setup):
        _run_local_import(setup, _make_args())
        dest = os.path.join(setup["models"], "lora", "my-lora", "my-lora.safetensors")
        real = os.path.realpath(dest)
        assert os.path.dirname(real) == os.path.realpath(setup["store"])

    def test_symlink_target_content_matches_source(self, setup):
        _run_local_import(setup, _make_args())
        dest = os.path.join(setup["models"], "lora", "my-lora", "my-lora.safetensors")
        real = os.path.realpath(dest)
        assert open(real, "rb").read() == setup["content"]

    def test_symlink_target_named_by_md5(self, setup):
        _run_local_import(setup, _make_args())
        dest = os.path.join(setup["models"], "lora", "my-lora", "my-lora.safetensors")
        real = os.path.realpath(dest)
        expected_md5 = hashlib.md5(setup["content"]).hexdigest()
        assert os.path.basename(real) == f"{expected_md5}.safetensors"

    def test_symlink_is_relative_not_absolute(self, setup):
        _run_local_import(setup, _make_args())
        dest = os.path.join(setup["models"], "lora", "my-lora", "my-lora.safetensors")
        link_target = os.readlink(dest)
        assert not os.path.isabs(link_target)

    def test_store_manifest_updated(self, setup):
        _run_local_import(setup, _make_args())
        manifest = os.path.join(setup["models"], "store-manifest.json")
        assert os.path.exists(manifest)
        with open(manifest) as f:
            doc = json.load(f)
        assert doc.get("count", 0) >= 1
        key = os.path.join("lora", "my-lora", "my-lora.safetensors")
        assert key in doc.get("files", {})

    def test_manifest_json_size_bytes_matches_real_content(self, setup):
        """size_bytes in the LoRA's own manifest.json must reflect the real
        weight size, not the tiny symlink size (mirrors the checkpoint-side
        _dir_size-must-follow-symlinks regression)."""
        _run_local_import(setup, _make_args())
        manifest_path = os.path.join(setup["models"], "lora", "my-lora", "manifest.json")
        with open(manifest_path) as f:
            manifest = json.load(f)
        assert manifest["size_bytes"] == len(setup["content"])
