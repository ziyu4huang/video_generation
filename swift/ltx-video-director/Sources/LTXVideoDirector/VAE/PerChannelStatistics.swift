//
//  PerChannelStatistics.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.video_vae.ops.PerChannelStatistics +
//  VideoDecoder.denormalize_latent — the per-channel (de)normalization
//  applied to the raw latent before the VAE decoder's conv_in.
//

import MLX

public struct PerChannelStatistics {
    public let mean: MLXArray  // (C,)
    public let std: MLXArray   // (C,)

    public init(mean: MLXArray, std: MLXArray) {
        self.mean = mean
        self.std = std
    }

    /// Reverse per-channel normalization: x * std + mean.
    /// `latent` is (B, F, H, W, C) in MLX layout.
    public func denormalizeLatent(_ latent: MLXArray) -> MLXArray {
        let c = mean.dim(0)
        let meanR = mean.reshaped([1, 1, 1, 1, c])
        let stdR = std.reshaped([1, 1, 1, 1, c])
        return latent * stdR + meanR
    }
}
