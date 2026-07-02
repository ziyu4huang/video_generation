//
//  FeedForward.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.feed_forward.FeedForward
//  — the DiT block's MLP: Linear -> GELU(tanh approx) -> Linear. Used both
//  for the main video FFN (`ff`) and the audio FFN (`audio_ff`).
//

import MLX
import MLXNN

public struct FeedForward {
    public let projInWeight: MLXArray   // (innerDim, dim)
    public let projInBias: MLXArray     // (innerDim,)
    public let projOutWeight: MLXArray  // (dimOut, innerDim)
    public let projOutBias: MLXArray    // (dimOut,)

    public init(projInWeight: MLXArray, projInBias: MLXArray, projOutWeight: MLXArray, projOutBias: MLXArray) {
        self.projInWeight = projInWeight
        self.projInBias = projInBias
        self.projOutWeight = projOutWeight
        self.projOutBias = projOutBias
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = MLX.matmul(x, projInWeight.transposed(1, 0)) + projInBias
        h = MLXNN.geluApproximate(h)
        return MLX.matmul(h, projOutWeight.transposed(1, 0)) + projOutBias
    }
}
