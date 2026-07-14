//
//  KontextT5Encoder.swift
//  Flux2Director
//
//  Part of the `kontext` (FLUX.1-Kontext-dev) native-port epic, phase 4b —
//  see output/next-goal-20260714_212213.md. Ported directly from mflux's T5
//  encoder: `../mflux/src/mflux/models/flux/model/flux_text_encoder/
//  t5_encoder/{t5_encoder,t5_block,t5_attention,t5_self_attention,
//  t5_feed_forward,t5_dense_relu_dense,t5_layer_norm}.py`.
//
//  Architecture: T5-XXL encoder (google/t5-v1_1-xxl-derived, standard FLUX.1
//  text_encoder_2), d_model=4096, 24 blocks, 64 heads, d_kv=64 (so
//  inner_dim=64*64=4096, i.e. num_heads happens to equal head_dim), gated-gelu
//  FFN (4096->10240 x2 gate/up, ->4096 down), relative-position-bias
//  attention (NOT scaled by sqrt(head_dim) — a genuine T5 quirk, verified by
//  reading `T5SelfAttention.__call__`: no `/ scale` anywhere), encoder-only
//  (bidirectional, no causal mask), RMSNorm-style `T5LayerNorm` (no mean
//  subtraction, just `x * rsqrt(mean(x^2) + eps)`, matching HF T5's actual
//  layer norm — NOT a standard LayerNorm despite the class name).
//
//  Weight keys are an IDENTITY mapping vs the raw HF checkpoint EXCEPT
//  `relative_attention_bias`: HF's real checkpoint stores this ONCE (at
//  `encoder.block.0.layer.0.SelfAttention.relative_attention_bias.weight`)
//  since real T5 shares this bias across all layers, but mflux's per-block
//  `T5SelfAttention` class always declares its OWN `relative_attention_bias`
//  attribute — `FluxWeightMapping.get_t5_encoder_mapping()`'s mapping entry
//  for this key has a `to_pattern` with `{block}` but a `from_pattern` with
//  NO `{block}` (one-to-many broadcast), confirmed by reading the mapping
//  source. `load()`/`build()` below replicate that: only block 0's tensor is
//  read from the checkpoint and copied into every block's bias.
//
//  Numerically verified via `flux2 verify-kontext-t5` against
//  `gen_kontext_t5_ref.py` (real HF weights + real T5TokenizerFast + real
//  mflux T5Encoder forward pass).
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - T5LayerNorm (RMS-style, no mean subtraction — matches HF T5 exactly)

struct KT5LayerNorm {
    let weight: MLXArray
    let eps: Float = 1e-6

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let xf = x.asType(.float32)
        let variance = MLX.mean(xf * xf, axis: -1, keepDims: true)
        let normed = xf * MLX.rsqrt(variance + eps)
        return weight * normed.asType(x.dtype)
    }
}

// MARK: - Relative position bias (32 buckets, bidirectional, max_distance=128)

enum KT5RelativePositionBias {
    static let numBuckets = 32
    static let maxDistance = 128

    /// Returns bucket indices, shape (seqLen, seqLen), int32.
    static func computeBuckets(seqLen: Int, bidirectional: Bool = true) -> MLXArray {
        let contextPos = MLX.arange(0, seqLen).reshaped([seqLen, 1])
        let memoryPos = MLX.arange(0, seqLen).reshaped([1, seqLen])
        let relativePosition = memoryPos - contextPos   // (seqLen, seqLen), broadcasts

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

// MARK: - Self attention (relative-position-bias, no sqrt(d) scaling — real T5 quirk)

struct KT5SelfAttention {
    let q: MLXNN.Linear
    let k: MLXNN.Linear
    let v: MLXNN.Linear
    let o: MLXNN.Linear
    let relativeAttentionBias: MLXNN.Embedding   // (32, numHeads)
    static let numHeads = 64
    static let headDim = 64

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let seqLen = x.dim(1)
        func shape(_ t: MLXArray) -> MLXArray {
            t.reshaped([1, -1, Self.numHeads, Self.headDim]).transposed(0, 2, 1, 3)
        }
        let qs = shape(q(x))
        let ks = shape(k(x))
        let vs = shape(v(x))

        var scores = MLX.matmul(qs, ks.transposed(0, 1, 3, 2))   // (1, heads, L, L) — no scale division.
        let buckets = KT5RelativePositionBias.computeBuckets(seqLen: seqLen)
        var bias = relativeAttentionBias(buckets)      // (L, L, numHeads)
        bias = bias.transposed(2, 0, 1).expandedDimensions(axis: 0)   // (1, numHeads, L, L)
        scores = scores + bias.asType(scores.dtype)

        let attnWeights = MLX.softmax(scores, axis: -1)
        let attnOut = MLX.matmul(attnWeights, vs)
        let unshaped = attnOut.transposed(0, 2, 1, 3).reshaped([1, -1, Self.numHeads * Self.headDim])
        return o(unshaped)
    }
}

// MARK: - Feed forward (gated-gelu, tanh-approx "new_gelu")

struct KT5DenseReluDense {
    let wi0: MLXNN.Linear
    let wi1: MLXNN.Linear
    let wo: MLXNN.Linear

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let hiddenGelu = KT5DenseReluDense.newGelu(wi0(x))
        let hiddenLinear = wi1(x)
        return wo(hiddenGelu * hiddenLinear)
    }

