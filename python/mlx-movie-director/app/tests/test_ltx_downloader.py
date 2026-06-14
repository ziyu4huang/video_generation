"""Unit tests for app/ltx_downloader.py — CPU-pure paths only.

Covers module constants, the branch logic inside ``download_component``
(file-exists skip, dry-run, optional-file skip, mandatory-file re-raise),
and the ``main()`` argparse shape / component-subset / dry-run routing.
The real ``huggingface_hub`` import lives inside ``download_component`` and
is replaced with an in-process stub, so these tests run with no network and
no MLX/GPU dependency.
"""

import os
import sys
import types

import pytest

from app import ltx_downloader as d


# ---------------------------------------------------------------------------
# Shared helper: install a fake ``huggingface_hub`` so download_component can
# run offline. The fake is parameterised per test via attributes on the stub.
# ---------------------------------------------------------------------------
def _install_fake_hf(monkeypatch, *, download=None, file_exists=True):
    """Replace huggingface_hub with a controllable stub. Returns the stub."""
    stub = types.ModuleType("huggingface_hub")
    stub._download_calls = []

    def _default_download(repo_id, filename, local_dir):
        stub._download_calls.append((repo_id, filename, local_dir))
        return None

    stub.hf_hub_download = download if download is not None else _default_download
    stub.file_exists = lambda *a, **k: file_exists
    monkeypatch.setitem(sys.modules, "huggingface_hub", stub)
    return stub


# ===========================================================================
# Module constants
# ===========================================================================

class TestModuleConstants:
    def test_hf_repo_set(self):
        assert d.HF_REPO == "dgrauet/ltx-2.3-mlx-q8"

    def test_component_files_has_all_expected_components(self):
        assert sorted(d.COMPONENT_FILES) == [
            "audio",
            "lora",
            "text_encoder",
            "transformer",
            "transformer-distilled",
            "vae",
        ]

    def test_component_files_entries_are_dir_and_list(self):
        """Each component maps to (dest_dir, filenames:list)."""
        for name, (dest_dir, filenames) in d.COMPONENT_FILES.items():
            assert isinstance(dest_dir, str) and dest_dir, name
            assert isinstance(filenames, list) and filenames, name
            assert all(isinstance(f, str) and f for f in filenames), name

    def test_every_component_dest_dir_is_absolute(self):
        for name, (dest_dir, _) in d.COMPONENT_FILES.items():
            assert os.path.isabs(dest_dir), name

    def test_optional_files_is_a_set_of_known_config_names(self):
        assert isinstance(d.OPTIONAL_FILES, set)
        # split_model.json is optional (only some transformers ship it)
        assert "split_model.json" in d.OPTIONAL_FILES
        assert "config.json" in d.OPTIONAL_FILES


# ===========================================================================
# download_component — branch logic
# ===========================================================================

