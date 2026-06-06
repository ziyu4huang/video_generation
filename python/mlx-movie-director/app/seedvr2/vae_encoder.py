"""SeedVR2 VAE Encoder (3D causal convolutions)."""

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


class Downsample3D(nn.Module):
    def __init__(self, channels: int, spatial_only: bool = False):
        super().__init__()
        kt, st, pt = (1, 1, 0) if spatial_only else (3, 2, 1)
        self.conv = CausalConv3d(
            channels, channels,
            kernel_size=(kt, 3, 3), stride=(st, 2, 2), padding=(pt, 0, 0),
        )

    def __call__(self, x: mx.array) -> mx.array:
        x = mx.pad(x, [(0, 0), (0, 0), (0, 0), (0, 1), (0, 1)])
        return self.conv(x)


class DownBlock3D(nn.Module):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        num_layers: int = 2,
        add_downsample: bool = True,
        temporal_down: bool = False,
    ):
        super().__init__()
        self.resnets = []
        for i in range(num_layers):
            in_ch = in_channels if i == 0 else out_channels
            self.resnets.append(ResnetBlock3D(in_channels=in_ch, out_channels=out_channels))
        self.downsamplers = []
        if add_downsample:
            self.downsamplers.append(Downsample3D(channels=out_channels, spatial_only=not temporal_down))

    def __call__(self, x: mx.array) -> mx.array:
        for resnet in self.resnets:
            x = resnet(x)
        for downsampler in self.downsamplers:
            x = downsampler(x)
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


class Encoder3D(nn.Module):
    def __init__(
        self,
        in_channels: int = 3,
        out_channels: int = 16,
        block_out_channels: tuple = (128, 256, 512, 512),
        layers_per_block: int = 2,
        temporal_down_blocks: int = 2,
    ):
        super().__init__()
        self.conv_in = CausalConv3d(
            in_channels=in_channels, out_channels=block_out_channels[0],
            kernel_size=3, stride=1, padding=1,
        )
        self.down_blocks = []
        output_channel = block_out_channels[0]
        num_blocks = len(block_out_channels)
        for i, channel in enumerate(block_out_channels):
            input_channel = output_channel
            output_channel = channel
            is_final_block = i == num_blocks - 1
            temporal_down = (i >= num_blocks - temporal_down_blocks - 1) and not is_final_block
            self.down_blocks.append(
                DownBlock3D(
                    in_channels=input_channel, out_channels=output_channel,
                    num_layers=layers_per_block, add_downsample=not is_final_block,
                    temporal_down=temporal_down,
                )
            )
        self.mid_block = MidBlock3D(channels=block_out_channels[-1])
        self.conv_norm_out = nn.GroupNorm(
            num_groups=32, dims=block_out_channels[-1], eps=1e-6, pytorch_compatible=True,
        )
        self.conv_out = CausalConv3d(
            in_channels=block_out_channels[-1], out_channels=2 * out_channels,
            kernel_size=3, stride=1, padding=1,
        )

    def __call__(self, x: mx.array) -> mx.array:
        x = self.conv_in(x)
        for down_block in self.down_blocks:
            x = down_block(x)
        x = self.mid_block(x)
        x = x.transpose(0, 2, 3, 4, 1)
        x = self.conv_norm_out(x.astype(mx.float32)).astype(mx.bfloat16)
        x = x.transpose(0, 4, 1, 2, 3)
        x = nn.silu(x)
        x = self.conv_out(x)
        return x
