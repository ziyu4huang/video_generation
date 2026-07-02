//
//  TimestepEmbedding.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.timestep_embedding
//  (which re-exports mlx_arsenal.diffusion.{get_timestep_embedding,
//  TimestepEmbedding}) — sinusoidal timestep embedding + the 2-layer MLP
//  that projects it into the transformer's feature space.
//

import Foundation
import MLX
import MLXNN

public enum TimestepEmbedding {
    /// Sinusoidal timestep embedding. Reference: get_timestep_embedding.
    public static func sinusoidal(
        timesteps: MLXArray, embeddingDim: Int, flipSinToCos: Bool = true,
        downscaleFreqShift: Float = 0.0, scale: Float = 1.0, maxPeriod: Float = 10000.0
    ) -> MLXArray {
        let half = embeddingDim / 2
        var exponent = -Foundation.log(maxPeriod) * MLX.arange(half).asType(.float32)
        exponent = exponent / (Float(half) - downscaleFreqShift)
        let freqs = MLX.exp(exponent)
        var args = timesteps.expandedDimensions(axis: 1).asType(.float32) * freqs.expandedDimensions(axis: 0)
        args = scale * args
        var embedding: MLXArray
        if flipSinToCos {
            embedding = MLX.concatenated([MLX.cos(args), MLX.sin(args)], axis: -1)
        } else {
            embedding = MLX.concatenated([MLX.sin(args), MLX.cos(args)], axis: -1)
        }
        if embeddingDim % 2 != 0 {
            embedding = MLX.padded(embedding, widths: [IntOrPair([0, 0]), IntOrPair([0, 1])])
        }
        return embedding
    }
}

/// MLP projecting a sinusoidal timestep embedding into feature space.
/// Weight keys: linear1.{weight,bias}, linear2.{weight,bias}.
public struct TimestepEmbedder {
    public let linear1Weight: MLXArray
    public let linear1Bias: MLXArray
    public let linear2Weight: MLXArray
    public let linear2Bias: MLXArray

    public init(linear1Weight: MLXArray, linear1Bias: MLXArray, linear2Weight: MLXArray, linear2Bias: MLXArray) {
        self.linear1Weight = linear1Weight
        self.linear1Bias = linear1Bias
        self.linear2Weight = linear2Weight
        self.linear2Bias = linear2Bias
    }

    public func callAsFunction(_ sample: MLXArray) -> MLXArray {
        // nn.Linear weight is (out, in); y = x @ W^T + b.
        var h = MLX.matmul(sample, linear1Weight.transposed(1, 0)) + linear1Bias
        h = MLXNN.silu(h)
        return MLX.matmul(h, linear2Weight.transposed(1, 0)) + linear2Bias
    }
}
