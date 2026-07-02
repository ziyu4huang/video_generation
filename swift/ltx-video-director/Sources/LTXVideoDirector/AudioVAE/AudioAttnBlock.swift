//
//  AudioAttnBlock.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.audio_vae.AudioAttnBlock —
//  self-attention over the spatial (H*W) positions of the audio VAE's 2D
//  feature map, gated by a GroupNorm(32, channels, pytorch_compatible=True)
//  pre-norm. New primitive for this port: standard PyTorch GroupNorm
//  reduces over (H, W, channels-in-group) JOINTLY per (batch, group) — NOT
//  the same as a per-pixel channel-only norm (verified against PyTorch's
//  nn.GroupNorm semantics directly, not assumed from any other component
//  in this codebase).
//

import Foundation
import MLX

public struct AudioAttnBlock {
    public let normWeight: MLXArray, normBias: MLXArray
    public let q: WrappedConv2d, k: WrappedConv2d, v: WrappedConv2d
    public let projOut: WrappedConv2d
    public let numGroups: Int

    public init(normWeight: MLXArray, normBias: MLXArray, q: WrappedConv2d, k: WrappedConv2d, v: WrappedConv2d, projOut: WrappedConv2d, numGroups: Int = 32) {
        self.normWeight = normWeight
        self.normBias = normBias
        self.q = q
        self.k = k
        self.v = v
        self.projOut = projOut
        self.numGroups = numGroups
    }

    /// PyTorch-compatible GroupNorm: normalizes over (H, W, channels-in-group)
    /// jointly per (batch, group), then applies a per-channel affine.
    private func groupNorm(_ x: MLXArray, eps: Float = 1e-5) -> MLXArray {
        let b = x.dim(0), h = x.dim(1), w = x.dim(2), c = x.dim(3)
        let cg = c / numGroups
        var xr = x.asType(.float32).reshaped([b, h, w, numGroups, cg])
        xr = xr.transposed(0, 3, 1, 2, 4).reshaped([b, numGroups, h * w * cg])
        let mean = xr.mean(axis: -1, keepDims: true)
        let variance = ((xr - mean) * (xr - mean)).mean(axis: -1, keepDims: true)
        var normed = (xr - mean) / MLX.sqrt(variance + eps)
        normed = normed.reshaped([b, numGroups, h, w, cg]).transposed(0, 2, 3, 1, 4).reshaped([b, h, w, c])
        let weight = normWeight.asType(.float32).reshaped([1, 1, 1, c])
        let bias = normBias.asType(.float32).reshaped([1, 1, 1, c])
        return normed * weight + bias
    }

    /// x: (B, H, W, C) NHWC.
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let b = x.dim(0), h = x.dim(1), w = x.dim(2), c = x.dim(3)
        let residual = x
        let normed = groupNorm(x)

        let qFlat = q(normed).reshaped([b, h * w, c])
        let kFlat = k(normed).reshaped([b, h * w, c])
        let vFlat = v(normed).reshaped([b, h * w, c])

        let scale = Float(Foundation.pow(Double(c), -0.5))
        var attn = MLX.matmul(qFlat, kFlat.transposed(0, 2, 1)) * scale
        attn = MLX.softmax(attn, axis: -1)

        var out = MLX.matmul(attn, vFlat).reshaped([b, h, w, c])
        out = projOut(out)
        return residual + out
    }
}