    /// Tanh-approximation GELU (HF's "new_gelu"), NOT the erf-based exact GELU.
    static func newGelu(_ x: MLXArray) -> MLXArray {
        let c = Float((2.0 / Double.pi).squareRoot())
        return 0.5 * x * (1.0 + MLX.tanh(c * (x + 0.044715 * MLX.pow(x, 3))))
    }
}

// MARK: - Block (each sub-layer's residual add is internal, matching mflux)

struct KT5Block {
    let attnLayerNorm: KT5LayerNorm
    let selfAttn: KT5SelfAttention
    let ffLayerNorm: KT5LayerNorm
    let ff: KT5DenseReluDense

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        h = h + selfAttn(attnLayerNorm(h))
        h = h + ff(ffLayerNorm(h))
        return h
    }
}

// MARK: - Full T5 encoder

public final class KontextT5Encoder {
    let shared: MLXNN.Embedding
    let blocks: [KT5Block]
    let finalLayerNorm: KT5LayerNorm

    init(shared: MLXNN.Embedding, blocks: [KT5Block], finalLayerNorm: KT5LayerNorm) {
        self.shared = shared
        self.blocks = blocks
        self.finalLayerNorm = finalLayerNorm
    }

    /// `inputIds`: (1, L) int32 token ids. Returns `prompt_embeds`: (1, L, 4096).
    public func callAsFunction(_ inputIds: MLXArray) -> MLXArray {
        var hidden = shared(inputIds)
        for block in blocks {
            hidden = block(hidden)
        }
        return finalLayerNorm(hidden)
    }
}

// MARK: - Weight loader

public struct KontextT5Weights {
    public let arrays: [String: MLXArray]
    public let numBlocks: Int

    /// `dir` — the `text_encoder_2/` subdir of a downloaded
    /// `black-forest-labs/FLUX.1-Kontext-dev` snapshot (sharded safetensors).
    public static func load(dir: URL) throws -> KontextT5Weights {
        var weights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for f in files {
            let shard = try loadArrays(url: f)
            weights.merge(shard) { _, new in new }
        }
        var numBlocks = 0
        while weights["encoder.block.\(numBlocks).layer.0.SelfAttention.q.weight"] != nil { numBlocks += 1 }
        return KontextT5Weights(arrays: weights, numBlocks: numBlocks)
    }
}

public extension KontextT5Encoder {
    static func build(weights: KontextT5Weights, precision: DType = .bfloat16) -> KontextT5Encoder {
        let w = weights.arrays
        func linNoBias(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: nil)
        }
        // Block 0's relative_attention_bias is the ONLY copy in the real HF
        // checkpoint (real T5 shares this bias across all layers) — broadcast
        // it into every block, matching mflux's per-block duplication at
        // load time (see file header).
        let sharedBias = w["encoder.block.0.layer.0.SelfAttention.relative_attention_bias.weight"]!
            .asType(.float32)

        let blocks = (0..<weights.numBlocks).map { i -> KT5Block in
            let attnP = "encoder.block.\(i).layer.0"
            let ffP = "encoder.block.\(i).layer.1"
            return KT5Block(
                attnLayerNorm: KT5LayerNorm(weight: w["\(attnP).layer_norm.weight"]!.asType(.float32)),
                selfAttn: KT5SelfAttention(
                    q: linNoBias("\(attnP).SelfAttention.q"),
                    k: linNoBias("\(attnP).SelfAttention.k"),
                    v: linNoBias("\(attnP).SelfAttention.v"),
                    o: linNoBias("\(attnP).SelfAttention.o"),
                    relativeAttentionBias: Embedding(weight: sharedBias)),
                ffLayerNorm: KT5LayerNorm(weight: w["\(ffP).layer_norm.weight"]!.asType(.float32)),
                ff: KT5DenseReluDense(
                    wi0: linNoBias("\(ffP).DenseReluDense.wi_0"),
                    wi1: linNoBias("\(ffP).DenseReluDense.wi_1"),
                    wo: linNoBias("\(ffP).DenseReluDense.wo")))
        }

        return KontextT5Encoder(
            shared: Embedding(weight: w["shared.weight"]!.asType(precision)),
            blocks: blocks,
            finalLayerNorm: KT5LayerNorm(weight: w["encoder.final_layer_norm.weight"]!.asType(.float32)))
    }
}
