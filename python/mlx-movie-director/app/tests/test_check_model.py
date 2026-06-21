"""Regression tests for app/commands/check-model.py — manifest validation rules.

Drives the validator's ``_collect_models_data()`` against a temp models dir and
asserts on its ``errors`` / ``warnings`` / ``orphan_dirs`` lists. Each test
isolates one validation rule. The module name is hyphenated, so it is imported
via ``importlib`` (the same mechanism ``app/cli.py`` uses to load command
modules).
"""

import importlib
import json

import pytest

check_model = importlib.import_module("app.commands.check-model")
_collect = check_model._collect_models_data

# A minimal manifest that passes every rule (clean baseline). Tests override
# individual fields. ``lora`` is used as the baseline category because
# ``config.json`` is optional there (``CONFIG_OPTIONAL``) and its 10 KB
# ``MIN_SIZE_BYTES`` floor is easily exceeded, so the baseline stays warning-free.
_BASE_SIZE = 2_000_000  # 2 MB — above every category's MIN_SIZE_BYTES

BASE_MANIFEST = {
    "name": "<set per test>",
    "type": "lora",
    "arch": "zimage-turbo",
    "format": "mlx-int8",
    "description": "test fixture",
    "source": "test-source",
    "compatible_with": [],
    "size_bytes": _BASE_SIZE,
    "created_at": "2026-06-18T00:00:00Z",
    "pipeline": ["flux2-klein"],
}


def _make_instance(
    base,
    instance,
    *,
    category="lora",
    extra=None,
    drop=None,
    with_weight=True,
    with_readme=True,
    size_bytes=_BASE_SIZE,
):
    """Create ``models/<category>/<instance>/`` with a manifest + weight + README."""
    inst_dir = base / category / instance
    inst_dir.mkdir(parents=True, exist_ok=True)
    payload = dict(BASE_MANIFEST)
    payload["name"] = instance
    payload["type"] = category
    payload["size_bytes"] = size_bytes
    if extra:
        payload.update(extra)
    for k in drop or ():
        payload.pop(k, None)
    (inst_dir / "manifest.json").write_text(json.dumps(payload))
    if with_weight:
        (inst_dir / "model.safetensors").write_bytes(b"\0" * size_bytes)
    if with_readme:
        (inst_dir / "README.md").write_text("# test\n")
    return inst_dir


def _run(base):
    return _collect(str(base))


# ── Baseline sanity ──────────────────────────────────────────────────────────


def test_clean_instance_has_no_errors_or_warnings(tmp_path):
    """A well-formed instance produces zero errors and zero warnings.

    This proves the fixture is clean — without it, the 'no X warning'
    assertions in the rule tests below would be vacuously true.
    """
    _make_instance(tmp_path, "baseline")
    result = _run(tmp_path)
    assert result["errors"] == []
    assert result["warnings"] == []


# ── Validator-alignment rules (lock in the 3 gap fixes) ───────────────────────


def test_lens_pipeline_accepted(tmp_path):
    """`lens` is a known pipeline — no 'pipeline not in known set' warning."""
    _make_instance(tmp_path, "lens-te", extra={"pipeline": ["lens"]})
    result = _run(tmp_path)
    assert not any("'pipeline' \"lens\"" in w for w in result["warnings"])
    assert result["errors"] == []


def test_mlx_int4_format_accepted(tmp_path):
    """`mlx-int4-gs32` is a known format (int4 synonym of mlx-4bit-gs32)."""
    _make_instance(tmp_path, "int4-te", extra={"format": "mlx-int4-gs32"})
    result = _run(tmp_path)
    assert not any("mlx-int4-gs32" in w for w in result["warnings"])
    assert result["errors"] == []


def test_ltx_mlx_aggregate_dir_not_orphan(tmp_path):
    """models/ltx-mlx/<variant>/ is a symlink-forest aggregator, not an instance."""
    _make_instance(tmp_path, "baseline")  # a real instance so the scan isn't empty
    (tmp_path / "ltx-mlx" / "dev").mkdir(parents=True)  # no manifest
    (tmp_path / "ltx-mlx" / "dasiwa").mkdir(parents=True)
    result = _run(tmp_path)
    assert not any(cat == "ltx-mlx" for cat, _ in result["orphan_dirs"])


