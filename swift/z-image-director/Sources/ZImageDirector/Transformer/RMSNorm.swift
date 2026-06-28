//
//  RMSNorm.swift
//  ZImageDirector
//
//  Port of app/transformer.py:RMSNorm.
//  Uses MLXFast.rmsNorm (== mx.fast.rms_norm) — identical kernel to Python.
//

import Foundation
import MLX
import MLXNN
import MLXFast

/// RMSNorm: `x / rms(x) * weight`. Mirrors Python `mx.fast.rms_norm(x, weight, eps)`.
public final class ZRMSNorm: Module, UnaryLayer {

    public let weight: MLXArray
    public let eps: Float

    public init(dims: Int, eps: Float = 1e-6) {
        self.weight = MLXArray.ones([dims])
        self.eps = eps
        super.init()
    }

    /// Build from a loaded `weight` array (safetensors).
    public init(weight: MLXArray, eps: Float = 1e-6) {
        self.weight = weight
        self.eps = eps
        super.init()
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.rmsNorm(x, weight: weight, eps: eps)
    }
}
