"""Regression tests for app/io_utils.py — image loading, file validation, dir creation.

Pure PIL + tmp_path tests — no external dependencies beyond Pillow.
"""

import os
import sys

import pytest
from PIL import Image

from app.io_utils import load_image_rgb, require_file, ensure_dir


# ==========================================================================
# load_image_rgb
# ==========================================================================

class TestLoadImageRgb:
    def test_rgb_image_stays_rgb(self, tmp_path):
        """An already-RGB image is returned as-is."""
        p = tmp_path / "rgb.png"
        Image.new("RGB", (16, 16), (128, 128, 128)).save(p)
        img = load_image_rgb(str(p))
        assert img.mode == "RGB"

    def test_rgba_strips_alpha(self, tmp_path):
        """RGBA image is converted to RGB."""
        p = tmp_path / "rgba.png"
        Image.new("RGBA", (16, 16), (128, 128, 128, 255)).save(p)
        img = load_image_rgb(str(p))
        assert img.mode == "RGB"
        assert img.size == (16, 16)

    def test_grayscale_converted_to_rgb(self, tmp_path):
        """L (grayscale) image is converted to RGB."""
        p = tmp_path / "gray.png"
        Image.new("L", (8, 8), 128).save(p)
        img = load_image_rgb(str(p))
        assert img.mode == "RGB"

    def test_la_converted_to_rgb(self, tmp_path):
        """LA (grayscale + alpha) is converted to RGB."""
        p = tmp_path / "la.png"
        Image.new("LA", (8, 8), (128, 255)).save(p)
        img = load_image_rgb(str(p))
        assert img.mode == "RGB"

    def test_palette_converted_to_rgb(self, tmp_path):
        """P (palette) mode is converted to RGB."""
        p = tmp_path / "palette.png"
        im = Image.new("P", (8, 8), 0)
        im.putpalette([0, 0, 0, 255, 255, 255])
        im.save(p)
        img = load_image_rgb(str(p))
        assert img.mode == "RGB"

    def test_missing_file_raises(self, tmp_path):
        """Missing file should raise FileNotFoundError from PIL."""
        p = tmp_path / "nonexistent.png"
        with pytest.raises(FileNotFoundError):
            load_image_rgb(str(p))

    def test_size_preserved(self, tmp_path):
        """Dimensions are preserved through conversion."""
        p = tmp_path / "test.png"
        Image.new("RGBA", (320, 480), (255, 0, 0, 128)).save(p)
        img = load_image_rgb(str(p))
        assert img.size == (320, 480)

    def test_pixels_preserved_approx(self, tmp_path):
        """RGB values should survive conversion (alpha is discarded)."""
        p = tmp_path / "test.png"
        rgba = Image.new("RGBA", (4, 4), (100, 150, 200, 128))
        rgba.save(p)
        img = load_image_rgb(str(p))
        px = img.getpixel((0, 0))
        assert px == (100, 150, 200), f"Expected (100,150,200), got {px}"


# ==========================================================================
# require_file
# ==========================================================================

class TestRequireFile:
    def test_existing_file_returns_path(self, tmp_path):
        p = tmp_path / "exists.txt"
        p.write_text("hello")
        result = require_file(str(p))
        assert result == str(p)

    def test_none_path_exits(self):
        with pytest.raises(SystemExit) as exc:
            require_file(None)
        assert exc.value.code == 1

    def test_empty_string_exits(self):
        with pytest.raises(SystemExit) as exc:
            require_file("")
        assert exc.value.code == 1

    def test_missing_path_exits(self, tmp_path):
        p = tmp_path / "missing.txt"
        with pytest.raises(SystemExit) as exc:
            require_file(str(p))
        assert exc.value.code == 1

    def test_custom_label_in_error(self, tmp_path, capsys):
        """Custom label appears in the error message."""
        with pytest.raises(SystemExit):
            require_file(None, label="model")
        err = capsys.readouterr().err
        assert "model" in err

    def test_none_path_stderr_message(self, capsys):
        with pytest.raises(SystemExit):
            require_file(None)
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "path is required" in err

    def test_missing_path_stderr_message(self, tmp_path, capsys):
        p = tmp_path / "missing.txt"
        with pytest.raises(SystemExit):
            require_file(str(p))
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "not found" in err
        assert str(p) in err


# ==========================================================================
# ensure_dir
# ==========================================================================

class TestEnsureDir:
    def test_creates_directory(self, tmp_path):
        d = tmp_path / "new" / "nested" / "dir"
        ensure_dir(str(d))
        assert d.is_dir()

    def test_existing_directory_succeeds(self, tmp_path):
        d = tmp_path / "existing"
        d.mkdir(parents=True)
        ensure_dir(str(d))  # should not raise
        assert d.is_dir()

    def test_creates_parents(self, tmp_path):
        d = tmp_path / "a" / "b" / "c"
        ensure_dir(str(d))
        assert d.is_dir()
        assert (tmp_path / "a").is_dir()

    def test_relative_path(self, tmp_path):
        original = os.getcwd()
        os.chdir(str(tmp_path))
        try:
            ensure_dir("relative/sub")
            assert (tmp_path / "relative" / "sub").is_dir()
        finally:
            os.chdir(original)
