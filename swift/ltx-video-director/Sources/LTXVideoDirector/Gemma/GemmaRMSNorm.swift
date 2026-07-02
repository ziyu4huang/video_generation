//
//  GemmaRMSNorm.swift
//  LTXVideoDirector
//
//  Native port of mlx-lm gemma3_text.RMSNorm. Gemma's RMSNorm centers the
//  learnable weight at 1.0 (not 0.0): `mx.fast.rms_norm(x, 1.0 + weight, eps)`.
//  MLX Swift's rmsNorm requires a non-optional weight, so we add 1.0 here.
//

import MLX

public struct GemmaRMSNorm {
    public let weight: MLXArray
    public let eps: Float

    public init(weight: MLXArray, eps: Float = 1e-6) {
        self.weight = weight
        self.eps = eps
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLX.rmsNorm(x, weight: 1.0 + weight, eps: eps)
    }
}
