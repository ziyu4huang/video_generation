"""Dump a full VideoDecoder-assembly forward-pass reference for Swift parity testing.

Assembles a MINIATURE decoder from the REAL ltx_core_mlx components
(Conv3dBlock, ResBlockStage, DepthToSpaceUpsample, PerChannelStatistics,
pixel_norm, unpatchify_spatial) with the EXACT same stage/upsample-factor/
frame-drop wiring as the real VideoDecoder.decode() (5 res stages + 4
upsamples interleaved, same _upsample_config, same "drop first frame
after tf>1" rule, same pre-activation PixelNorm+SiLU before conv_out) —
just at tiny channel widths so the reference file stays small. The REAL,
full-size checkpoint is verified separately and directly (no stored
reference needed) by VideoDecoderRealCheckpointTests.swift, which loads
mlx-models/vae/ltx-2.3-vae/vae_decoder.safetensors straight off disk.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_videodecoder_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import mlx.nn as nn
import mlx.utils
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.model.video_vae.convolution import Conv3dBlock  # noqa: E402
from ltx_core_mlx.model.video_vae.normalization import pixel_norm  # noqa: E402
from ltx_core_mlx.model.video_vae.ops import PerChannelStatistics  # noqa: E402
from ltx_core_mlx.model.video_vae.resnet import ResBlockStage  # noqa: E402
from ltx_core_mlx.model.video_vae.sampling import DepthToSpaceUpsample, pixel_shuffle_3d, unpatchify_spatial  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "video_decoder")
os.makedirs(OUT_DIR, exist_ok=True)

LATENT_CH = 4
STAGE_CH = [8, 8, 4, 4, 4]         # up_blocks 0,2,4,6,8 channel counts
NUM_BLOCKS = [2, 2, 2, 2, 2]       # up_blocks 0,2,4,6,8 block counts (real: 2,2,4,6,4)
UPSAMPLE_CONV_OUT = [8 * 2 * 2 * 2, 4 * 2 * 2 * 2, 4 * 1 * 1 * 2, 4 * 2 * 2 * 1]  # up_blocks 1,3,5,7
UPSAMPLE_CONFIG = [(2, 2), (2, 2), (1, 2), (2, 1)]  # (spatial_factor, temporal_factor)
OUT_CH = 3
PATCH_SIZE = 2
CONV_OUT_CH = OUT_CH * PATCH_SIZE * PATCH_SIZE


class MiniVideoDecoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_in = Conv3dBlock(LATENT_CH, STAGE_CH[0], kernel_size=3, padding=1, causal=False, spatial_padding_mode="zeros")
        self.res_stages = [
            ResBlockStage(STAGE_CH[i], num_blocks=NUM_BLOCKS[i], causal=False, spatial_padding_mode="zeros")
            for i in range(5)
        ]
        self.upsamples = [
            DepthToSpaceUpsample(STAGE_CH[i], UPSAMPLE_CONV_OUT[i], causal=False, spatial_padding_mode="zeros")
            for i in range(4)
        ]
        self.conv_out = Conv3dBlock(STAGE_CH[-1], CONV_OUT_CH, kernel_size=3, padding=1, causal=False, spatial_padding_mode="zeros")
        self.per_channel_statistics = PerChannelStatistics(LATENT_CH)

    def decode(self, latent_bcfhw: mx.array) -> mx.array:
        x = latent_bcfhw.transpose(0, 2, 3, 4, 1)  # BCFHW -> BFHWC
        mean = self.per_channel_statistics.mean.reshape(1, 1, 1, 1, -1)
        std = self.per_channel_statistics.std.reshape(1, 1, 1, 1, -1)
        x = x * std + mean

        x = self.conv_in(x)
        for i in range(5):
            x = self.res_stages[i](x)
            if i < 4:
                x = self.upsamples[i](x)
                sf, tf = UPSAMPLE_CONFIG[i]
                x = pixel_shuffle_3d(x, spatial_factor=sf, temporal_factor=tf)
                if tf > 1:
                    x = x[:, 1:, :, :, :]

        x = self.conv_out(nn.silu(pixel_norm(x)))
        x = unpatchify_spatial(x, patch_size=PATCH_SIZE)
        return x.transpose(0, 4, 1, 2, 3)  # BFHWC -> BCFHW


if __name__ == "__main__":
    decoder = MiniVideoDecoder()

    key = mx.random.key(123)
    flat = mlx.utils.tree_flatten(decoder.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * 0.1))
    decoder.update(mlx.utils.tree_unflatten(new_flat))
    decoder.per_channel_statistics.mean = mx.random.normal((LATENT_CH,), key=mx.random.key(124)) * 0.1
    decoder.per_channel_statistics.std = mx.abs(mx.random.normal((LATENT_CH,), key=mx.random.key(125))) * 0.2 + 0.9

    latent = mx.random.normal((1, LATENT_CH, 2, 2, 2), key=mx.random.key(126)) * 0.5
    pixels = decoder.decode(latent)
    mx.eval(pixels)
    print("latent", latent.shape, "-> pixels", pixels.shape)

    weights_out = {k: np.array(v, copy=False) for k, v in mlx.utils.tree_flatten(decoder.parameters())}
    weights_out["latent"] = np.array(latent, copy=False)
    weights_out["output"] = np.array(pixels, copy=False)
    save_file(weights_out, os.path.join(OUT_DIR, "decode_tiny.safetensors"))

    meta = {
        "latent_ch": LATENT_CH, "stage_ch": STAGE_CH, "num_blocks": NUM_BLOCKS,
        "upsample_conv_out": UPSAMPLE_CONV_OUT, "upsample_config": UPSAMPLE_CONFIG,
        "patch_size": PATCH_SIZE, "conv_out_ch": CONV_OUT_CH,
        "latent_shape": list(latent.shape), "output_shape": list(pixels.shape),
        "weight_keys": [k for k, _ in mlx.utils.tree_flatten(decoder.parameters())],
    }
    with open(os.path.join(OUT_DIR, "decode_tiny.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("done ->", OUT_DIR)
