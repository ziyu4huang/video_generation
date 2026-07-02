//
//  Sampling.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.video_vae.sampling's pixel-shuffle /
//  space-to-depth rearrangement ops (no learnable weights — pure
//  reshape/transpose) plus DepthToSpaceUpsample, which is literally a
//  Conv3dBlock (the caller applies pixelShuffle3D to its output).
//

import MLX

public enum VAESampling {
    /// Depth-to-space: (B, D, H, W, C*sf*sf*tf) -> (B, D*tf, H*sf, W*sf, C).
    /// Channel split order (c, temporal, height, width) — c outermost.
    public static func pixelShuffle3D(_ x: MLXArray, spatialFactor sf: Int, temporalFactor tf: Int) -> MLXArray {
        let B = x.dim(0), D = x.dim(1), H = x.dim(2), W = x.dim(3), cTotal = x.dim(4)
        let c = cTotal / (sf * sf * tf)
        var h = x.reshaped([B, D, H, W, c, tf, sf, sf])
        h = h.transposed(0, 1, 5, 2, 6, 3, 7, 4)
        return h.reshaped([B, D * tf, H * sf, W * sf, c])
    }

    /// Reverse spatial patchification for the final VAE output. Channel
    /// split order (c, r=width, q=height) — r before q, unlike pixelShuffle3D.
    public static func unpatchifySpatial(_ x: MLXArray, patchSize ps: Int) -> MLXArray {
        let B = x.dim(0), F = x.dim(1), H = x.dim(2), W = x.dim(3), cTotal = x.dim(4)
        let c = cTotal / (ps * ps)
        var h = x.reshaped([B, F, H, W, c, ps, ps])
        h = h.transposed(0, 1, 2, 6, 3, 5, 4)
        return h.reshaped([B, F, H * ps, W * ps, c])
    }
}

/// Convolution used as an upsample layer — the pixel-shuffle rearrangement
/// is applied by the caller (VAESampling.pixelShuffle3D on the output).
public struct DepthToSpaceUpsample {
    public let conv: Conv3dBlock

    public init(conv: Conv3dBlock) {
        self.conv = conv
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        conv(x)
    }
}
