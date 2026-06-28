//
//  FeedForward.swift
//  ZImageDirector
//
//  Port of app/transformer.py:FeedForward (SwiGLU).
//  out = w2( silu(w1(x)) * w3(x) )   — all bias=False.
//

import Foundation
import MLX
import MLXNN

public final class FeedForward: Module {

    public let w1: QuantizedLinear
    public let w2: QuantizedLinear
    public let w3: QuantizedLinear

    /// `dim` = 3840, `hiddenDim` = int(dim/3*8) = 10240.
    public init(dim: Int, hiddenDim: Int) {
        self.w1 = QuantizedLinear(dim, hiddenDim, bias: false)
        self.w2 = QuantizedLinear(hiddenDim, dim, bias: false)
        self.w3 = QuantizedLinear(dim, hiddenDim, bias: false)
        super.init()
    }

    public init(w1: QuantizedLinear, w2: QuantizedLinear, w3: QuantizedLinear) {
        self.w1 = w1
        self.w2 = w2
        self.w3 = w3
        super.init()
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        w2(MLXNN.silu(w1(x)) * w3(x))
    }
}
