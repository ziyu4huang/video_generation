"""Shape-contract tests for seedvr2/time_embedding.py — TimeEmbedding.

Pure MLX — no real weights needed (uses tiny dims for fast tests).
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.time_embedding import TimeEmbedding


class TestTimeEmbedding:
    def test_output_shape(self):
        """Scalar timestep → [1, output_dim] or [B, output_dim]."""
        te = TimeEmbedding(sinusoidal_dim=64, hidden_dim=128, output_dim=256)
        t = mx.array([0.5])
        out = te(t)
        assert out.shape == (1, 256), f"Expected (1,256), got {out.shape}"

    def test_batch_timesteps(self):
        te = TimeEmbedding(sinusoidal_dim=64, hidden_dim=128, output_dim=256)
        t = mx.array([0.0, 0.5, 1.0])
        out = te(t)
        assert out.shape == (3, 256)

    def test_zero_timestep(self):
        te = TimeEmbedding(sinusoidal_dim=64, hidden_dim=128, output_dim=64)
        out = te(mx.array([0.0]))
        assert out.shape == (1, 64)

    def test_one_timestep(self):
        te = TimeEmbedding(sinusoidal_dim=64, hidden_dim=128, output_dim=64)
        out = te(mx.array([1.0]))
        assert out.shape == (1, 64)

    def test_deterministic(self):
        te = TimeEmbedding(sinusoidal_dim=64, hidden_dim=128, output_dim=64)
        t = mx.array([0.5])
        out1 = te(t)
        out2 = te(t)
        assert mx.allclose(out1, out2)

    def test_output_dtype(self):
        te = TimeEmbedding(sinusoidal_dim=32, hidden_dim=64, output_dim=64)
        out = te(mx.array([0.5]))
        assert out.dtype == mx.float32


class TestGetTimestepEmbedding:
    """Static method for sinusoidal timestep encoding."""

    def test_output_shape(self):
        timesteps = mx.array([0.0, 0.5, 1.0])
        emb = TimeEmbedding._get_timestep_embedding(timesteps, embedding_dim=64)
        assert emb.shape == (3, 64)

    def test_half_dim_symmetry(self):
        """First half = sin, second half = cos."""
        timesteps = mx.array([0.5])
        emb = TimeEmbedding._get_timestep_embedding(timesteps, embedding_dim=8)
        half = 4
        assert emb.shape == (1, 8)
        # sin² + cos² ≈ 1 for each frequency pair
        sin_part = emb[0, :half]
        cos_part = emb[0, half:]
        combined = sin_part ** 2 + cos_part ** 2
        assert mx.allclose(combined, mx.ones_like(combined), atol=1e-5), (
            "sin²+cos² should be ~1 for each frequency"
        )

    def test_zero_timestep_first_freq(self):
        """At t=0, the sin component should be 0 and cos component should be 1."""
        timesteps = mx.array([0.0])
        emb = TimeEmbedding._get_timestep_embedding(timesteps, embedding_dim=8)
        assert abs(float(emb[0, 0])) < 1e-6, f"sin(0) should be ~0, got {emb[0, 0]}"
        assert abs(float(emb[0, 4]) - 1.0) < 1e-6, f"cos(0) should be ~1, got {emb[0, 4]}"

    def test_reproducible(self):
        t = mx.array([0.5, 0.3])
        e1 = TimeEmbedding._get_timestep_embedding(t, embedding_dim=16)
        e2 = TimeEmbedding._get_timestep_embedding(t, embedding_dim=16)
        assert mx.allclose(e1, e2)

    def test_different_timesteps_differ(self):
        e1 = TimeEmbedding._get_timestep_embedding(mx.array([0.2]), embedding_dim=16)
        e2 = TimeEmbedding._get_timestep_embedding(mx.array([0.8]), embedding_dim=16)
        assert not mx.allclose(e1, e2), "Different timesteps should produce different embeddings"