class TestDownloadComponent:
    def test_existing_file_is_skipped(self, tmp_path, monkeypatch, capsys):
        """A file already on disk should not trigger a download."""
        stub = _install_fake_hf(monkeypatch)
        fname = "vae_encoder.safetensors"
        (tmp_path / fname).write_bytes(b"x")

        d.download_component("vae", str(tmp_path), [fname], dry_run=False)

        out = capsys.readouterr().out
        assert "already exists" in out
        assert stub._download_calls == []  # nothing downloaded

    def test_dry_run_does_not_download(self, tmp_path, monkeypatch, capsys):
        """dry_run=True prints 'would download' and skips the real call."""
        stub = _install_fake_hf(monkeypatch)
        fname = "vae_decoder.safetensors"

        d.download_component("vae", str(tmp_path), [fname], dry_run=True)

        out = capsys.readouterr().out
        assert "would download" in out
        assert stub._download_calls == []

    def test_dry_run_still_skips_existing(self, tmp_path, monkeypatch, capsys):
        """Existing files are reported even in dry-run mode."""
        _install_fake_hf(monkeypatch)
        fname = "vocoder.safetensors"
        (tmp_path / fname).write_bytes(b"x")

        d.download_component("audio", str(tmp_path), [fname], dry_run=True)

        assert "already exists" in capsys.readouterr().out

    def test_optional_file_failure_is_swallowed(self, tmp_path, monkeypatch, capsys):
        """A download error on an OPTIONAL file is logged, not raised."""

        def boom(*a, **k):
            raise RuntimeError("network down")

        _install_fake_hf(monkeypatch, download=boom)
        # config.json is in OPTIONAL_FILES
        d.download_component("text_encoder", str(tmp_path), ["config.json"],
                             dry_run=False)

        out = capsys.readouterr()
        assert "skipped (optional" in out.out

    def test_mandatory_file_failure_is_raised(self, tmp_path, monkeypatch, capsys):
        """A download error on a MANDATORY file propagates after a stderr msg."""

        def boom(*a, **k):
            raise RuntimeError("network down")

        _install_fake_hf(monkeypatch, download=boom)
        # vae_encoder.safetensors is NOT in OPTIONAL_FILES
        with pytest.raises(RuntimeError, match="network down"):
            d.download_component("vae", str(tmp_path),
                                 ["vae_encoder.safetensors"], dry_run=False)
        assert "FAILED" in capsys.readouterr().err

    def test_dest_dir_is_created(self, tmp_path, monkeypatch):
        """os.makedirs(dest_dir, exist_ok=True) runs before downloads."""
        _install_fake_hf(monkeypatch)
        nested = tmp_path / "subdir"
        d.download_component("vae", str(nested), [], dry_run=False)
        assert nested.is_dir()

    def test_successful_download_reports_size(self, tmp_path, monkeypatch, capsys):
        """After a real download, the file size is printed."""

        def fake_download(repo_id, filename, local_dir):
            (tmp_path / filename).write_bytes(b"x" * 1024)
            return None

        _install_fake_hf(monkeypatch, download=fake_download)
        d.download_component("vae", str(tmp_path),
                             ["vae_decoder.safetensors"], dry_run=False)
        assert "done" in capsys.readouterr().out


# ===========================================================================
# main() — argparse shape + routing
# ===========================================================================

class TestMain:
    def _patch_argv(self, monkeypatch, argv):
        monkeypatch.setattr(sys, "argv", ["prog"] + argv)

    def test_invalid_component_exits(self, tmp_path, monkeypatch):
        _install_fake_hf(monkeypatch)
        self._patch_argv(monkeypatch, ["--component", "bogus"])
        with pytest.raises(SystemExit):
            d.main()

    def test_dry_run_prints_banner_and_skips_download(self, tmp_path, monkeypatch,
                                                       capsys):
        stub = _install_fake_hf(monkeypatch)
        self._patch_argv(monkeypatch, ["--component", "audio", "--dry-run"])
        d.main()
        out = capsys.readouterr().out
        assert "DRY RUN" in out
        assert stub._download_calls == []

    def test_component_subset_only_processes_one(self, tmp_path, monkeypatch, capsys):
        """--component <name> restricts work to that single component."""
        stub = _install_fake_hf(monkeypatch)
        self._patch_argv(monkeypatch, ["--component", "audio", "--dry-run"])
        d.main()
        out = capsys.readouterr().out
        # Only the audio component header should appear; transformer etc. must not.
        assert "[audio]" in out
        assert "[transformer]" not in out
        assert "[vae]" not in out

    def test_no_component_processes_all(self, tmp_path, monkeypatch, capsys):
        """Without --component, every component is iterated (dry-run)."""
        _install_fake_hf(monkeypatch)
        self._patch_argv(monkeypatch, ["--dry-run"])
        d.main()
        out = capsys.readouterr().out
        for name in d.COMPONENT_FILES:
            assert f"[{name}]" in out

    def test_non_dry_run_prints_completion_summary(self, tmp_path, monkeypatch,
                                                    capsys):
        """Without --dry-run, the manifest-update footer is printed."""
        stub = _install_fake_hf(monkeypatch)
        # Make downloads no-ops that create the files so no exceptions fire.
        self._patch_argv(monkeypatch, ["--component", "audio"])
        d.main()
        out = capsys.readouterr().out
        assert "Download complete" in out
        assert "manifest.json" in out

    def test_non_dry_run_omits_dry_run_banner(self, tmp_path, monkeypatch, capsys):
        _install_fake_hf(monkeypatch)
        self._patch_argv(monkeypatch, ["--component", "audio", "--dry-run"])
        d.main()
        # In dry-run the completion footer must NOT be printed.
        assert "Download complete" not in capsys.readouterr().out
