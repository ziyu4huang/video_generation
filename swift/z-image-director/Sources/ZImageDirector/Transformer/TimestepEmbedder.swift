//
//  TimestepEmbedder.swift
//  ZImageDirector
//
//  Port of app/transformer.py:TimestepEmbedder.
//  Sinusoidal timestep embedding → Linear(256→mid) → SiLU → Linear(mid→out).
//

import Foundation
import MLX
import MLXNN

public final class TimestepEmbedder: Module {

    public let linear1: QuantizedLinear
    public let linear2: QuantizedLinear
    public let frequencyEmbeddingSize: Int

    /// `outSize` = 256 (Z-Image), `midSize` = 1024, `frequencyEmbeddingSize` = 256.
    public init(outSize: Int = 256, midSize: Int = 1024, frequencyEmbeddingSize: Int = 256) {
        self.frequencyEmbeddingSize = frequencyEmbeddingSize
        // Placeholders — real weights are injected in TransformerWeightLoader.
        self.linear1 = QuantizedLinear(frequencyEmbeddingSize, midSize, bias: true)
        self.linear2 = QuantizedLinear(midSize, outSize, bias: true)
        super.init()
    }

    /// Construct with pre-loaded quantized weights (from safetensors slice).
    public init(
        outSize: Int = 256, midSize: Int = 1024, frequencyEmbeddingSize: Int = 256,
        linear1: QuantizedLinear, linear2: QuantizedLinear
    ) {
        self.frequencyEmbeddingSize = frequencyEmbeddingSize
        self.linear1 = linear1
        self.linear2 = linear2
        super.init()
    }

    /// Sinusoidal embedding: concat(cos(t·freqs), sin(t·freqs)) — exactly the
    /// Python formula in TimestepEmbedder.__call__.
    public func sinusoidalEmbedding(_ t: MLXArray) -> MLXArray {
        let t = t.asType(.float32)
        let half = frequencyEmbeddingSize / 2
        let freqs = MLX.exp(
            -MLX.log(MLXArray(10000.0))
            * MLXArray.arange(0, half).asType(.float32) / Float(half)
        )
        // args: (t[:, None] * freqs[None, :])  → broadcast over batch
        let args = t.expandedDimensions(axis: -1) * freqs.expandedDimensions(axis: 0)
        var embedding = MLX.concatenated([MLX.cos(args), MLX.sin(args)], axis: -1)
        if frequencyEmbeddingSize % 2 != 0 {
            let pad = zeros(like: embedding[0..., 0..<1])
            embedding = MLX.concatenated([embedding, pad], axis: 1)
        }
        return embedding
    }

    public func callAsFunction(_ t: MLXArray) -> MLXArray {
        let emb = sinusoidalEmbedding(t)
        return linear2(MLXNN.silu(linear1(emb)))
    }
}
