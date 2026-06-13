"""Shape-contract tests for SeedVR2 VAE modules.

The VAE uses GroupNorm + Conv3D which need sufficient channel and spatial
dimensions. These tests verify structural properties (instantiation,
parameters, config) rather than full forward passes, which require
production-sized configs.
"""

import pytest

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False

pytestmark = pytest.mark.skipif(not HAS_MLX, reason="mlx not available")

from app.seedvr2.vae import SeedVR2VAE
from app.seedvr2.vae_encoder import Encoder3D
from app.seedvr2.vae_decoder import Decoder3D


class TestVAEInstantiation:
    """Module instantiation and parameter structure (no forward pass)."""

    def test_vae_instantiate(self):
        vae = SeedVR2VAE()
        assert isinstance(vae, SeedVR2VAE)

    def test_encoder_instantiate(self):
        enc = Encoder3D(in_channels=3, out_channels=16, block_out_channels=(32, 64, 128, 128))
        assert isinstance(enc, Encoder3D)

    def test_decoder_instantiate(self):
        dec = Decoder3D(in_channels=16, out_channels=3, block_out_channels=(128, 128, 64, 32))
        assert isinstance(dec, Decoder3D)

    def test_parameters_traversable(self):
        vae = SeedVR2VAE()
        params = vae.parameters()
        assert isinstance(params, dict)
        assert len(params) > 0

    def test_scaling_factor_positive(self):
        vae = SeedVR2VAE()
        assert vae.scaling_factor > 0

    def test_latent_channels(self):
        vae = SeedVR2VAE(latent_channels=16)
        assert vae.latent_channels == 16

    def test_encoder_decoder_present(self):
        vae = SeedVR2VAE()
        assert hasattr(vae, "encoder")
        assert hasattr(vae, "decoder")
