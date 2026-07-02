//
//  AudioResBlock.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.audio_vae.AudioResBlock —
//  pixel_norm -> silu -> conv1 -> pixel_norm -> silu -> conv2 (+ optional
//  1x1 nin_shortcut when in/out channels differ) + residual.
//

import MLX
import MLXNN

public struct AudioResBlock {
    public let conv1: WrappedConv2d
    public let conv2: WrappedConv2d
    public let ninShortcut: WrappedConv2d?

    public init(conv1: WrappedConv2d, conv2: WrappedConv2d, ninShortcut: WrappedConv2d? = nil) {
        self.conv1 = conv1
        self.conv2 = conv2
        self.ninShortcut = ninShortcut
    }

    /// Same formula as PixelNorm.apply / the transformer's rmsNorm-no-affine
    /// helpers, kept local since this one's eps (1e-6) differs from the
    /// video VAE's PixelNorm (1e-8).
    private func pixelNorm(_ x: MLXArray, eps: Float = 1e-6) -> MLXArray {
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + eps)
    }

    /// x: (B, H, W, C) NHWC.
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = pixelNorm(x)
        h = MLXNN.silu(h)
        h = conv1(h)
        h = pixelNorm(h)
        h = MLXNN.silu(h)
        h = conv2(h)
        let residual = ninShortcut.map { $0(x) } ?? x
        return h + residual
    }
}
