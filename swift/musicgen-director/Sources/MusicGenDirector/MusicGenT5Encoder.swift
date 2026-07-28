//
//  MusicGenT5Encoder.swift
//  MusicGenDirector
//
//  T5-base text encoder for MusicGen's text conditioning. Adapted from
//  flux2-image-director's KontextT5Encoder.swift (relative-position-bias
//  attention + RMSNorm-style layer norm reused unchanged — same T5
//  architecture family) with two real differences confirmed by reading both
//  the Kontext port and t5-base's actual config.json (num_heads=12, d_kv=64,
//  d_model=768, num_layers=12, dense_act_fn="relu", layer_norm_epsilon=1e-6):
//    1. numHeads/headDim are constructor params, not hardcoded statics
//       (KontextT5Encoder hardcodes 64/64 for T5-XXL; t5-base needs 12/64).
//    2. FFN is the ORIGINAL T5 single-matrix-relu variant (`wi.weight` +
//       plain relu), NOT T5-v1.1/XXL's gated-gelu `wi_0`/`wi_1` variant.
//
//  Weight keys: identity mapping vs the raw HF text_encoder/ checkpoint
//  (post-prefix-strip, see import-musicgen.py) — verified directly against
//  the real mlx-models/musicgen/musicgen-small/text_encoder.safetensors
//  (99 keys: encoder.block.{0..11}.layer.0.SelfAttention.{q,k,v,o}.weight,
//  block 0 also carries relative_attention_bias.weight (32, 12);
//  encoder.block.{0..11}.layer.1.DenseReluDense.{wi,wo}.weight (plain relu,
//  no wi_0/wi_1 gate); encoder.block.{0..11}.layer.{0,1}.layer_norm.weight;
//  encoder.final_layer_norm.weight; shared.weight (32128, 768)) —
//  relative_attention_bias is stored once (block 0) and shared across all
//  blocks — same broadcast-at-load-time handling as KontextT5Weights.
//
//  Padding mask: unlike KontextT5Encoder (compared against mflux's own
//  unmasked MLX T5Encoder, so both sides are consistently unmasked),
//  MusicGen's real HF `T5Stack.forward` DOES apply the tokenizer's
//  attention_mask as an additive bias before softmax, and MusicGen's real
//  prompts are short relative to a padded max_length (unlike Kontext's long
//  prompts closer to filling max_length=512) -- confirmed empirically: an
//  unmasked forward pass here scored cos=0.33 against the real masked HF
//  reference. So `callAsFunction` takes an optional `attentionMask` and
//  applies it as a real (1-mask)*-1e9 additive bias per HF's convention.
//
//  Numerically verified via `musicgen verify-t5` against gen_musicgen_t5_ref.py.
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - Layer norm (RMS-style, shared with KontextT5Encoder's math)

struct MGT5LayerNorm {
    let weight: MLXArray
    let eps: Float = 1e-6   // t5-base's layer_norm_epsilon (confirmed from config.json)

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let xf = x.asType(.float32)
        let variance = MLX.mean(xf * xf, axis: -1, keepDims: true)
        let normed = xf * MLX.rsqrt(variance + eps)
        return weight * normed.asType(x.dtype)
    }
}

// MARK: - Relative position bias (32 buckets, bidirectional, max_distance=128 — same as Kontext T5)

enum MGT5RelativePositionBias {
    static let numBuckets = 32
    static let maxDistance = 128

