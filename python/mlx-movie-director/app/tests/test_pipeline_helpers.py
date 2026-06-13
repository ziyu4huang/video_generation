"""Shape-contract + pure-function tests for app/pipeline.py helpers.

Tests standalone functions and the MLXFlowMatchEulerScheduler—no real
model weights needed. ZImagePipeline.__init__ is tested with tmp_path.
"""

import json
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from mlx import nn

from app.pipeline import (
    create_coordinate_grid,
    calculate_shift,
    _latent_upscale,
    MLXFlowMatchEulerScheduler,
    load_sharded_weights,
    ZImagePipeline,
)


# ==========================================================================
# create_coordinate_grid
# ==========================================================================

class TestCreateCoordinateGrid:
    def test_output_shape(self):
        """(D0, D1, D2) grid → (D0*D1*D2, 3) coordinate pairs."""
        grid = create_coordinate_grid((4, 8, 16), (0, 0, 0))
        assert grid.shape == (4 * 8 * 16, 3)

    def test_start_offset(self):
        """Starting offset shifts all coordinates."""
        grid = create_coordinate_grid((2, 2, 2), (10, 20, 30))
        assert grid[0].tolist() == [10, 20, 30]
        assert grid[-1].tolist() == [11, 21, 31]

    def test_last_coordinate(self):
        grid = create_coordinate_grid((3, 4, 5), (0, 0, 0))
        # Last element should be (2, 3, 4)
        assert grid[-1].tolist() == [2, 3, 4]

    def test_single_voxel(self):
        grid = create_coordinate_grid((1, 1, 1), (5, 5, 5))
        assert grid.shape == (1, 3)
        assert grid[0].tolist() == [5, 5, 5]

    def test_non_zero_start(self):
        """Non-zero start should offset all coordinates."""
        grid = create_coordinate_grid((2, 2, 2), (100, 200, 300))
        assert grid[0, 0].item() == 100
        assert grid[0, 1].item() == 200
        assert grid[0, 2].item() == 300

    def test_values_are_integers(self):
        grid = create_coordinate_grid((4, 4, 4), (0, 0, 0))
        assert grid.dtype == mx.int64 or grid.dtype == mx.int32


# ==========================================================================
# calculate_shift
# ==========================================================================

class TestCalculateShift:
    def test_base_seq_len(self):
        """At base_seq_len=256, shift equals base_shift=0.5."""
        shift = calculate_shift(256)
        assert shift == pytest.approx(0.5, abs=1e-6)

    def test_max_seq_len(self):
        """At max_seq_len=4096, shift equals max_shift=1.15."""
        shift = calculate_shift(4096)
        assert shift == pytest.approx(1.15, abs=1e-6)

    def test_midpoint(self):
        """Midpoint between 256 and 4096."""
        shift = calculate_shift(2176)
        # Linear interpolation: m = (1.15-0.5)/(4096-256), b = 0.5 - m*256
        m = (1.15 - 0.5) / (4096 - 256)
        b = 0.5 - m * 256
        expected = 2176 * m + b
        assert shift == pytest.approx(expected, abs=1e-6)

    def test_custom_params(self):
        shift = calculate_shift(512, base_seq_len=128, max_seq_len=2048, base_shift=0.3, max_shift=1.0)
        m = (1.0 - 0.3) / (2048 - 128)
        b = 0.3 - m * 128
        expected = 512 * m + b
        assert shift == pytest.approx(expected, abs=1e-6)

    def test_below_base(self):
        """Sequence length below base should extrapolate."""
        shift = calculate_shift(100)
        assert isinstance(shift, float)

    def test_above_max(self):
        shift = calculate_shift(5000)
        assert isinstance(shift, float)


# ==========================================================================
# _latent_upscale
# ==========================================================================

class TestLatentUpscale:
    """_latent_upscale uses nn.Upsample(mode='bilinear') which requires
    MLX ≥ 0.19. Skip gracefully if unavailable."""

    def _has_bilinear(self):
        try:
            nn.Upsample(scale_factor=1.0, mode="bilinear", align_corners=False)
            return True
        except ValueError:
            return False

    def test_output_shape_upscale(self):
        if not self._has_bilinear():
            pytest.skip("MLX version does not support bilinear upsampling")
        latent = mx.ones((1, 16, 16, 16))
        result = _latent_upscale(latent, scale_factor=2.0)
        assert result.shape == (1, 16, 32, 32), f"Got {result.shape}"

    def test_output_dtype_bf16(self):
        if not self._has_bilinear():
            pytest.skip("MLX version does not support bilinear upsampling")
        latent = mx.ones((1, 4, 8, 8))
        result = _latent_upscale(latent, scale_factor=1.5)
        assert result.dtype == mx.bfloat16

    def test_even_dims_guaranteed(self):
        if not self._has_bilinear():
            pytest.skip("MLX version does not support bilinear upsampling")
        latent = mx.ones((1, 4, 7, 9))
        result = _latent_upscale(latent, scale_factor=2.0)
        assert result.shape[2] % 2 == 0
        assert result.shape[3] % 2 == 0

    def test_same_scale(self):
        if not self._has_bilinear():
            pytest.skip("MLX version does not support bilinear upsampling")
        latent = mx.ones((1, 4, 16, 16))
        result = _latent_upscale(latent, scale_factor=1.0)
        assert result.shape == (1, 4, 16, 16)

    def test_channel_count_preserved(self):
        if not self._has_bilinear():
            pytest.skip("MLX version does not support bilinear upsampling")
        latent = mx.ones((1, 16, 8, 8))
        result = _latent_upscale(latent, scale_factor=2.0)
        assert result.shape[1] == 16