def test_raw_download_marker_not_orphan(tmp_path):
    """A dir marked .raw-download holds a user-downloaded raw weight with no MLX
    conversion, so it intentionally has no manifest.json and must not be flagged."""
    _make_instance(tmp_path, "baseline")  # a real instance so the scan isn't empty
    raw_dir = tmp_path / "lora" / "ltx-2.3-restore"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".raw-download").write_text("raw user-downloaded weight\n")
    (raw_dir / "README.md").write_text("download instructions")
    result = _run(tmp_path)
    assert not any(
        cat == "lora" and inst == "ltx-2.3-restore"
        for cat, inst in result["orphan_dirs"]
    )


# ── gpt-oss-20b multi-file pattern ────────────────────────────────────────────


def test_multifile_manifest_with_size_bytes_ok(tmp_path):
    """A manifest carrying a files[] array plus a top-level size_bytes equal to
    the on-disk safetensors size triggers no size-mismatch warning (the
    gpt-oss-20b pattern)."""
    _make_instance(
        tmp_path,
        "multifile",
        extra={
            "files": [
                {"name": "model.safetensors", "size_bytes": _BASE_SIZE},
                {"name": "tokenizer.json", "size_bytes": 1234},
            ],
        },
    )
    result = _run(tmp_path)
    assert not any("size_bytes=" in w for w in result["warnings"])
    assert result["errors"] == []


# ── Required-field / file-presence lint still fires ───────────────────────────


def test_missing_size_bytes_is_an_error(tmp_path):
    _make_instance(tmp_path, "nosize", drop=["size_bytes"])
    result = _run(tmp_path)
    assert any("size_bytes" in e for e in result["errors"])


def test_unknown_format_is_a_warning(tmp_path):
    _make_instance(tmp_path, "badfmt", extra={"format": "bogus-fmt"})
    result = _run(tmp_path)
    assert any('"bogus-fmt" not in known set' in w for w in result["warnings"])


def test_missing_readme_is_an_error(tmp_path):
    _make_instance(tmp_path, "noreadme", with_readme=False)
    result = _run(tmp_path)
    assert any("README.md" in e for e in result["errors"])


# ── Git-tracking invariant (the *.safetensors silent-skip backstop) ───────────
# Regression for the 3d0c39b bug class: a weight symlink that exists on disk but
# is not git-tracked ships a manifest with no weights to every other worktree.
# `*.safetensors` is gitignored, so `git add` silently skips the symlink —
# check #14b is the only thing that catches a forgotten `git add -f`.


def test_git_tracking_context_resolves_real_repo():
    """The helper returns the real repo toplevel + a tracked-path set that
    contains a known-committed symlink (luciddreamer-z, commit dfdbf71) and
    excludes a fabricated path."""
    toplevel, tracked = check_model._git_tracking_context(check_model.cfg.MODELS_DIR)
    assert toplevel is not None, "must resolve a git toplevel inside the repo"
    assert tracked is not None, "must list tracked paths under models/"
    committed = "python/mlx-movie-director/models/transformer/luciddreamer-z/model.safetensors"
    assert committed in tracked, f"committed symlink missing from tracked set: {committed}"
    fabricated = "python/mlx-movie-director/models/transformer/never-existed/model.safetensors"
    assert fabricated not in tracked


def test_git_tracking_context_none_outside_repo(tmp_path):
    """Outside a git worktree the helper returns (None, None) so check #14b
    degrades to a no-op — never a false positive in a standalone install."""
    toplevel, tracked = check_model._git_tracking_context(str(tmp_path))
    assert toplevel is None
    assert tracked is None


def test_untracked_weight_symlink_flagged(monkeypatch, tmp_path):
    """check #14b: a weight symlink on disk but NOT in git's index is an error
    that names the exact fix (`git add -f <relpath>`). Monkeypatch the tracking
    context so the test is independent of the real repo's git state."""
    inst = _make_instance(tmp_path, "leak", with_weight=False)
    # Replace the placeholder weight with a symlink whose TARGET EXISTS (so
    # _has_weight_file's os.path.exists finds it, matching the real bug where
    # the store blob is present but the link is uncommitted).
    blob = tmp_path / "blob.safetensors"
    blob.write_bytes(b"\0" * 4096)
    sf = inst / "model.safetensors"
    sf.unlink(missing_ok=True)
    sf.symlink_to(blob)
    # Pretend git tracks nothing under tmp_path → the symlink is untracked.
    monkeypatch.setattr(
        check_model, "_git_tracking_context",
        lambda models_dir: (str(tmp_path), set()),
    )
    result = _run(tmp_path)
    flagged = [e for e in result["errors"] if "NOT git-tracked" in e]
    assert flagged, "untracked weight symlink must produce a tracking error"
    assert any("git add -f" in e for e in flagged), "error must name the fix"
