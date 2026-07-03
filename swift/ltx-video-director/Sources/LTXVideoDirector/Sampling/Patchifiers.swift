//
//  Patchifiers.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.components.patchifiers — converts between
//  spatial VAE latents and the flat (B, N, C) token sequences LTXModel
//  consumes. Pure reshape/transpose (no weights), verified against
//  scripts/dump_positions_patchify_reference.py in PositionsParityTests.
//

import Foundation
import MLX

public enum VideoLatentPatchifier {
    /// (B, C, F, H, W) -> (B, F*H*W, C), returning the (F, H, W) spatial dims
    /// needed to unpatchify / to compute RoPE positions.
    public static func patchify(_ latent: MLXArray) -> (tokens: MLXArray, dims: (f: Int, h: Int, w: Int)) {
        let b = latent.dim(0), c = latent.dim(1), f = latent.dim(2), h = latent.dim(3), w = latent.dim(4)
        let tokens = latent.transposed(0, 2, 3, 4, 1).reshaped([b, f * h * w, c])
        return (tokens, (f, h, w))
    }

    /// (B, N, C) -> (B, C, F, H, W).
    public static func unpatchify(_ tokens: MLXArray, dims: (f: Int, h: Int, w: Int)) -> MLXArray {
        let b = tokens.dim(0), c = tokens.dim(2)
        return tokens.reshaped([b, dims.f, dims.h, dims.w, c]).transposed(0, 4, 1, 2, 3)
    }
}

public enum AudioPatchifier {
    /// (B, 8, T, 16) -> (B, T, 128).
    public static func patchify(_ latent: MLXArray) -> (tokens: MLXArray, t: Int) {
        let b = latent.dim(0), c1 = latent.dim(1), t = latent.dim(2), c2 = latent.dim(3)
        let tokens = latent.transposed(0, 2, 1, 3).reshaped([b, t, c1 * c2])
        return (tokens, t)
    }

    /// (B, T, 128) -> (B, 8, T, 16).
    public static func unpatchify(_ tokens: MLXArray) -> MLXArray {
        let b = tokens.dim(0), t = tokens.dim(1)
        return tokens.reshaped([b, t, 8, 16]).transposed(0, 2, 1, 3)
    }
}

public enum VideoLatentShape {
    /// (F', H', W') latent dims after VAE encoding.
    public static func compute(numFrames: Int, height: Int, width: Int, temporalCompression: Int = 8, spatialCompression: Int = 32) -> (f: Int, h: Int, w: Int) {
        let f = (numFrames + temporalCompression - 1) / temporalCompression
        let h = height / spatialCompression
        let w = width / spatialCompression
        return (f, h, w)
    }
}
