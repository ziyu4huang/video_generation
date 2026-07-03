//
//  ConnectorCheckpointLoader.swift
//  LTXVideoDirector
//
//  Loads the real LTX-2.3 connector checkpoint
//  (mlx-models/text_encoder/ltx-2.3-connector/connector.safetensors) and
//  builds TextEmbeddingProjection + the video/audio Embeddings1DConnector
//  instances from it. Confirmed by direct inspection (not assumed): 490
//  tensors under three top-level prefixes —
//  `connector.text_embedding_projection.*` (the video/audio aggregate-embed
//  Linears), `connector.video_embeddings_connector.*` (8
//  transformer_1d_blocks + learnable_registers, dim=4096, head_dim=128),
//  `connector.audio_embeddings_connector.*` (8 blocks, dim=2048,
//  head_dim=64) — NOT 48 layers each; `num_layers: 48` in config.json
//  describes the DiT, not this connector.
//
//  Quantization: int4, group_size=32 (confirmed against
//  app/vendor_patches.py's `_quantize_connector_to_match_weights` comment:
//  "the connector is int4/group_size=32" — deliberately different from the
//  transformer checkpoint's int8/group_size=64, per QuantizedWeights.swift).
//  No `to_out` norm_out weight exists in the checkpoint, matching
//  Embeddings1DConnector's parameter-free output RMSNorm.
//

import Foundation
import MLX

public enum ConnectorCheckpointLoader {
    public static var checkpointURL: URL {
        RepoPaths.mlxModelsRoot
            .appendingPathComponent("text_encoder/ltx-2.3-connector/connector.safetensors")
    }

    /// Load + dequantize (int4, group_size=32) every tensor, stripping the
    /// leading `connector.` prefix so keys become `text_embedding_projection.*`,
    /// `video_embeddings_connector.*`, `audio_embeddings_connector.*`.
    public static func loadRaw(url: URL = checkpointURL) throws -> [String: MLXArray] {
        let raw = try MLX.loadArrays(url: url)
        var stripped: [String: MLXArray] = [:]
        for (k, v) in raw {
            let key = k.hasPrefix("connector.") ? String(k.dropFirst("connector.".count)) : k
            stripped[key] = v
        }
        return QuantizedWeights.dequantizeLinearWeights(stripped, groupSize: 32, bits: 4)
    }

    public static func makeTextEmbeddingProjection(_ arrays: [String: MLXArray]) -> TextEmbeddingProjection {
        TextEmbeddingProjection(
            weights: arrays.filter { $0.key.hasPrefix("text_embedding_projection.") }
                .reduce(into: [:]) { acc, kv in
                    acc[String(kv.key.dropFirst("text_embedding_projection.".count))] = kv.value
                })
    }

    /// Builds one Embeddings1DConnector (video or audio side) from
    /// `connector.{video,audio}_embeddings_connector.*` keys.
    public static func makeConnector(
        _ arrays: [String: MLXArray], side: String, dim: Int, headDim: Int,
        maxPos: Int = 4096, ropeTheta: Double = 10000.0
    ) -> Embeddings1DConnector {
        let prefix = "\(side)_embeddings_connector."
        let scoped = arrays.filter { $0.key.hasPrefix(prefix) }
            .reduce(into: [String: MLXArray]()) { acc, kv in
                acc[String(kv.key.dropFirst(prefix.count))] = kv.value
            }

        var layerIdx = 0
        var blocks: [ConnectorTransformerBlock] = []
        while scoped["transformer_1d_blocks.\(layerIdx).attn1.to_q.weight"] != nil {
            let p = "transformer_1d_blocks.\(layerIdx)"
            let numHeads = dim / headDim
            let attn = Attention(
                numHeads: numHeads, headDim: headDim, useRope: true,
                toQWeight: scoped["\(p).attn1.to_q.weight"]!, toQBias: scoped["\(p).attn1.to_q.bias"],
                toKWeight: scoped["\(p).attn1.to_k.weight"]!, toKBias: scoped["\(p).attn1.to_k.bias"],
                toVWeight: scoped["\(p).attn1.to_v.weight"]!, toVBias: scoped["\(p).attn1.to_v.bias"],
                toOutWeight: scoped["\(p).attn1.to_out.0.weight"]!, toOutBias: scoped["\(p).attn1.to_out.0.bias"]!,
                toGateLogitsWeight: scoped["\(p).attn1.to_gate_logits.weight"], toGateLogitsBias: scoped["\(p).attn1.to_gate_logits.bias"],
                qNormWeight: scoped["\(p).attn1.q_norm.weight"]!, kNormWeight: scoped["\(p).attn1.k_norm.weight"]!)
            let ff = FeedForward(
                projInWeight: scoped["\(p).ff.net.0.proj.weight"]!, projInBias: scoped["\(p).ff.net.0.proj.bias"]!,
                projOutWeight: scoped["\(p).ff.net.2.weight"]!, projOutBias: scoped["\(p).ff.net.2.bias"]!)
            blocks.append(ConnectorTransformerBlock(attn: attn, ff: ff, normEps: 1e-6))
            layerIdx += 1
        }

        return Embeddings1DConnector(
            learnableRegisters: scoped["learnable_registers"]!, blocks: blocks,
            dim: dim, headDim: headDim, maxPos: maxPos, normOutput: true, ropeTheta: ropeTheta)
    }
}
