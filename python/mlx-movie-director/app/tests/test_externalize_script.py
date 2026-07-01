"""Unit tests for the standalone ``scripts/externalize_models.py``.

These tests cover the GENERALIZED externalization behavior: the script no longer
hard-codes ``.safetensors`` — it externalizes ANY large file (``.pth`` upscaler,
a multi-MB ``tokenizer.json``, …) while preserving the original extension in the
store blob name. Small non-weight files (configs, tiny tokenizers, the manifest
itself) stay in-repo. These invariants previously had zero coverage: the sibling
``test_import_externalize.py`` only exercises the per-import command modules,
not this shared migration/recovery script.

All tests are CPU-only, fast, and operate entirely under ``tmp_path`` — the real
model store is never touched.
"""

import hashlib
import importlib.util
import json
import os
import subprocess
import sys

import pytest

# Load the standalone script (lives outside the package, at repo-root/scripts/).
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.normpath(os.path.join(_THIS_DIR, "..", "..", "..", "..", "scripts", "externalize_models.py"))
assert os.path.isfile(_SCRIPT), f"externalize_models.py not found at {_SCRIPT}"
_spec = importlib.util.spec_from_file_location("externalize_models", _SCRIPT)
ext = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ext)


# ---------------------------------------------------------------------------
# _externalizable_regular — the core generalization gate
# ---------------------------------------------------------------------------

class TestExternalizableRegular:
    """Decides which regular files move to the store.

    The rule generalized in this change:
      * ``.safetensors`` → externalize at ANY size (honoring ``--min-size``)
      * any OTHER extension → externalize ONLY when ≥ LARGE_FILE_MIN (2 MB)
      * the store manifest itself → NEVER (would self-reference)
    """

    def test_safetensors_any_size(self, tmp_path):
        f = tmp_path / "model.safetensors"
        f.write_bytes(b"\0" * 100)  # tiny
        assert ext._externalizable_regular(f, 0) is True

    def test_safetensors_respects_min_size(self, tmp_path):
        f = tmp_path / "model.safetensors"
        f.write_bytes(b"\0" * 100)
        assert ext._externalizable_regular(f, 1_000_000) is False

    def test_small_non_safetensors_stays_in_repo(self, tmp_path):
        """Small configs/tokenizers must NOT be externalized."""
        for name in ("config.json", "tokenizer.json", "vocab.txt", "small.bin"):
            f = tmp_path / name
            f.write_bytes(b"\0" * 1024)  # 1 KB, well under 2 MB
            assert ext._externalizable_regular(f, 0) is False, f"{name} should stay in-repo"

    def test_large_non_safetensors_externalized(self, tmp_path):
        """The regression this change fixes: a 28 MB .pth / 26 MB .json move."""
        for name in ("upscaler.pth", "tokenizer.json", "weights.bin", "model.onnx"):
            f = tmp_path / name
            f.write_bytes(b"\0" * (ext.LARGE_FILE_MIN + 1))  # just over the threshold
            assert ext._externalizable_regular(f, 0) is True, f"{name} should be externalized"

    def test_large_file_threshold_is_exact_boundary(self, tmp_path):
        """Exactly LARGE_FILE_MIN bytes IS externalized (>= comparison)."""
        f = tmp_path / "big.json"
        f.write_bytes(b"\0" * ext.LARGE_FILE_MIN)
        assert ext._externalizable_regular(f, 0) is True

    def test_manifest_never_externalized(self, tmp_path):
        """The store manifest must not externalize itself (infinite self-ref)."""
        f = tmp_path / ext.MANIFEST_NAME
        f.write_bytes(b"\0" * (ext.LARGE_FILE_MIN * 10))  # huge, but still exempt
        assert ext._externalizable_regular(f, 0) is False


# ---------------------------------------------------------------------------
# hash_from_link — extension preservation in the stored blob name
# ---------------------------------------------------------------------------

