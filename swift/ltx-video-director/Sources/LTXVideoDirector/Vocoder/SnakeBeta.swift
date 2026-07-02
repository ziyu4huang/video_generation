//
//  SnakeBeta.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.vocoder.SnakeBeta — the
//  BigVGAN v2 vocoder's periodic activation: x + (1/b) * sin^2(a*x).
//  Weights are stored in LOG-SCALE (alpha/beta); forward exponentiates
//  them to get the actual per-channel scale factors (zero-init -> exp(0)=1).
//

import MLX

public struct SnakeBeta {
    public let alpha: MLXArray  // log-scale, (channels,)
    public let beta: MLXArray   // log-scale, (channels,)

    public init(alpha: MLXArray, beta: MLXArray) {
        self.alpha = alpha
        self.beta = beta
    }

    /// x: (B, T, C).
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let a = MLX.exp(alpha).reshaped([1, 1, -1])
        let b = MLX.exp(beta).reshaped([1, 1, -1])
        let sinTerm = MLX.sin(a * x)
        return x + (1.0 / (b + 1e-9)) * (sinTerm * sinTerm)
    }
}
