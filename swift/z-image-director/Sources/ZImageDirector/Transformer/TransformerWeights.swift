//
//  TransformerWeights.swift
//  ZImageDirector
//
//  Phase 2 weight loader: builds the Swift module tree from the safetensors
//  dict loaded in Phase 1. This is the bridge between `[String: MLXArray]` and
//  typed module instances (QuantizedLinear / ZRMSNorm / etc.).
//
//  The repo's safetensors store Q/K/V UNFUSED (to_q, to_k, to_v). The Python
//  pipeline calls fuse_qkv() at load time; we replicate that fuse here so the
//  Attention forward can use the single-matmul path.
//

import Foundation
import MLX
import MLXNN

/// Loads typed transformer modules from a safetensors weight dictionary.
public struct TransformerWeightLoader {
    public let weights: [String: MLXArray]
    public let config: TransformerConfig
    public let groupSize: Int
    public let bits: Int

    public init(weights: [String: MLXArray], config: TransformerConfig, groupSize: Int = 64, bits: Int = 8) {
        self.weights = weights
        self.config = config
        self.groupSize = groupSize
        self.bits = bits
    }

    // MARK: - Primitive builders

    /// Build a QuantizedLinear from `weight` + `scales` + `biases` (+ optional `bias`),
    /// keyed by `prefix` (e.g. "layers.0.attention.to_q").
    public func quantLinear(_ prefix: String) -> QuantizedLinear {
        let w = weights[prefix + ".weight"]!
        let s = weights[prefix + ".scales"]!
        let b = weights[prefix + ".biases"]!
        let bias = weights[prefix + ".bias"]
        return QuantizedLinear(
            weight: w, bias: bias, scales: s, biases: b,
            groupSize: groupSize, bits: bits
        )
    }

    public func rmsNorm(_ prefix: String, eps: Float = 1e-6) -> ZRMSNorm {
        ZRMSNorm(weight: weights[prefix + ".weight"]!, eps: eps)
    }
    /// Fuse three quantized linears (to_q/k/v) into one, matching Python
    /// Attention.fuse_qkv() for the QuantizedLinear branch.
    public func fuseQKV(_ prefix: String) -> QuantizedLinear {
        let toq = quantLinear(prefix + ".to_q")
        let tok = quantLinear(prefix + ".to_k")
        let tov = quantLinear(prefix + ".to_v")
        let fusedW = MLX.concatenated([toq.weight, tok.weight, tov.weight], axis: 0)
        let fusedS = MLX.concatenated([toq.scales, tok.scales, tov.scales], axis: 0)
        let fusedB = MLX.concatenated([toq.biases!, tok.biases!, tov.biases!], axis: 0)
        let outDim = fusedW.shape[0]
        return QuantizedLinear(
            weight: fusedW, bias: nil, scales: fusedS, biases: fusedB,
            groupSize: groupSize, bits: bits
        )
    }

    // MARK: - Module builders

    public func attention(_ prefix: String) -> Attention {
        let att = Attention(
            dim: config.dim, nheads: config.nheads, ropeTheta: Float(config.ropeTheta), eps: config.normEps,
            toq: quantLinear(prefix + ".to_q"),
            tok: quantLinear(prefix + ".to_k"),
            tov: quantLinear(prefix + ".to_v"),
            too: quantLinear(prefix + ".to_out"),
            normQ: rmsNorm(prefix + ".norm_q", eps: config.normEps),
            normK: rmsNorm(prefix + ".norm_k", eps: config.normEps)
        )
        // Fuse QKV (pipeline does model.fuse_model() after load).
        att.markFused(fuseQKV(prefix))
        return att
    }

    public func feedForward(_ prefix: String) -> FeedForward {
        FeedForward(
            w1: quantLinear(prefix + ".w1"),
            w2: quantLinear(prefix + ".w2"),
            w3: quantLinear(prefix + ".w3")
        )
    }

    public func block(_ prefix: String, modulation: Bool) -> ZImageTransformerBlock {
        let ada: QuantizedLinear? = modulation
            ? quantLinear(prefix + ".adaLN_modulation")
            : nil
        return ZImageTransformerBlock(
            config: config, modulation: modulation,
            attention: attention(prefix + ".attention"),
            feedForward: feedForward(prefix + ".feed_forward"),
            attentionNorm1: rmsNorm(prefix + ".attention_norm1"),
            ffnNorm1: rmsNorm(prefix + ".ffn_norm1"),
            attentionNorm2: rmsNorm(prefix + ".attention_norm2"),
            ffnNorm2: rmsNorm(prefix + ".ffn_norm2"),
            adaLNModulation: ada
        )
    }

    public func finalLayer() -> FinalLayer {
        FinalLayer(
            dim: config.dim, outChannels: config.inChannels * 4,
            linear: quantLinear("final_layer.linear"),
            adaLNLinear: quantLinear("final_layer.adaLN_modulation.layers.1")
        )
    }

    public func tEmbedder() -> TimestepEmbedder {
        TimestepEmbedder(
            outSize: 256, midSize: 1024, frequencyEmbeddingSize: 256,
            linear1: quantLinear("t_embedder.linear1"),
            linear2: quantLinear("t_embedder.linear2")
        )
    }
}
