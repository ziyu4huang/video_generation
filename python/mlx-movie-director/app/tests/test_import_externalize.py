"""Unit tests for model binary externalization in import-checkpoint and import-vae.

These tests verify the externalization invariant without touching the real
model store or making network calls. Every test is CPU-only and fast.

The invariant: after any import-* command, model.safetensors must be a
relative symlink pointing to ../video_generation__models/<md5>.safetensors.
A large binary committed directly to the repo tree is a bug.
"""

import hashlib
import importlib
import json
import os

import pytest

# Load the command modules via importlib (filenames contain hyphens).
_ckpt_mod = importlib.import_module("app.commands.import-checkpoint")
_vae_mod  = importlib.import_module("app.commands.import-vae")


# ---------------------------------------------------------------------------
# _md5_file
# ---------------------------------------------------------------------------

class TestMd5File:
    def test_known_content(self, tmp_path):
        content = b"hello externalization"
        f = tmp_path / "test.bin"
        f.write_bytes(content)
        expected = hashlib.md5(content).hexdigest()
        assert _ckpt_mod._md5_file(str(f)) == expected

    def test_checkpoint_and_vae_agree(self, tmp_path):
        """Both modules expose an identical _md5_file implementation."""
        content = b"x" * 4096
        f = tmp_path / "test.bin"
        f.write_bytes(content)
        assert _ckpt_mod._md5_file(str(f)) == _vae_mod._md5_file(str(f))

    def test_large_file_chunked_correctly(self, tmp_path):
        """MD5 is consistent even when file is larger than one read chunk."""
        content = b"abcdefgh" * (1 << 17)  # 1 MB, crosses chunk boundary
        f = tmp_path / "big.bin"
        f.write_bytes(content)
        expected = hashlib.md5(content).hexdigest()
        assert _ckpt_mod._md5_file(str(f)) == expected


# ---------------------------------------------------------------------------
# _externalize_weights (import-checkpoint)
# ---------------------------------------------------------------------------

def _make_fake_models_dir(tmp_path):
    """Create a minimal models directory tree with a store-manifest stub."""
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    return models_dir


def _run_externalize(mod, weights_path: str, store_dir: str, models_dir: str):
    """Patch cfg.MODELS_DIR and call _externalize_weights."""
    import unittest.mock as mock
    with mock.patch.object(mod, "cfg") as cfg_mock:
        cfg_mock.MODELS_DIR = models_dir
        # Patch _external_store_dir to use our tmp store
        with mock.patch.object(mod, "_external_store_dir", return_value=store_dir):
            mod._externalize_weights(weights_path)


class TestExternalizeWeights:
    @pytest.fixture()
    def setup(self, tmp_path):
        store = tmp_path / "external_store"
        store.mkdir()
        models = str(tmp_path / "models")
        os.makedirs(models, exist_ok=True)
        # Create a model instance dir with a fake large binary
        inst_dir = tmp_path / "models" / "transformer" / "test-model"
        inst_dir.mkdir(parents=True)
        weights = inst_dir / "model.safetensors"
        content = b"fake weights " * 1000  # ~13 KB, distinct content
        weights.write_bytes(content)
        return {
            "store": str(store),
            "models": models,
            "inst_dir": str(inst_dir),
            "weights": str(weights),
            "content": content,
        }

    def _do_externalize(self, mod, s):
        _run_externalize(mod, s["weights"], s["store"], s["models"])

    @pytest.mark.parametrize("mod_name", ["app.commands.import-checkpoint",
                                           "app.commands.import-vae"])
    def test_original_path_becomes_symlink(self, setup, mod_name):
        mod = importlib.import_module(mod_name)
        self._do_externalize(mod, setup)
        assert os.path.islink(setup["weights"]), (
            "model.safetensors must be a symlink after externalization"
        )

    @pytest.mark.parametrize("mod_name", ["app.commands.import-checkpoint",
                                           "app.commands.import-vae"])
    def test_symlink_target_exists_and_correct_content(self, setup, mod_name):
        mod = importlib.import_module(mod_name)
        self._do_externalize(mod, setup)
        real = os.path.realpath(setup["weights"])
        assert os.path.isfile(real), "Symlink target must exist in external store"
        assert open(real, "rb").read() == setup["content"]

    @pytest.mark.parametrize("mod_name", ["app.commands.import-checkpoint",
                                           "app.commands.import-vae"])
    def test_symlink_target_named_by_md5(self, setup, mod_name):
        mod = importlib.import_module(mod_name)
        self._do_externalize(mod, setup)
        expected_md5 = hashlib.md5(setup["content"]).hexdigest()
        real = os.path.realpath(setup["weights"])
        assert os.path.basename(real) == f"{expected_md5}.safetensors"

    @pytest.mark.parametrize("mod_name", ["app.commands.import-checkpoint",
                                           "app.commands.import-vae"])
    def test_symlink_is_relative_not_absolute(self, setup, mod_name):
        mod = importlib.import_module(mod_name)
        self._do_externalize(mod, setup)
        link_target = os.readlink(setup["weights"])
        assert not os.path.isabs(link_target), (
            f"Symlink must be relative, got: {link_target!r}"
        )

    @pytest.mark.parametrize("mod_name", ["app.commands.import-checkpoint",
                                           "app.commands.import-vae"])
    def test_store_manifest_updated(self, setup, mod_name):
        mod = importlib.import_module(mod_name)
        self._do_externalize(mod, setup)
        manifest = os.path.join(setup["models"], "store-manifest.json")
        assert os.path.exists(manifest), "store-manifest.json must be written"
        with open(manifest) as f:
            doc = json.load(f)
        assert doc.get("count", 0) >= 1
        assert len(doc.get("files", {})) >= 1

    @pytest.mark.parametrize("mod_name", ["app.commands.import-checkpoint",
                                           "app.commands.import-vae"])
    def test_dedup_identical_content(self, setup, mod_name):
        """Second externalization of identical content reuses existing store entry."""
        mod = importlib.import_module(mod_name)
        # First externalization
        self._do_externalize(mod, setup)
        real1 = os.path.realpath(setup["weights"])
        store_files_before = set(os.listdir(setup["store"]))

        # Re-create the same binary at a new path and externalize again
        inst2 = os.path.join(setup["models"], "transformer", "test-model-2")
        os.makedirs(inst2, exist_ok=True)
        w2 = os.path.join(inst2, "model.safetensors")
        open(w2, "wb").write(setup["content"])  # same content

        _run_externalize(mod, w2, setup["store"], setup["models"])

        store_files_after = set(os.listdir(setup["store"]))
        assert store_files_before == store_files_after, (
            "Dedup: no new file should appear in the store for identical content"
        )
        real2 = os.path.realpath(w2)
        assert real1 == real2, "Both symlinks must point to the same store file"