    static func computeBuckets(seqLen: Int, bidirectional: Bool = true) -> MLXArray {
        let contextPos = MLX.arange(0, seqLen).reshaped([seqLen, 1])
        let memoryPos = MLX.arange(0, seqLen).reshaped([1, seqLen])
        let relativePosition = memoryPos - contextPos

        var numBucketsLocal = numBuckets
        var relativeBuckets = MLX.zeros(like: relativePosition)
        var relPos = relativePosition
        if bidirectional {
            numBucketsLocal /= 2
            relativeBuckets = relativeBuckets + MLX.where(relPos .> 0,
                                                          MLXArray(Int32(numBucketsLocal)),
                                                          MLXArray(Int32(0)))
            relPos = MLX.abs(relPos)
        } else {
            relPos = -MLX.minimum(relPos, MLX.zeros(like: relPos))
        }

        let maxExact = numBucketsLocal / 2
        let isSmall = relPos .< maxExact

        let relPosF = relPos.asType(.float32)
        let relativePositionIfLarge = (Float(maxExact) + MLX.floor(
            MLX.log(relPosF / Float(maxExact)) / Float(logf(Float(maxDistance) / Float(maxExact)))
            * Float(numBucketsLocal - maxExact)
        )).asType(.int32)
        let clipped = MLX.minimum(relativePositionIfLarge,
                                  MLXArray(Int32(numBucketsLocal - 1)))

        relativeBuckets = relativeBuckets + MLX.where(isSmall, relPos, clipped)
        return relativeBuckets
    }
}

// MARK: - Self attention (numHeads/headDim are instance config, not statics — t5-base is 12/64 vs T5-XXL's 64/64)

struct MGT5SelfAttention {
    let q: MLXNN.Linear
    let k: MLXNN.Linear
    let v: MLXNN.Linear
    let o: MLXNN.Linear
    let relativeAttentionBias: MLXNN.Embedding
    let numHeads: Int
    let headDim: Int

    /// `additiveMask`: (1, 1, 1, L) float, 0 at real-token key positions and
    /// a large negative value at padded key positions (HF's
    /// `(1 - attention_mask) * finfo.min` convention) — nil means no masking
    /// (safe only when the caller knows the sequence has no padding).
    func callAsFunction(_ x: MLXArray, additiveMask: MLXArray? = nil) -> MLXArray {
        let seqLen = x.dim(1)
        func shape(_ t: MLXArray) -> MLXArray {
            t.reshaped([1, -1, numHeads, headDim]).transposed(0, 2, 1, 3)
        }
        let qs = shape(q(x))
        let ks = shape(k(x))
        let vs = shape(v(x))

        var scores = MLX.matmul(qs, ks.transposed(0, 1, 3, 2))   // no scale division — real T5 quirk
        let buckets = MGT5RelativePositionBias.computeBuckets(seqLen: seqLen)
        var bias = relativeAttentionBias(buckets)
        bias = bias.transposed(2, 0, 1).expandedDimensions(axis: 0)
        scores = scores + bias.asType(scores.dtype)
        if let additiveMask {
            scores = scores + additiveMask.asType(scores.dtype)
        }

        let attnWeights = MLX.softmax(scores, axis: -1)
        let attnOut = MLX.matmul(attnWeights, vs)
        let unshaped = attnOut.transposed(0, 2, 1, 3).reshaped([1, -1, numHeads * headDim])
        return o(unshaped)
    }
}

// MARK: - Feed forward — plain single-matrix relu (t5-base's real variant, NOT gated-gelu)

struct MGT5DenseReluDense {
    let wi: MLXNN.Linear
    let wo: MLXNN.Linear

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let hidden = MLX.maximum(wi(x), MLXArray(Float(0)))   // plain relu
        return wo(hidden)
    }
}

// MARK: - Block

struct MGT5Block {
    let attnLayerNorm: MGT5LayerNorm
    let selfAttn: MGT5SelfAttention
    let ffLayerNorm: MGT5LayerNorm
    let ff: MGT5DenseReluDense

    func callAsFunction(_ x: MLXArray, additiveMask: MLXArray? = nil) -> MLXArray {
        var h = x
        h = h + selfAttn(attnLayerNorm(h), additiveMask: additiveMask)
        h = h + ff(ffLayerNorm(h))
        return h
    }
}

// MARK: - Full encoder

public final class MusicGenT5Encoder {
    let shared: MLXNN.Embedding
    let blocks: [MGT5Block]
    let finalLayerNorm: MGT5LayerNorm

    init(shared: MLXNN.Embedding, blocks: [MGT5Block], finalLayerNorm: MGT5LayerNorm) {
        self.shared = shared
        self.blocks = blocks
        self.finalLayerNorm = finalLayerNorm
    }