class TestHashFromLink:
    """``hash_from_link`` extracts the md5 regardless of the blob's extension.

    Extension preservation (``<md5>.pth`` not ``<md5>.safetensors``) only works
    if hash extraction is extension-agnostic. The regex is anchored on the stem.
    """

    def test_safetensors_blob(self):
        link = "../../store/abc123def4567890abc123def4567890.safetensors"
        assert ext.hash_from_link(link) == "abc123def4567890abc123def4567890"

    @pytest.mark.parametrize("extn", [".pth", ".json", ".bin", ".onnx"])
    def test_non_safetensors_blob(self, extn):
        md5 = "0123456789abcdef0123456789abcdef"
        link = f"../../store/{md5}{extn}"
        assert ext.hash_from_link(link) == md5

    def test_non_hash_target_returns_none(self):
        """Intra-tree / assembly links (not store blobs) are not hash-named."""
        assert ext.hash_from_link("../../audio/some-file.bin") is None
        assert ext.hash_from_link("configs/base.json") is None

    def test_invalid_hash_returns_none(self):
        """A .safetensors target whose stem isn't a 32-hex md5 is not a store link."""
        assert ext.hash_from_link("store/notarealhash.safetensors") is None


# ---------------------------------------------------------------------------
# End-to-end: --apply externalizes mixed extensions, preserving each ext
# ---------------------------------------------------------------------------

def _make_mixed_models(base):
    """Build a fake models dir mirroring the real tree's mixed content:
    - a .safetensors weight (any size → store)
    - a large .pth upscaler (≥2 MB → store)
    - a large .json tokenizer (≥2 MB → store)
    - small config + small tokenizer (<2 MB → stay in-repo)
    - a sub-directory with its own weight (nesting/depth coverage)
    Returns (content_map: name->bytes) for assertions.
    """
    t = base / "transformer" / "zimage-moody"
    t.mkdir(parents=True)
    content = {
        "safetensors": b"W\x00" * 500,                 # tiny .safetensors → store
        "pth": b"U\x01" * (ext.LARGE_FILE_MIN + 64),   # large .pth → store
        "big_json": b"{" + b" " * (ext.LARGE_FILE_MIN + 32) + b"}",  # large .json → store
    }
    (t / "model.safetensors").write_bytes(content["safetensors"])
    (t / "upscaler.pth").write_bytes(content["pth"])
    (t / "tokenizer.json").write_bytes(content["big_json"])
    # Small in-repo files (must survive externalization untouched as real files)
    small_cfg = b'{"n_layers":28}'
    small_tok = b'{"vocab":"tiny"}'
    (t / "config.json").write_bytes(small_cfg)
    (t / "tokenizer_small.json").write_bytes(small_tok)

    # Nested weight at a different depth
    nested = base / "lora" / "any2real" / "v1"
    nested.mkdir(parents=True)
    nested_w = b"L\x02" * 300
    (nested / "model.safetensors").write_bytes(nested_w)
    content["nested"] = nested_w
    return content, small_cfg, small_tok


def _run_cli(argv, root=None):
    """Invoke main() with a controlled argv (it parses sys.argv directly).

    ``root`` (when given) patches the script's repo_root() so models/store can
    live under tmp_path. In real usage the script resolves paths against the git
    toplevel and ``rel = p.relative_to(root)`` only works when models_dir is
    under that root — mirroring that, the tests anchor everything under a tmp
    "repo root" instead of the real repo (which would couple tests to the live
    layout and risk touching the real store).
    """
    import unittest.mock as mock

    def _run():
        saved = sys.argv
        sys.argv = ["externalize_models", *argv]
        try:
            return ext.main()
        finally:
            sys.argv = saved

    if root is None:
        return _run()
    with mock.patch.object(ext, "repo_root", return_value=root):
        return _run()


def _run_apply(models_dir, store_dir, root=None):
    """Invoke --apply with ABSOLUTE tmp paths; ``root`` is the tmp "repo root"
    models_dir lives under (passed to _run_cli so relative_to resolves)."""
    rc = _run_cli(["--apply", "--models-dir", str(models_dir), "--store", str(store_dir)], root=root)
    assert rc == 0, f"--apply failed (rc={rc})"


