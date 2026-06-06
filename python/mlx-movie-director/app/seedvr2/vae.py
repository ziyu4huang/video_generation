import mlx.core as mx
from mlx import nn

from app.seedvr2.vae_encoder import Encoder3D
from app.seedvr2.vae_decoder import Decoder3D


class SeedVR2VAE(nn.Module):
    scaling_factor: float = 0.9152
    spatial_scale = 8

    def __init__(
        self,
        in_channels: int = 3,
        out_channels: int = 3,
        latent_channels: int = 16,
        block_out_channels: tuple = (128, 256, 512, 512),
    ):
        super().__init__()
        self.latent_channels = latent_channels

        self.encoder = Encoder3D(
            in_channels=in_channels,
            out_channels=latent_channels,
            block_out_channels=block_out_channels,
            layers_per_block=2,
            temporal_down_blocks=2,
        )

        self.decoder = Decoder3D(
            in_channels=latent_channels,
            out_channels=out_channels,
            block_out_channels=block_out_channels,
            layers_per_block=3,
            temporal_up_blocks=2,
        )

    def encode(self, x: mx.array) -> mx.array:
        x = x[:, :, None, :, :] if x.ndim == 4 else x
        h = self.encoder(x)
        mean, _ = mx.split(h, 2, axis=1)
        latent = mean * self.scaling_factor
        return latent

    def decode(self, z: mx.array) -> mx.array:
        z = z[:, :, None, :, :] if z.ndim == 4 else z
        z = z / self.scaling_factor
        decoded = self.decoder(z)
        return decoded
