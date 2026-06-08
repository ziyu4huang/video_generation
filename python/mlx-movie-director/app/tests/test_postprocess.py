"""Unit tests for app/postprocess.py — pure numpy/PIL, no model loading."""

import numpy as np
import pytest
from PIL import Image

from app.postprocess import FilmGrain, LUTGrading, PostProcessChain, Sharpening


def _solid_image(r=128, g=128, b=128, size=(64, 64)) -> Image.Image:
    arr = np.full((*size, 3), [r, g, b], dtype=np.uint8)
    return Image.fromarray(arr)


def _random_image(seed=0, size=(64, 64)) -> Image.Image:
    rng = np.random.default_rng(seed)
    arr = rng.integers(60, 200, (*size, 3), dtype=np.uint8)
    return Image.fromarray(arr)


class TestFilmGrain:
    def test_output_size_unchanged(self):
        img = _random_image()
        result = FilmGrain(intensity=0.02).apply(img, seed=1)
        assert result.size == img.size

    def test_modifies_pixels(self):
        img = _solid_image()
        result = FilmGrain(intensity=0.05).apply(img, seed=1)
        assert not np.array_equal(np.array(result), np.array(img))

    def test_reproducible_with_seed(self):
        img = _random_image()
        r1 = FilmGrain(intensity=0.02).apply(img, seed=99)
        r2 = FilmGrain(intensity=0.02).apply(img, seed=99)
        assert np.array_equal(np.array(r1), np.array(r2))

    def test_different_seeds_differ(self):
        img = _random_image()
        r1 = FilmGrain(intensity=0.05).apply(img, seed=1)
        r2 = FilmGrain(intensity=0.05).apply(img, seed=2)
        assert not np.array_equal(np.array(r1), np.array(r2))

    def test_vignette_darkens_corners(self):
        img = _solid_image(200, 200, 200, size=(128, 128))
        result = FilmGrain(intensity=0.0, vignette=0.8).apply(img, seed=0)
        arr = np.array(result, dtype=float)
        center = arr[60:68, 60:68].mean()
        corner = arr[0:8, 0:8].mean()
        assert corner < center, "Vignette should darken corners"

    def test_temperature_shifts_rgb(self):
        img = _solid_image(128, 128, 128)
        result = FilmGrain(intensity=0.0, temperature=0.1).apply(img, seed=0)
        arr = np.array(result)
        # Warm temperature: R increases, B decreases
        assert arr[:, :, 0].mean() > arr[:, :, 2].mean()


class TestSharpening:
    def test_output_size_unchanged(self):
        img = _random_image()
        result = Sharpening(cas_strength=0.3).apply(img)
        assert result.size == img.size

    def test_cas_modifies_non_uniform_image(self):
        img = _random_image()
        result = Sharpening(cas_strength=0.5).apply(img)
        assert not np.array_equal(np.array(result), np.array(img))

    def test_cas_leaves_solid_unchanged(self):
        # CAS on a uniform image should produce minimal change (all neighbors equal)
        img = _solid_image()
        result = Sharpening(cas_strength=1.0).apply(img)
        diff = np.abs(np.array(result, dtype=float) - np.array(img, dtype=float))
        assert diff.max() < 5, "CAS on uniform image should have near-zero effect"

    def test_zero_strength_is_identity(self):
        img = _random_image()
        result = Sharpening(cas_strength=0.0, unsharp_radius=0, unsharp_amount=0.0).apply(img)
        assert np.array_equal(np.array(result), np.array(img))


class TestPostProcessChain:
    def test_empty_chain_returns_input(self):
        img = _random_image()
        chain = PostProcessChain([])
        result, timings = chain.apply(img, seed=0)
        assert np.array_equal(np.array(result), np.array(img))
        assert timings == {}

    def test_has_filters_false_when_empty(self):
        assert not PostProcessChain([]).has_filters()

    def test_has_filters_true_when_nonempty(self):
        chain = PostProcessChain.from_config({"film_grain": 0.01})
        assert chain.has_filters()

    def test_filter_order_film_grain_last(self):
        chain = PostProcessChain.from_config({
            "sharpening": 0.1,
            "film_grain": 0.01,
        })
        names = [f.name for f in chain.filters]
        assert names[-1] == "film_grain"
        assert "sharpening" in names

    def test_filter_order_noise_clean_first(self):
        chain = PostProcessChain.from_config({
            "noise_clean": True,
            "sharpening": 0.1,
            "film_grain": 0.01,
        })
        names = [f.name for f in chain.filters]
        assert names[0] == "noise_cleaner"
        assert names[-1] == "film_grain"

    def test_chain_changes_pixels(self):
        img = _random_image()
        chain = PostProcessChain.from_config({"sharpening": 0.2, "film_grain": 0.02})
        result, _ = chain.apply(img, seed=7)
        assert not np.array_equal(np.array(result), np.array(img))

    def test_timings_keys_match_filters(self):
        chain = PostProcessChain.from_config({"sharpening": 0.1, "film_grain": 0.01})
        _, timings = chain.apply(_random_image(), seed=0)
        filter_names = {f.name for f in chain.filters}
        assert set(timings.keys()) == filter_names


class TestLUTGrading:
    def _make_identity_lut(self, tmp_path, size=4) -> str:
        """Write an identity .cube LUT (no color change at strength=1.0)."""
        path = str(tmp_path / "identity.cube")
        lines = [f"LUT_3D_SIZE {size}\n"]
        step = 1.0 / (size - 1)
        for b_idx in range(size):
            for g_idx in range(size):
                for r_idx in range(size):
                    r = r_idx * step
                    g = g_idx * step
                    b = b_idx * step
                    lines.append(f"{r:.6f} {g:.6f} {b:.6f}\n")
        with open(path, "w") as f:
            f.writelines(lines)
        return path

    def test_identity_lut_is_noop(self, tmp_path):
        img = _random_image()
        lut_path = self._make_identity_lut(tmp_path)
        result = LUTGrading(lut_path, strength=1.0).apply(img)
        diff = np.abs(np.array(result, dtype=float) - np.array(img, dtype=float))
        # Trilinear interpolation on identity LUT may have tiny float rounding
        assert diff.max() <= 2, f"Identity LUT should be near-noop, max diff={diff.max()}"

    def test_zero_strength_is_noop(self, tmp_path):
        img = _random_image()
        lut_path = self._make_identity_lut(tmp_path)
        result = LUTGrading(lut_path, strength=0.0).apply(img)
        diff = np.abs(np.array(result, dtype=float) - np.array(img, dtype=float))
        assert diff.max() == 0

    def test_output_size_unchanged(self, tmp_path):
        img = _random_image(size=(32, 48))
        lut_path = self._make_identity_lut(tmp_path)
        result = LUTGrading(lut_path, strength=0.5).apply(img)
        assert result.size == img.size


class TestSkinContrast:
    def test_graceful_fallback_without_cv2(self, monkeypatch):
        import builtins
        real_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "cv2":
                raise ImportError("cv2 not available")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", mock_import)

        from app.postprocess import SkinContrast
        img = _random_image()
        result = SkinContrast().apply(img)
        # Should return original unchanged when cv2 unavailable
        assert np.array_equal(np.array(result), np.array(img))
