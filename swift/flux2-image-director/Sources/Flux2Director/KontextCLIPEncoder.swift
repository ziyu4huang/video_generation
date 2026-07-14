//
//  KontextCLIPEncoder.swift
//  Flux2Director
//
//  Part of the `kontext` (FLUX.1-Kontext-dev) native-port epic, phase 4b —
//  see output/next-goal-20260714_212213.md. Ported directly from mflux's
//  CLIP text encoder: `../mflux/src/mflux/models/flux/model/flux_text_encoder/
//  clip_encoder/{clip_text_model,clip_embeddings,encoder_clip,
//  clip_encoder_layer,clip_mlp,clip_sdpa_attention,clip_encoder}.py`.
//
//  Architecture (per HF `text_encoder/config.json`, standard OpenAI CLIP ViT-L
//  text tower, same as base FLUX.1-dev): dims=768, 12 encoder layers, 12
//  attention heads (head_dim=64), quick_gelu MLP (768->3072->768), causal
//  self-attention, max sequence length 77. Weight keys are an IDENTITY mapping
//  vs the raw HF checkpoint (confirmed via `FluxWeightMapping.
//  get_clip_encoder_mapping()` — every `to_pattern` equals its `from_pattern`)
//  so `load()` below reads the raw HF `text_encoder/*.safetensors` shard(s)
//  directly, same strategy as `KontextTransformer.swift`. Unquantized (plain
//  FLUX.1-dev weights, like the base transformer).
//
//  Output: `pooled_output` (1, 768) — last_hidden_state at each sequence's EOS
//  token position (highest token id, standard CLIP pooling trick), used as
//  the transformer's `pooled_projections` conditioning input.
//
//  Numerically verified via `flux2 verify-kontext-clip` against
//  `gen_kontext_clip_ref.py` (real HF weights + real CLIPTokenizer + real
//  mflux CLIPEncoder forward pass).
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - LayerNorm (weight+bias loaded directly, MLXNN.LayerNorm has no such initializer)

struct KClipLayerNorm {
    let weight: MLXArray
    let bias: MLXArray
    let eps: Float = 1e-5

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.layerNorm(x, weight: weight, bias: bias, eps: eps)
    }
}

// MARK: - Attention (standard MHA, causal, head_dim=64, 12 heads)

struct KClipAttention {
    let qProj: MLXNN.Linear
    let kProj: MLXNN.Linear
    let vProj: MLXNN.Linear
    let outProj: MLXNN.Linear
    static let numHeads = 12
    static let headDim = 64

    func callAsFunction(_ x: MLXArray, causalMask: MLXArray) -> MLXArray {
        let (b, l, _) = (x.dim(0), x.dim(1), x.dim(2))
        func reshape(_ t: MLXArray) -> MLXArray {
            t.reshaped([b, l, Self.numHeads, Self.headDim]).transposed(0, 2, 1, 3)
        }
        let q = reshape(qProj(x))
        let k = reshape(kProj(x))
        let v = reshape(vProj(x))
        let scale = 1.0 / Float(Self.headDim).squareRoot()
        let out = MLXFast.scaledDotProductAttention(queries: q, keys: k, values: v,
                                                     scale: scale, mask: causalMask)
        let merged = out.transposed(0, 2, 1, 3).reshaped([b, l, Self.numHeads * Self.headDim])
        return outProj(merged)
    }
}

// MARK: - MLP (quick_gelu)

struct KClipMLP {
    let fc1: MLXNN.Linear
    let fc2: MLXNN.Linear

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let h = fc1(x)
        let quickGelu = h * MLX.sigmoid(1.702 * h)
        return fc2(quickGelu)
    }
}

// MARK: - Encoder layer

struct KClipEncoderLayer {
    let selfAttn: KClipAttention
    let layerNorm1: KClipLayerNorm
    let mlp: KClipMLP
    let layerNorm2: KClipLayerNorm

    func callAsFunction(_ x: MLXArray, causalMask: MLXArray) -> MLXArray {
        var h = x
        h = h + selfAttn(layerNorm1(h), causalMask: causalMask)
        h = h + mlp(layerNorm2(h))
        return h
    }
}

// MARK: - Full CLIP text encoder