# ---------------------------------------------------------------------------
# _dir_size — must follow symlinks (regression for the size_bytes bug)
# ---------------------------------------------------------------------------

class TestDirSizeFollowsSymlinks:
    """_dir_size must report the REAL model size, dereferencing store symlinks.

    Regression: the old impl skipped symlinks, so after externalization
    (model.safetensors -> store blob) size_bytes came back as the sum of tiny
    config/readme files (~488 B) instead of the multi-GB weight size, and the
    manifest recorded a bogus 488.
    """

    def test_real_file_size(self, tmp_path):
        d = tmp_path / "model"
        d.mkdir()
        (d / "model.safetensors").write_bytes(b"\0" * 5000)
        (d / "config.json").write_text("{}")  # 2 bytes
        assert _ckpt_mod._dir_size(str(d)) == 5000 + 2

    def test_externalized_symlink_reports_blob_size(self, tmp_path):
        """The post-externalization case: model.safetensors is a store symlink."""
        store = tmp_path / "store"
        store.mkdir()
        blob = store / "deadbeef.safetensors"
        blob.write_bytes(b"\0" * 9_000_000)  # 9 MB "weights"

        inst = tmp_path / "model"
        inst.mkdir()
        rel = os.path.relpath(str(blob), str(inst))
        os.symlink(rel, str(inst / "model.safetensors"))
        cfg_bytes = b'{"n":1}'  # 7 bytes
        (inst / "config.json").write_bytes(cfg_bytes)

        # Must follow the symlink and count the 9 MB blob, not skip it.
        assert _ckpt_mod._dir_size(str(inst)) == 9_000_000 + len(cfg_bytes)



# ---------------------------------------------------------------------------
# check-model: non-symlink binary produces a warning
# ---------------------------------------------------------------------------

import importlib as _il
check_model = _il.import_module("app.commands.check-model")
_collect = check_model._collect_models_data

_BASE_MANIFEST = {
    "name": "test-model",
    "type": "transformer",
    "arch": "zimage-turbo",
    "format": "mlx-8bit",
    "description": "test fixture",
    "size_bytes": 50_000_000,
    "created_at": "2026-06-21T00:00:00Z",
    "pipeline": ["zimage-turbo"],
}


def _make_transformer(base, name, *, symlink=True, binary_size=50_000_000):
    """Create a transformer instance with model.safetensors as symlink or real file."""
    inst = base / "transformer" / name
    inst.mkdir(parents=True)

    payload = dict(_BASE_MANIFEST, name=name)
    payload["size_bytes"] = binary_size
    (inst / "manifest.json").write_text(json.dumps(payload))
    (inst / "README.md").write_text("# test\n")
    (inst / "config.json").write_text(json.dumps({"n_layers": 28, "dim": 3072}))

    if symlink:
        # Create a fake external file and symlink to it
        fake_store = base / "_store"
        fake_store.mkdir(exist_ok=True)
        store_file = fake_store / "abc123.safetensors"
        store_file.write_bytes(b"\0" * binary_size)
        rel = os.path.relpath(str(store_file), str(inst))
        os.symlink(rel, str(inst / "model.safetensors"))
    else:
        (inst / "model.safetensors").write_bytes(b"\0" * binary_size)


class TestCheckModelExternalizationRule:
    def test_symlink_weight_no_warning(self, tmp_path):
        """A model.safetensors that IS a symlink must not trigger the warning."""
        _make_transformer(tmp_path, "good-model", symlink=True)
        result = _collect(str(tmp_path))
        symlink_warnings = [w for w in result["warnings"] if "regular file" in w and "good-model" in w]
        assert not symlink_warnings, (
            "No externalization warning expected when weight is already a symlink"
        )

    def test_non_symlink_large_binary_triggers_warning(self, tmp_path):
        """A model.safetensors that is a REAL FILE > 10 MB must trigger the warning."""
        _make_transformer(tmp_path, "bad-model", symlink=False, binary_size=50_000_000)
        result = _collect(str(tmp_path))
        assert any(
            "regular file" in w and "bad-model" in w
            for w in result["warnings"]
        ), (
            "Expected externalization warning for non-symlink large binary, "
            f"got warnings: {result['warnings']}"
        )

    def test_non_symlink_small_file_no_warning(self, tmp_path):
        """A small non-symlink safetensors (< 10 MB) must NOT trigger the warning.

        Some legitimate models (tokenizer configs, tiny test fixtures) are small
        enough that storing them directly is fine.
        """
        _make_transformer(tmp_path, "small-model", symlink=False, binary_size=1_000)
        result = _collect(str(tmp_path))
        externalize_warnings = [w for w in result["warnings"] if "regular file" in w and "small-model" in w]
        assert not externalize_warnings
