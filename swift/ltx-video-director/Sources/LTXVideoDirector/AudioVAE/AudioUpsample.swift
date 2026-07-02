//
//  AudioUpsample.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.audio_vae.AudioUpsample —
//  2x spatial upsample via nearest-neighbor repeat (both H and W) + Conv2d.
//  In causal mode, drops the first row after the conv to maintain temporal
//  alignment (the "H" axis maps to time for the audio VAE — see
//  WrappedConv2d.swift's header).
//

import MLX

public struct AudioUpsample {
    public let conv: WrappedConv2d
    public let causal: Bool

    public init(conv: WrappedConv2d, causal: Bool) {
        self.conv = conv
        self.causal = causal
    }

    /// x: (B, H, W, C) NHWC.
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = MLX.repeated(x, count: 2, axis: 1)
        h = MLX.repeated(h, count: 2, axis: 2)
        h = conv(h)
        if causal {
            let d = h.dim(1)
            h = h[0..., 1..<d, 0..., 0...]
        }
        return h
    }
}