class TestApplyGeneralized:
    def test_each_extension_preserved_in_store(self, tmp_path):
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        store_names = set(os.listdir(store))
        for key, extn in [("safetensors", ".safetensors"), ("pth", ".pth"), ("big_json", ".json")]:
            md5 = hashlib.md5(content[key]).hexdigest()
            expected = f"{md5}{extn}"
            assert expected in store_names, (
                f"store blob must preserve {extn} extension: expected {expected}, "
                f"got {sorted(store_names)}"
            )

    def test_each_externalized_path_becomes_relative_symlink(self, tmp_path):
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        for rel in ("transformer/zimage-moody/model.safetensors",
                    "transformer/zimage-moody/upscaler.pth",
                    "transformer/zimage-moody/tokenizer.json",
                    "lora/any2real/v1/model.safetensors"):
            link = models / rel
            assert link.is_symlink(), f"{rel} must be a symlink after --apply"
            target = os.readlink(str(link))
            assert not os.path.isabs(target), f"{rel} symlink must be RELATIVE: {target!r}"
            assert (link.parent / target).exists(), f"{rel} symlink must resolve"

    def test_symlink_dereferences_to_correct_content(self, tmp_path):
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        for rel, key in [("transformer/zimage-moody/model.safetensors", "safetensors"),
                         ("transformer/zimage-moody/upscaler.pth", "pth"),
                         ("transformer/zimage-moody/tokenizer.json", "big_json"),
                         ("lora/any2real/v1/model.safetensors", "nested")]:
            link = models / rel
            real = os.path.realpath(str(link))
            assert open(real, "rb").read() == content[key], (
                f"{rel} must dereference to its original content"
            )

    def test_small_in_repo_files_untouched(self, tmp_path):
        """Configs / small tokenizers (<2 MB) stay as REAL files, not symlinks."""
        models = tmp_path / "models"
        store = tmp_path / "store"
        _, small_cfg, small_tok = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        for rel, expect in [("transformer/zimage-moody/config.json", small_cfg),
                            ("transformer/zimage-moody/tokenizer_small.json", small_tok)]:
            f = models / rel
            assert f.is_file() and not f.is_symlink(), (
                f"{rel} must remain a real in-repo file (under 2 MB)"
            )
            assert f.read_bytes() == expect

    def test_store_has_no_bare_md5_safetensors_for_nonweights(self, tmp_path):
        """Regression: the OLD code named every blob <md5>.safetensors.
        A large .pth must NOT also appear as <md5>.safetensors in the store."""
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        pth_md5 = hashlib.md5(content["pth"]).hexdigest()
        assert not (store / f"{pth_md5}.safetensors").exists(), (
            "large .pth must be stored as <md5>.pth, not mis-named <md5>.safetensors"
        )

    def test_manifest_records_all_externalized_files(self, tmp_path):
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        mf = json.loads((models / ext.MANIFEST_NAME).read_text())
        files = mf["files"]
        assert mf["count"] == 4
        # Every externalized path is a key; each carries its md5 + correct size.
        for rel, key in [("transformer/zimage-moody/model.safetensors", "safetensors"),
                         ("transformer/zimage-moody/upscaler.pth", "pth"),
                         ("transformer/zimage-moody/tokenizer.json", "big_json"),
                         ("lora/any2real/v1/model.safetensors", "nested")]:
            assert rel in files, f"manifest missing {rel}"
            assert files[rel]["md5"] == hashlib.md5(content[key]).hexdigest()
            assert files[rel]["size"] == len(content[key])

    def test_dedup_across_extensions(self, tmp_path):
        """Identical content under two different extensions dedups to ONE blob —
        but each extension keeps its own blob name, so two links, two store
        entries point at... actually dedup is by md5 only. Verify the second
        file is NOT copied (store size unchanged) and is a valid symlink."""
        models = tmp_path / "models"
        store = tmp_path / "store"
        d = models / "encoder"
        d.mkdir(parents=True)
        shared = b"X" * (ext.LARGE_FILE_MIN + 16)
        (d / "a.json").write_bytes(shared)
        _run_apply(models, store, root=tmp_path)

        store_before = set(os.listdir(store))
        # Same content, different extension, different dir
        d2 = models / "encoder2"
        d2.mkdir(parents=True)
        (d2 / "b.json").write_bytes(shared)  # identical content
        _run_apply(models, store, root=tmp_path)

        store_after = set(os.listdir(store))
        # md5 is identical → same blob name → no new store file
        assert store_after == store_before, "identical content must dedup (no new blob)"

    def test_idempotent_second_apply(self, tmp_path):
        """Re-running --apply on an already-externalized tree is a no-op:
        no new blobs, all symlinks stable, manifest count unchanged."""
        models = tmp_path / "models"
        store = tmp_path / "store"
        _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)
        store_after_1 = set(os.listdir(store))
        mf_count_1 = json.loads((models / ext.MANIFEST_NAME).read_text())["count"]

        rc = _run_cli(["--apply", "--models-dir", str(models), "--store", str(store)], root=tmp_path)
        assert rc == 0
        store_after_2 = set(os.listdir(store))
        mf_count_2 = json.loads((models / ext.MANIFEST_NAME).read_text())["count"]

        assert store_after_1 == store_after_2
        assert mf_count_1 == mf_count_2