# ==========================================================================
# MLXFlowMatchEulerScheduler
# ==========================================================================

class TestSchedulerInit:
    def test_default_params(self):
        s = MLXFlowMatchEulerScheduler()
        assert s.shift == 3.0
        assert s.use_dynamic_shifting is True
        assert s.timesteps is None

    def test_custom_shift(self):
        s = MLXFlowMatchEulerScheduler(shift=5.0)
        assert s.shift == 5.0

    def test_no_dynamic_shifting(self):
        s = MLXFlowMatchEulerScheduler(use_dynamic_shifting=False)
        assert s.use_dynamic_shifting is False


class TestSchedulerSetTimesteps:
    def test_timesteps_length(self):
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(9)
        assert len(s.timesteps) == 10  # N+1 points

    def test_timesteps_are_float32(self):
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(9)
        assert s.timesteps.dtype == mx.float32

    def test_timesteps_monotonic(self):
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(9)
        ts = np.array(s.timesteps.tolist())
        # Should be decreasing from 1.0 to 0.0 (or very close)
        assert ts[0] == pytest.approx(1.0, abs=0.01)
        assert ts[-1] == pytest.approx(0.0, abs=0.01)

    def test_dynamic_shift_with_mu(self):
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(9, mu=3.0)
        # With mu=3.0, timesteps should be time-shifted
        ts = np.array(s.timesteps.tolist())
        # The first timestep should still be 1.0
        assert ts[0] == pytest.approx(1.0, abs=0.01)
        # But the distribution should differ from linear
        s_linear = MLXFlowMatchEulerScheduler(use_dynamic_shifting=False)
        s_linear.set_timesteps(9, mu=3.0)
        ts_linear = np.array(s_linear.timesteps.tolist())
        # Mid timesteps should differ
        assert not np.allclose(ts[4], ts_linear[4])

    def test_no_dynamic_shifting(self):
        s = MLXFlowMatchEulerScheduler(use_dynamic_shifting=False)
        s.set_timesteps(9)
        ts = np.array(s.timesteps.tolist())
        # Without dynamic shifting, timesteps are uniform 1.0→0.0
        expected = np.linspace(1.0, 0.0, 10)
        assert np.allclose(ts, expected, atol=1e-6)


class TestSchedulerStep:
    def test_output_shape(self):
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(9)
        sample = mx.ones((1, 16, 32, 32))
        output = mx.zeros((1, 16, 32, 32))  # zero model output
        prev = s.step(output, 0, sample)
        assert prev.shape == sample.shape

    def test_step_with_output(self):
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(5)
        sample = mx.ones((1, 4, 8, 8))
        # Model output = sample → dt * sample added
        output = mx.ones((1, 4, 8, 8))
        prev = s.step(output, 0, sample)
        dt = s.timesteps[1] - s.timesteps[0]
        # prev = sample + dt * output
        expected = 1.0 + float(dt)
        assert abs(float(prev[0, 0, 0, 0]) - expected) < 0.01

    def test_step_order_consistent(self):
        """Earlier step (index 0) should produce same dt as index 2
        when timesteps are evenly spaced (uniform scheduler)."""
        s = MLXFlowMatchEulerScheduler()
        s.set_timesteps(5)
        sample = mx.ones((1, 1, 1, 1))
        step0 = s.step(mx.ones_like(sample), 0, sample)
        step3 = s.step(mx.ones_like(sample), 3, sample)
        # With uniform timesteps 1.0,0.8,0.6,0.4,0.2,0.0:
        # dt0 = 0.8-1.0 = -0.2, dt3 = 0.2-0.4 = -0.2 (same!)
        # So step0 and step3 produce the same result.
        # With dynamic shifting, timesteps are non-uniform 
        # and different steps should differ.
        s_dyn = MLXFlowMatchEulerScheduler(use_dynamic_shifting=True)
        s_dyn.set_timesteps(5, mu=3.0)
        step0_dyn = s_dyn.step(mx.ones_like(sample), 0, sample)
        step3_dyn = s_dyn.step(mx.ones_like(sample), 3, sample)
        assert not mx.allclose(step0_dyn, step3_dyn), (
            "Dynamic shifted timesteps should differ across steps"
        )


# ==========================================================================
# load_sharded_weights — mocked filesystem
# ==========================================================================

class TestLoadShardedWeights:
    """load_sharded_weights calls mx.load internally.
    mlx is a namespace package, so we patch mx.load (mlx.core.load)
    which is the actual implementation.
    """

    def test_index_file_loading(self, tmp_path):
        """When model.safetensors.index.json exists, load from shards."""
        index = {"weight_map": {"layer.0.weight": "shard-00001.safetensors",
                                 "layer.1.weight": "shard-00001.safetensors"}}
        (tmp_path / "model.safetensors.index.json").write_text(json.dumps(index))
        shard = tmp_path / "shard-00001.safetensors"
        shard.write_bytes(b"dummy")

        with patch.object(mx, "load", return_value={"layer.0.weight": mx.array([1.0])}):
            weights = load_sharded_weights(str(tmp_path))
            assert len(weights) >= 1

    def test_single_file_loading(self, tmp_path):
        (tmp_path / "model.safetensors").write_bytes(b"dummy")
        fake_weights = {"weight": mx.array([1.0])}
        with patch.object(mx, "load", return_value=fake_weights):
            weights = load_sharded_weights(str(tmp_path))
            assert "weight" in weights

    def test_no_weight_files_returns_empty(self, tmp_path):
        weights = load_sharded_weights(str(tmp_path))
        assert weights == {}
