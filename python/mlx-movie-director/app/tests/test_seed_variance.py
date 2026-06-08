"""Unit tests for app/seed_variance.py — requires mlx (available in project venv)."""

import numpy as np
import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seed_variance import SeedVarianceEnhancer


def _make_embedding(shape=(1, 16, 64), seed=0) -> "mx.array":
    rng = np.random.default_rng(seed)
    arr = rng.standard_normal(shape).astype(np.float32)
    return mx.array(arr)


class TestSeedVarianceEnhancer:
    def test_output_shape_matches_input(self):
        emb = _make_embedding()
        sv = SeedVarianceEnhancer(randomize_percent=50.0, strength=10.0, switchover_percent=20.0)
        noisy = sv.create_noisy_embedding(emb, seed=1)
        assert noisy.shape == emb.shape

    def test_noisy_differs_from_clean(self):
        emb = _make_embedding()
        sv = SeedVarianceEnhancer(randomize_percent=50.0, strength=20.0, switchover_percent=20.0)
        noisy = sv.create_noisy_embedding(emb, seed=1)
        assert not np.allclose(np.array(emb), np.array(noisy))

    def test_zero_randomize_percent_is_unchanged(self):
        emb = _make_embedding()
        sv = SeedVarianceEnhancer(randomize_percent=0.0, strength=100.0, switchover_percent=20.0)
        noisy = sv.create_noisy_embedding(emb, seed=1)
        np.testing.assert_array_equal(np.array(emb), np.array(noisy))

    def test_reproducible_with_seed(self):
        emb = _make_embedding()
        sv = SeedVarianceEnhancer(randomize_percent=50.0, strength=20.0, switchover_percent=20.0)
        n1 = np.array(sv.create_noisy_embedding(emb, seed=42))
        n2 = np.array(sv.create_noisy_embedding(emb, seed=42))
        np.testing.assert_array_equal(n1, n2)

    def test_different_seeds_differ(self):
        emb = _make_embedding()
        sv = SeedVarianceEnhancer(randomize_percent=50.0, strength=20.0, switchover_percent=20.0)
        n1 = np.array(sv.create_noisy_embedding(emb, seed=1))
        n2 = np.array(sv.create_noisy_embedding(emb, seed=2))
        assert not np.array_equal(n1, n2)

    def test_output_dtype_matches_input(self):
        emb = _make_embedding()
        sv = SeedVarianceEnhancer()
        noisy = sv.create_noisy_embedding(emb, seed=0)
        assert noisy.dtype == emb.dtype

    def test_should_use_noisy_zero_switchover(self):
        sv = SeedVarianceEnhancer(switchover_percent=0.0)
        for step in range(10):
            assert sv.should_use_noisy(step, 10) is False

    def test_should_use_noisy_full_switchover(self):
        sv = SeedVarianceEnhancer(switchover_percent=100.0)
        for step in range(10):
            assert sv.should_use_noisy(step, 10) is True

    def test_should_use_noisy_partial_switchover(self):
        # switchover_percent=20 with 10 steps → cutoff at step 2
        # steps 0,1 → noisy; steps 2+ → clean
        sv = SeedVarianceEnhancer(switchover_percent=20.0)
        assert sv.should_use_noisy(0, 10) is True
        assert sv.should_use_noisy(1, 10) is True
        assert sv.should_use_noisy(2, 10) is False
        assert sv.should_use_noisy(9, 10) is False

    def test_should_use_noisy_50_percent(self):
        sv = SeedVarianceEnhancer(switchover_percent=50.0)
        # 10 steps → cutoff at 5; steps 0-4 noisy, 5+ clean
        for step in range(5):
            assert sv.should_use_noisy(step, 10) is True
        for step in range(5, 10):
            assert sv.should_use_noisy(step, 10) is False
