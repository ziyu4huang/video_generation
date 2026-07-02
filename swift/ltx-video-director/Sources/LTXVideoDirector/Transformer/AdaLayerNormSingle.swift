//
//  AdaLayerNormSingle.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.adaln.AdaLayerNormSingle
//  — produces the DiT block's modulation parameters (scale/shift/gate for
//  attention + MLP) from the timestep embedding.
//

import MLX
import MLXNN

public struct AdaLayerNormSingle {
    public let emb: TimestepEmbedder
    public let linearWeight: MLXArray  // (numParams*dim, timestepDim)
    public let linearBias: MLXArray    // (numParams*dim,)

    public init(emb: TimestepEmbedder, linearWeight: MLXArray, linearBias: MLXArray) {
        self.emb = emb
        self.linearWeight = linearWeight
        self.linearBias = linearBias
    }

    /// Returns (modulationParams (B, numParams*dim), embeddedTimestep (B, dim)).
    public func callAsFunction(_ timestepEmb: MLXArray) -> (params: MLXArray, embedded: MLXArray) {
        let embedded = emb(timestepEmb)
        let params = MLX.matmul(MLXNN.silu(embedded), linearWeight.transposed(1, 0)) + linearBias
        return (params, embedded)
    }
}
