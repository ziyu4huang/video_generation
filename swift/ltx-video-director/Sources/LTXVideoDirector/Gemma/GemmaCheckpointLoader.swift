//
//  GemmaCheckpointLoader.swift
//  LTXVideoDirector
//
//  Loads + dequantizes Gemma-3-12b-it-4bit weights from the HF cache.
//  Weights are MLX 4-bit quantized (uint32-packed weight + bf16 scales/biases,
//  group_size=64, bits=4). Dequantized to float32 on load (none of the Gemma
//  component code does quantized matmul; matches the transformer port's pattern).
//
//  The checkpoint is split across 2 shards; this loader reads the
//  safetensors index to find which shard holds each key. For a full
//  generation the caller streams blocks one at a time (48 blocks × ~250 MB
//  dequantized each is far too much to hold resident); for parity tests
//  only embed + the target block are loaded.
//

import Foundation
import MLX

public enum GemmaCheckpointLoader {
    /// Root of the HF cache copy of mlx-community/gemma-3-12b-it-4bit.
    public static var modelDir: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent(".cache/huggingface/hub/models--mlx-community--gemma-3-12b-it-4bit/snapshots")
    }

    /// Resolve the snapshot dir (single subdir under snapshots/).
    public static func snapshotDir() throws -> URL {
        guard let snap = try? FileManager.default.contentsOfDirectory(atPath: modelDir.path),
              let first = snap.first else {
            throw NSError(domain: "GemmaCheckpoint", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Gemma snapshot not found in \(modelDir.path) — run dump_gemma_reference.py first to populate the HF cache"])
        }
        return modelDir.appendingPathComponent(first)
    }

    /// Load ALL raw tensors (both shards) keyed by their full checkpoint name.
    /// Strips the leading `language_model.model.` prefix so keys become
    /// `embed_tokens.weight`, `layers.0.self_attn.q_proj.weight`, `norm.weight`, etc.
    public static func loadRaw() throws -> [String: MLXArray] {
        let dir = try snapshotDir()
        let shards = (0..<2).compactMap { i in
            URL(fileURLWithPath: dir.appendingPathComponent("model-0000\(i+1)-of-00002.safetensors").path)
                as URL?
        }.filter { FileManager.default.fileExists(atPath: $0.path) }
        var out: [String: MLXArray] = [:]
        for shard in shards {
            let arr = try MLX.loadArrays(url: shard)
            for (k, v) in arr {
                let stripped = k.hasPrefix("language_model.model.")
                    ? String(k.dropFirst("language_model.model.".count)) : k
                out[stripped] = v
            }
        }
        return out
    }

    private static func dq(_ raw: [String: MLXArray], _ key: String) -> MLXArray {
        let w = raw["\(key).weight"]!
        let scales = raw["\(key).scales"]!
        let biases = raw["\(key).biases"]!
        return MLX.dequantized(w, scales: scales, biases: biases, groupSize: 64, bits: 4, dtype: .float32)
    }

    /// Dequantized embed_tokens weight (vocab, hidden_size).
    public static func embedTokens(_ raw: [String: MLXArray]) -> MLXArray {
        dq(raw, "embed_tokens")
    }

    /// Build a single GemmaBlock for `layerIdx` from raw checkpoint tensors.
    public static func block(_ raw: [String: MLXArray], layerIdx: Int, config: GemmaConfig) -> GemmaBlock {
        let p = "layers.\(layerIdx)"
        let att = GemmaAttention(
            config: config, layerIdx: layerIdx,
            qProjWeight: dq(raw, "\(p).self_attn.q_proj"),
            kProjWeight: dq(raw, "\(p).self_attn.k_proj"),
            vProjWeight: dq(raw, "\(p).self_attn.v_proj"),
            oProjWeight: dq(raw, "\(p).self_attn.o_proj"),
            qNormWeight: raw["\(p).self_attn.q_norm.weight"]!.asType(.float32),
            kNormWeight: raw["\(p).self_attn.k_norm.weight"]!.asType(.float32))
        let mlp = GemmaMLP(
            gateProjWeight: dq(raw, "\(p).mlp.gate_proj"),
            upProjWeight: dq(raw, "\(p).mlp.up_proj"),
            downProjWeight: dq(raw, "\(p).mlp.down_proj"))
        let eps = config.rmsNormEps
        return GemmaBlock(
            attention: att, mlp: mlp,
            inputLayernorm: GemmaRMSNorm(weight: raw["\(p).input_layernorm.weight"]!.asType(.float32), eps: eps),
            postAttentionLayernorm: GemmaRMSNorm(weight: raw["\(p).post_attention_layernorm.weight"]!.asType(.float32), eps: eps),
            preFeedforwardLayernorm: GemmaRMSNorm(weight: raw["\(p).pre_feedforward_layernorm.weight"]!.asType(.float32), eps: eps),
            postFeedforwardLayernorm: GemmaRMSNorm(weight: raw["\(p).post_feedforward_layernorm.weight"]!.asType(.float32), eps: eps))
    }

    /// Final model-norm RMSNorm weight (hidden_size,).
    public static func finalNorm(_ raw: [String: MLXArray], config: GemmaConfig) -> GemmaRMSNorm {
        GemmaRMSNorm(weight: raw["norm.weight"]!.asType(.float32), eps: config.rmsNormEps)
    }
}

/// Embedding lookup + Gemma-3 sqrt(hidden_size) embedding scaling.
/// `h = embed_tokens(token_ids) * sqrt(hidden_size)` — matches
/// base_encoder.get_all_hidden_states exactly. Returns h0 (the FIRST of
/// the 49 hidden states the encoder collects).
public struct GemmaEmbedding {
    public let embedWeight: MLXArray  // (vocab, hidden_size)
    public let hiddenSize: Float

    public init(embedWeight: MLXArray, hiddenSize: Float = 3840) {
        self.embedWeight = embedWeight
        self.hiddenSize = hiddenSize
    }

    public func callAsFunction(_ tokenIds: MLXArray) -> MLXArray {
        // tokenIds: (B, T) int → gather rows → (B, T, hidden)
        let h = MLX.take(embedWeight, tokenIds, axis: 0)
        return h * Foundation.sqrt(hiddenSize)
    }
}

/// Builds the (B, 1, T, T) combined causal + padding mask, matching
/// base_encoder.get_all_hidden_states. Causal upper-triangle = -1e9; padding
/// columns = -1e9. The reference uses bfloat16; we build float32 then it's
/// added inside sdpa (sdpa upcasts softmax to fp32 anyway).
public enum GemmaMask {
    public static func causalCombined(tokenIds: MLXArray, attentionMask: MLXArray?) -> MLXArray {
        let T = tokenIds.dim(1)
        let causal = MLX.triu(MLX.full([T, T], values: MLXArray(Float(-1e9))), k: 1)  // (T, T)
        if let am = attentionMask {
            // am: (B, T) with 1=valid, 0=pad → (B, 1, 1, T) of 0/-1e9
            let pad = (MLXArray(1.0) - am.asType(.float32)) * Float(-1e9)  // (B, T)
            let pad4 = pad.expandedDimensions(axis: 1).expandedDimensions(axis: 1)  // (B,1,1,T)
            return causal.expandedDimensions(axis: 0).expandedDimensions(axis: 0) + pad4  // (B,1,T,T)
        }
        return causal.expandedDimensions(axis: 0).expandedDimensions(axis: 0)  // (1,1,T,T)
    }
}
