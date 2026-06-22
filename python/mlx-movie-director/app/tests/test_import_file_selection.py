"""Unit tests for CivitAI download-file selection across import commands.

Regression: ``_pick_download_file`` selected the *last* file tagged
``fp=="bf16"`` while ignoring ``format``. CivitAI tags GGUF files with
``fp=="bf16"`` too, so a version whose last bf16 entry is a GGUF (e.g. RedZiT
1.5 AIO, modelVersionId 2462789) was silently mis-selected, then failed to load
as a safetensors transformer. The same class of bug (trusting ``primary``
without checking the format) existed in the LoRA and VAE importers.

CPU-only, no network: all tests feed synthetic version-metadata fixtures.
"""

import importlib

import pytest

# Filenames contain hyphens, so load via importlib.
_ckpt_mod = importlib.import_module("app.commands.import-checkpoint")
_lora_mod = importlib.import_module("app.commands.import-lora-image")
_vae_mod  = importlib.import_module("app.commands.import-vae")


# ---------------------------------------------------------------------------
# Fixture: the real RedZiT 1.5 AIO (2462789) file list — bf16 SafeTensor
# (pruned + full) AND a bf16-tagged GGUF last in order.
# ---------------------------------------------------------------------------

_URL = (
    "https://civitai.com/api/download/models/2462789"
    "?type=Model&format={fmt}&size={size}&fp={fp}"
)


def _file(fmt, size, fp, primary=False):
    name = "redcraftERNIERedmix_redzit15AIO." + (
        "gguf" if fmt == "GGUF" else "safetensors"
    )
    return {
        "name": name,
        "type": "Model",
        "primary": primary,
        "downloadUrl": _URL.format(fmt=fmt, size=size, fp=fp),
        "metadata": {"format": fmt, "size": size, "fp": fp},
    }


_REDZIT_FILES = [
    _file("SafeTensor", "pruned", "fp8"),
    _file("SafeTensor", "pruned", "fp16", primary=True),   # CivitAI primary
    _file("SafeTensor", "full", "bf16"),
    _file("SafeTensor", "pruned", "bf16"),                 # <-- the correct pick
    _file("GGUF", "pruned", "bf16"),                       # <-- the trap
]


# ---------------------------------------------------------------------------
# import-checkpoint: _pick_download_file
# ---------------------------------------------------------------------------

class TestPickDownloadFile:
    def test_redzit_picks_pruned_bf16_safetensors(self):
        bf16_url, primary_url, name = _ckpt_mod._pick_download_file({"files": _REDZIT_FILES})
        # Must select the pruned bf16 SafeTensor...
        assert bf16_url is not None
        assert "format=SafeTensor" in bf16_url
        assert "size=pruned" in bf16_url
        assert "fp=bf16" in bf16_url
        # ...NOT the GGUF (the regression).
        assert "format=GGUF" not in bf16_url
        assert name.endswith(".safetensors")
        assert not name.endswith(".gguf")

    def test_redzit_primary_still_returned(self):
        _, primary_url, _ = _ckpt_mod._pick_download_file({"files": _REDZIT_FILES})
        assert primary_url is not None
        assert "fp=fp16" in primary_url

    def test_prefers_pruned_over_full(self):
        version = {"files": [
            _file("SafeTensor", "full", "bf16"),
            _file("SafeTensor", "pruned", "bf16"),
        ]}
        bf16_url, _, _ = _ckpt_mod._pick_download_file(version)
        assert "size=pruned" in bf16_url

    def test_falls_back_to_full_when_no_pruned(self):
        version = {"files": [_file("SafeTensor", "full", "bf16")]}
        bf16_url, _, _ = _ckpt_mod._pick_download_file(version)
        assert "size=full" in bf16_url

    def test_only_gguf_bf16_returns_none_and_keeps_primary(self):
        """If the only bf16 file is a GGUF, bf16 must be None (primary fallback)."""
        version = {"files": [
            {"name": "x.safetensors", "type": "Model", "primary": True,
             "downloadUrl": "https://x/st", "metadata": {"format": "SafeTensor", "fp": "fp16"}},
            {"name": "x.gguf", "type": "Model", "primary": False,
             "downloadUrl": "https://x/gguf", "metadata": {"format": "GGUF", "fp": "bf16"}},
        ]}
        bf16_url, primary_url, name = _ckpt_mod._pick_download_file(version)
        assert bf16_url is None
        assert primary_url == "https://x/st"
        assert name == "x.safetensors"

    def test_no_bf16_at_all_returns_none(self):
        version = {"files": [
            {"name": "x.safetensors", "type": "Model", "primary": True,
             "downloadUrl": "https://x/st", "metadata": {"format": "SafeTensor", "fp": "fp16"}},
        ]}
        bf16_url, primary_url, _ = _ckpt_mod._pick_download_file(version)
        assert bf16_url is None
        assert primary_url == "https://x/st"


# ---------------------------------------------------------------------------
# import-lora-image: _is_gguf_file
# ---------------------------------------------------------------------------

class TestLoraIsGgufFile:
    @pytest.mark.parametrize("name,fmt,expected", [
        ("x.gguf",        "SafeTensor", True),    # extension wins
        ("x.safetensors", "GGUF",       True),    # format tag wins
        ("x.safetensors", "SafeTensor", False),
        ("x.sft",         "",           False),   # VAE .sft is not GGUF
        ("x",             None,         False),   # missing metadata
    ])
    def test_classification(self, name, fmt, expected):
        meta = {"format": fmt} if fmt is not None else None
        assert _lora_mod._is_gguf_file({"name": name, "metadata": meta}) is expected


# ---------------------------------------------------------------------------
# import-vae: _pick_primary_file (GGUF-skip)
# ---------------------------------------------------------------------------

class TestVaePickPrimaryFile:
    def test_gguf_primary_skipped_falls_to_non_gguf(self):
        version = {"files": [
            {"name": "ae.gguf", "type": "Model", "primary": True,
             "downloadUrl": "https://x/gguf", "metadata": {"format": "GGUF", "fp": "bf16"}},
            {"name": "ae.sft", "type": "VAE", "primary": False,
             "downloadUrl": "https://x/sft", "metadata": {}},
        ]}
        url, name = _vae_mod._pick_primary_file(version)
        assert url == "https://x/sft"
        assert name == "ae.sft"

    def test_safetensors_primary_preserved(self):
        """Regression guard: a normal safetensors primary still wins."""
        version = {"files": [
            {"name": "ae.safetensors", "type": "VAE", "primary": True,
             "downloadUrl": "https://x/st", "metadata": {"format": "SafeTensor"}},
            {"name": "ae.gguf", "type": "Model", "primary": False,
             "downloadUrl": "https://x/gguf", "metadata": {"format": "GGUF"}},
        ]}
        url, name = _vae_mod._pick_primary_file(version)
        assert url == "https://x/st"
        assert name == "ae.safetensors"
