//
//  SpaceToDepthDownsample.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.video_vae.sampling.SpaceToDepthDownsample
//  — the VAE encoder's downsampling block: a conv branch (space-to-depth
//  after a 3x3x3 conv) plus a parameter-free "skip" branch (space-to-depth
//  then group-mean), summed.
//

import MLX

public struct SpaceToDepthDownsample {
    public let conv: Conv3dBlock
    public let stride: (Int, Int, Int)
    public let groupSize: Int

    public init(conv: Conv3dBlock, stride: (Int, Int, Int), groupSize: Int) {
        self.conv = conv
        self.stride = stride
        self.groupSize = groupSize
    }

    /// Convenience initializer matching the Python constructor's channel-derived
    /// group_size/conv_out_ch computation exactly.
    public init(weight: MLXArray, bias: MLXArray, inChannels: Int, outChannels: Int, stride: (Int, Int, Int)) {
        let (st, sh, sw) = stride
        self.stride = stride
        self.groupSize = inChannels * sh * sw * st / outChannels
        self.conv = Conv3dBlock(weight: weight, bias: bias, causal: true, spatialPaddingMode: "zeros")
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        if stride.0 == 2 {
            let firstFrame = h[0..., 0..<1, 0..., 0..., 0...]
            h = MLX.concatenated([firstFrame, h], axis: 1)
        }

        var xIn = VAESampling.spaceToDepth(h, stride: stride)
        if groupSize > 1 {
            let B = xIn.dim(0), D = xIn.dim(1), H = xIn.dim(2), W = xIn.dim(3), cTotal = xIn.dim(4)
            let cOut = cTotal / groupSize
            xIn = xIn.reshaped([B, D, H, W, cOut, groupSize])
            xIn = xIn.mean(axis: -1)
        }

        var xConv = conv(h)
        xConv = VAESampling.spaceToDepth(xConv, stride: stride)

        return xConv + xIn
    }
}
