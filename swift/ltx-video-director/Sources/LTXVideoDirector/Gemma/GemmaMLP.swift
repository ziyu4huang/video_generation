//
//  GemmaMLP.swift
//  LTXVideoDirector
//
//  Native port of mlx-lm gemma3_text.MLP — SwiGLU:
//    down_proj(gelu_approx(gate_proj(x)) * up_proj(x))
//  gemu_approx = GELU tanh approximation. All linears bias-free.
//

import MLX
import MLXNN

public struct GemmaMLP {
    public let gateProjWeight: MLXArray
    public let upProjWeight: MLXArray
    public let downProjWeight: MLXArray

    public init(gateProjWeight: MLXArray, upProjWeight: MLXArray, downProjWeight: MLXArray) {
        self.gateProjWeight = gateProjWeight
        self.upProjWeight = upProjWeight
        self.downProjWeight = downProjWeight
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let gate = MLX.matmul(x, gateProjWeight.transposed(-1, -2))
        let up = MLX.matmul(x, upProjWeight.transposed(-1, -2))
        let act = MLXNN.geluApproximate(gate)
        let hidden = act * up
        return MLX.matmul(hidden, downProjWeight.transposed(-1, -2))
    }
}