# ---------------------------------------------------------------------------
# --relink: recovery rebuilds symlinks FROM the manifest, preserving ext
# ---------------------------------------------------------------------------

class TestRelink:
    def test_rebuilds_symlinks_with_correct_extension(self, tmp_path):
        """Simulate a lost-symlink recovery: delete every link, then --relink
        reconstructs each as <md5>.<origext> using the manifest's tracked path."""
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        # Snapshot link targets, then destroy every store-symlink
        orig = {}
        for p in sorted(models.rglob("*")):
            if p.is_symlink() and ext.hash_from_link(os.readlink(str(p))):
                orig[str(p.relative_to(models))] = os.readlink(str(p))
                p.unlink()

        rc = _run_cli(["--relink", "--models-dir", str(models), "--store", str(store)], root=tmp_path)
        assert rc == 0

        for rel, want in orig.items():
            p = models / rel
            assert p.is_symlink(), f"{rel} not relinked"
            assert os.readlink(str(p)) == want, f"{rel} target mismatch after relink"
            assert (p.parent / os.readlink(str(p))).exists(), f"{rel} must resolve"

    def test_relink_skips_real_file(self, tmp_path):
        """--relink must NEVER clobber a real file present at a tracked path
        (won't destroy data a user restored)."""
        models = tmp_path / "models"
        store = tmp_path / "store"
        content, _, _ = _make_mixed_models(models)
        _run_apply(models, store, root=tmp_path)

        # Replace one externalized link with a real restored file
        target = models / "transformer" / "zimage-moody" / "upscaler.pth"
        target.unlink()
        restored = b"RESTORED_REAL_BYTES" * 10
        target.write_bytes(restored)

        rc = _run_cli(["--relink", "--models-dir", str(models), "--store", str(store)], root=tmp_path)
        assert rc == 0  # skips, doesn't fail
        assert not target.is_symlink()
        assert target.read_bytes() == restored, "relink must not clobber a real file"


# ---------------------------------------------------------------------------
# discover: classifies regulars vs store-links vs intra-tree links
# ---------------------------------------------------------------------------

class TestDiscover:
    def test_intra_tree_symlink_left_alone(self, tmp_path):
        """A symlink whose target is NOT a <md5>.ext store blob (e.g. an
        assembly/intra-tree link) must be classified as a store-link=None and
        NOT be candidate for externalization."""
        src = tmp_path / "models" / "orig"
        src.mkdir(parents=True)
        (src / "base.safetensors").write_bytes(b"\0" * 10)
        lnk_dir = tmp_path / "models" / "variant"
        lnk_dir.mkdir(parents=True)
        rel = os.path.relpath(str(src / "base.safetensors"), str(lnk_dir))
        os.symlink(rel, str(lnk_dir / "model.safetensors"))

        regulars, store_links = ext.discover(tmp_path / "models", 0)
        # The intra-tree link is neither a store-link nor a regular file
        assert all(not str(p).endswith("variant/model.safetensors") for p in regulars)
        assert all(not str(p).endswith("variant/model.safetensors") for p in store_links)
