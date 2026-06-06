"""SeedVR2 VAE Decoder (3D causal convolutions)."""

import mlx.core as mx
from mlx import nn

from app.seedvr2.conv3d import CausalConv3d


class ResnetBlock3D(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.norm1 = nn.GroupNorm(num_groups=32, dims=in_channels, eps=1e-6, pytorch_compatible=True)
        self.norm2 = nn.GroupNorm(num_groups=32, dims=out_channels, eps=1e-6, pytorch_compatible=True)
        self.conv1 = CausalConv3d(in_channels, out_channels, kernel_size=3, stride=1, padding=1)
        self.conv2 = CausalConv3d(out_channels, out_channels, kernel_size=3, stride=1, padding=1)
        if in_channels != out_channels:
            self.conv_shortcut = CausalConv3d(in_channels, out_channels, kernel_size=1, stride=1, padding=0)
        else:
            self.conv_shortcut = None

    def __call__(self, x: mx.array) -> mx.array:
        residual = x
        x = x.transpose(0, 2, 3, 4, 1)
        x = self.norm1(x.astype(mx.float32)).astype(mx.bfloat16)
        x = x.transpose(0, 4, 1, 2, 3)
        x = nn.silu(x)
        x = self.conv1(x)
        x = x.transpose(0, 2, 3, 4, 1)
        x = self.norm2(x.astype(mx.float32)).astype(mx.bfloat16)
        x = x.transpose(0, 4, 1, 2, 3)
        x = nn.silu(x)
        x = self.conv2(x)
        if self.conv_shortcut is not None:
            residual = self.conv_shortcut(residual)
        return x + residual


class Upsample3D(nn.Module):
    def __init__(self, channels: int, temporal_up: bool = False):
        super().__init__()
        spatial_factor = 2
        temporal_factor = 2 if temporal_up else 1
        total_factor = (spatial_factor**2) * temporal_factor
        self.conv = CausalConv3d(
            channels, channels, kernel_size=3, stride=1, padding=1,
            use_padding_causal=True,
        )
        self.upscale_conv = CausalConv3d(
            channels, channels * total_factor, kernel_size=1, stride=1, padding=0,
        )
        self.spatial_factor = spatial_factor
        self.temporal_factor = temporal_factor

    def __call__(self, x: mx.array) -> mx.array:
        B, C, T, H, W = x.shape
        x = self.upscale_conv(x)
        sf = self.spatial_factor
        tf = self.temporal_factor
        x = x.reshape(B, sf, sf, tf, C, T, H, W)
        x = x.transpose(0, 4, 5, 3, 6, 1, 7, 2)
        x = x.reshape(B, C, T * tf, H * sf, W * sf)
        if T == 1 and tf > 1:
            x = x[:, :, :1, :, :]
        x = self.conv(x)
        return x


class UpBlock3D(nn.Module):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        num_layers: int = 3,
        add_upsample: bool = True,
        temporal_up: bool = False,
    ):
        super().__init__()
        self.resnets = []
        for i in range(num_layers):
            in_ch = in_channels if i == 0 else out_channels
            self.resnets.append(ResnetBlock3D(in_channels=in_ch, out_channels=out_channels))
        self.upsamplers = []
        if add_upsample:
            self.upsamplers.append(Upsample3D(channels=out_channels, temporal_up=temporal_up))

    def __call__(self, x: mx.array) -> mx.array:
        for resnet in self.resnets:
            x = resnet(x)
        for upsampler in self.upsamplers:
            x = upsampler(x)
        return x


class MidBlock3D(nn.Module):
    def __init__(self, channels: int = 512):
        super().__init__()
        from app.seedvr2.vae_attention import Attention3D
        self.attentions = [Attention3D(channels=channels)]
        self.resnets = [
            ResnetBlock3D(in_channels=channels, out_channels=channels),
            ResnetBlock3D(in_channels=channels, out_channels=channels),
        ]

    def __call__(self, x: mx.array) -> mx.array:
        x = self.resnets[0](x)
        x = self.attentions[0](x)
        x = self.resnets[1](x)
        return x


class Decoder3D(nn.Module):
    def __init__(
        self,
        in_channels: int = 16,
        out_channels: int = 3,
        block_out_channels: tuple = (128, 256, 512, 512),
        layers_per_block: int = 3,
        temporal_up_blocks: int = 2,
    ):
        super().__init__()
        reversed_channels = list(reversed(block_out_channels))
        self.conv_in = CausalConv3d(
            in_channels=in_channels, out_channels=reversed_channels[0],
            kernel_size=3, stride=1, padding=1,
        )
        self.mid_block = MidBlock3D(channels=reversed_channels[0])
        self.up_blocks = []
        output_channel = reversed_channels[0]
        num_blocks = len(reversed_channels)
        for i, channel in enumerate(reversed_channels):
            input_channel = output_channel
            output_channel = channel
            is_final_block = i == num_blocks - 1
            temporal_up = i < temporal_up_blocks
            self.up_blocks.append(
                UpBlock3D(
                    in_channels=input_channel, out_channels=output_channel,
                    num_layers=layers_per_block, add_upsample=not is_final_block,
                    temporal_up=temporal_up,
                )
            )
        self.conv_norm_out = nn.GroupNorm(
            num_groups=32, dims=reversed_channels[-1], eps=1e-6, pytorch_compatible=True,
        )
        self.conv_out = CausalConv3d(
            in_channels=reversed_channels[-1], out_channels=out_channels,
            kernel_size=3, stride=1, padding=1,
        )

    def __call__(self, z: mx.array) -> mx.array:
        x = self.conv_in(z)
        x = self.mid_block(x)
        for up_block in self.up_blocks:
            x = up_block(x)
        x = x.transpose(0, 2, 3, 4, 1)
        x = self.conv_norm_out(x.astype(mx.float32)).astype(mx.bfloat16)
        x = x.transpose(0, 4, 1, 2, 3)
        x = nn.silu(x)
        x = self.conv_out(x)
        return x
