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

    /// Spatial patchification (space-to-depth) for the VAE encoder's input:
    /// (B, F, H, W, C) -> (B, F, H/ps, W/ps, C*ps*ps). Channel order
    /// (c, r=width, q=height) — same convention as unpatchifySpatial (its
    /// inverse).
    public static func patchifySpatial(_ x: MLXArray, patchSize ps: Int) -> MLXArray {
        let B = x.dim(0), F = x.dim(1), H = x.dim(2), W = x.dim(3), c = x.dim(4)
        var h = x.reshaped([B, F, H / ps, ps, W / ps, ps, c])
        h = h.transposed(0, 1, 2, 4, 6, 5, 3)
        return h.reshaped([B, F, H / ps, W / ps, c * ps * ps])
    }

    /// Space-to-depth downsampling: (B, D_full, H_full, W_full, C) ->
    /// (B, D, H, W, C*st*sh*sw). Channel order (c, temporal, height, width)
    /// — c outermost, matching pixelShuffle3D's (its approximate inverse for
    /// the encoder's downsample path).
    public static func spaceToDepth(_ x: MLXArray, stride: (Int, Int, Int)) -> MLXArray {
        let B = x.dim(0), dFull = x.dim(1), hFull = x.dim(2), wFull = x.dim(3), c = x.dim(4)
        let (st, sh, sw) = stride
        let d = dFull / st, h = hFull / sh, w = wFull / sw
        var y = x.reshaped([B, d, st, h, sh, w, sw, c])
        y = y.transposed(0, 1, 3, 5, 7, 2, 4, 6)
        return y.reshaped([B, d, h, w, c * st * sh * sw])
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