public final class KontextCLIPEncoder {
    let tokenEmbedding: MLXNN.Embedding
    let positionEmbedding: MLXNN.Embedding
    let layers: [KClipEncoderLayer]
    let finalLayerNorm: KClipLayerNorm

    init(tokenEmbedding: MLXNN.Embedding, positionEmbedding: MLXNN.Embedding,
         layers: [KClipEncoderLayer], finalLayerNorm: KClipLayerNorm) {
        self.tokenEmbedding = tokenEmbedding
        self.positionEmbedding = positionEmbedding
        self.layers = layers
        self.finalLayerNorm = finalLayerNorm
    }

    /// `inputIds`: (1, L) int32 token ids. Returns `pooled_output`: (1, 768).
    /// Matches mflux's `CLIPTextModel.__call__` (batch size fixed to 1, same
    /// as the Python reference).
    public func callAsFunction(_ inputIds: MLXArray) -> MLXArray {
        let seqLen = inputIds.dim(1)
        let positionIds = MLX.arange(0, seqLen).reshaped([1, seqLen])

        var hidden = tokenEmbedding(inputIds) + positionEmbedding(positionIds)

        // Causal attention mask: (1,1,L,L), upper triangle = -3.4e38 (matches
        // mflux's `CLIPTextModel.create_causal_attention_mask`).
        let tri = MLX.tril(MLX.ones([seqLen, seqLen]), k: 0)
        let mask = ((1 - tri) * -3.4e38).reshaped([1, 1, seqLen, seqLen]).asType(hidden.dtype)

        for layer in layers {
            hidden = layer(hidden, causalMask: mask)
        }
        let lastHiddenState = finalLayerNorm(hidden)

        // pooled_output = last_hidden_state[0, argmax(input_ids, axis=-1)]
        // (EOS token has the highest token id in CLIP's vocab).
        let eosPos = MLX.argMax(inputIds, axis: -1).item(Int.self)
        return lastHiddenState[0, eosPos].reshaped([1, -1])
    }
}

// MARK: - Weight loader

public struct KontextCLIPWeights {
    public let arrays: [String: MLXArray]

    /// `dir` — the `text_encoder/` subdir of a downloaded
    /// `black-forest-labs/FLUX.1-Kontext-dev` snapshot.
    public static func load(dir: URL) throws -> KontextCLIPWeights {
        var weights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for f in files {
            let shard = try loadArrays(url: f)
            weights.merge(shard) { _, new in new }
        }
        return KontextCLIPWeights(arrays: weights)
    }
}

public extension KontextCLIPEncoder {
    static func build(weights: KontextCLIPWeights, precision: DType = .bfloat16) -> KontextCLIPEncoder {
        let w = weights.arrays
        func lin(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: w["\(key).bias"].map { $0.asType(precision) })
        }
        func ln(_ key: String) -> KClipLayerNorm {
            KClipLayerNorm(weight: w["\(key).weight"]!.asType(.float32),
                           bias: w["\(key).bias"]!.asType(.float32))
        }
        func embed(_ key: String) -> MLXNN.Embedding {
            Embedding(weight: w["\(key).weight"]!.asType(precision))
        }

        var numLayers = 0
        while w["text_model.encoder.layers.\(numLayers).self_attn.q_proj.weight"] != nil { numLayers += 1 }

        let layers = (0..<numLayers).map { i -> KClipEncoderLayer in
            let p = "text_model.encoder.layers.\(i)"
            return KClipEncoderLayer(
                selfAttn: KClipAttention(
                    qProj: lin("\(p).self_attn.q_proj"), kProj: lin("\(p).self_attn.k_proj"),
                    vProj: lin("\(p).self_attn.v_proj"), outProj: lin("\(p).self_attn.out_proj")),
                layerNorm1: ln("\(p).layer_norm1"),
                mlp: KClipMLP(fc1: lin("\(p).mlp.fc1"), fc2: lin("\(p).mlp.fc2")),
                layerNorm2: ln("\(p).layer_norm2"))
        }

        return KontextCLIPEncoder(
            tokenEmbedding: embed("text_model.embeddings.token_embedding"),
            positionEmbedding: embed("text_model.embeddings.position_embedding"),
            layers: layers,
            finalLayerNorm: ln("text_model.final_layer_norm"))
    }
}
