//
//  PixelNorm.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.video_vae.normalization.pixel_norm —
//  parameter-free RMS norm over the channel (last) axis, applied per-pixel
//  in the LTX-2.3 video VAE. Python: `mx.fast.rms_norm(x, weight=None, eps)`.
//  MLX Swift's rmsNorm requires a non-optional weight, so this implements
//  the same formula directly: x / sqrt(mean(x^2, axis=-1) + eps).
//

import MLX

public enum PixelNorm {
    public static func apply(_ x: MLXArray, eps: Float = 1e-8) -> MLXArray {
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + eps)
    }
}