    /// `inputIds`: (1, L) int32. `attentionMask`: optional (1, L) with 1 at
    /// real-token positions and 0 at padded positions (HF tokenizer
    /// convention) — converted internally to the additive mask real T5
    /// applies before softmax. Pass nil only when the caller knows there is
    /// no padding in `inputIds`. Returns `hidden_states`: (1, L, 768).
    public func callAsFunction(_ inputIds: MLXArray, attentionMask: MLXArray? = nil) -> MLXArray {
        var additiveMask: MLXArray?
        if let attentionMask {
            let mask01 = attentionMask.asType(.float32)
            additiveMask = (MLXArray(Float(1)) - mask01) * MLXArray(Float(-1e9))
            additiveMask = additiveMask!.reshaped([1, 1, 1, -1])
        }
        var hidden = shared(inputIds)
        for block in blocks {
            hidden = block(hidden, additiveMask: additiveMask)
        }
        return finalLayerNorm(hidden)
    }
}

// MARK: - Weight loader

public struct MusicGenT5Weights {
    public let arrays: [String: MLXArray]
    public let numBlocks: Int
    public let numHeads: Int
    public let headDim: Int

    /// `path` — the flat `text_encoder.safetensors` produced by
    /// `run.py import-musicgen` (see Task 2). Keys are already prefix-stripped
    /// (identity vs a standalone HF T5EncoderModel checkpoint: `shared.weight`,
    /// `encoder.block.N.layer.{0,1}...`, `encoder.final_layer_norm.weight`) —
    /// confirmed directly against the real checkpoint on disk.
    public static func load(path: URL, numHeads: Int = 12, headDim: Int = 64) throws -> MusicGenT5Weights {
        let weights = try loadArrays(url: path)
        // The checkpoint may in principle carry decoder.* keys too (t5-base's
        // config.json is T5ForConditionalGeneration) — ignore anything outside
        // encoder./shared., defensive against either checkpoint shape.
        let filtered = weights.filter { $0.key.hasPrefix("encoder.") || $0.key == "shared.weight" }
        var numBlocks = 0
        while filtered["encoder.block.\(numBlocks).layer.0.SelfAttention.q.weight"] != nil { numBlocks += 1 }
        return MusicGenT5Weights(arrays: filtered, numBlocks: numBlocks, numHeads: numHeads, headDim: headDim)
    }
}

public extension MusicGenT5Encoder {
    static func build(weights: MusicGenT5Weights, precision: DType = .float32) -> MusicGenT5Encoder {
        let w = weights.arrays
        func linNoBias(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: nil)
        }
        let sharedBias = w["encoder.block.0.layer.0.SelfAttention.relative_attention_bias.weight"]!
            .asType(.float32)

        let blocks = (0..<weights.numBlocks).map { i -> MGT5Block in
            let attnP = "encoder.block.\(i).layer.0"
            let ffP = "encoder.block.\(i).layer.1"
            return MGT5Block(
                attnLayerNorm: MGT5LayerNorm(weight: w["\(attnP).layer_norm.weight"]!.asType(.float32)),
                selfAttn: MGT5SelfAttention(
                    q: linNoBias("\(attnP).SelfAttention.q"),
                    k: linNoBias("\(attnP).SelfAttention.k"),
                    v: linNoBias("\(attnP).SelfAttention.v"),
                    o: linNoBias("\(attnP).SelfAttention.o"),
                    relativeAttentionBias: Embedding(weight: sharedBias),
                    numHeads: weights.numHeads, headDim: weights.headDim),
                ffLayerNorm: MGT5LayerNorm(weight: w["\(ffP).layer_norm.weight"]!.asType(.float32)),
                ff: MGT5DenseReluDense(
                    wi: linNoBias("\(ffP).DenseReluDense.wi"),
                    wo: linNoBias("\(ffP).DenseReluDense.wo")))
        }

        return MusicGenT5Encoder(
            shared: Embedding(weight: w["shared.weight"]!.asType(precision)),
            blocks: blocks,
            finalLayerNorm: MGT5LayerNorm(weight: w["encoder.final_layer_norm.weight"]!.asType(.float32)))
    }
}
