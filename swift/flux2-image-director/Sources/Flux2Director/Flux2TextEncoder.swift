//
//  Flux2TextEncoder.swift
//  Flux2Director
//
//  Phase 2.2: Qwen3-8B text encoder for Flux2 Klein. Ported directly from
//  mflux's flux2_text_encoder.{qwen3_text_encoder, prompt_encoder}.
//
//  Architecture: Qwen3 decoder (hidden=4096, 36 layers, 32 heads, 8 KV heads,
//  head_dim=128, intermediate=12288, vocab=151936). Weights are 8-bit quantized
//  (group_size=64). Produces prompt_embeds by stacking hidden states from
//  layers (9, 18, 27) → (1, L, 3*4096 = 12288).
//
//  Weight keys have NO `model.` prefix (differs from ZImage's qwen3-4b):
//    embed_tokens.weight, layers.{i}.self_attn.q_proj.weight, norm.weight, ...
//

import Foundation
import MLX
import MLXFast

// MARK: - Quantized primitives (8-bit, group_size=64)

/// Quantized linear: y = x @ W^T. Pre-quantized weights (U32 + scales/biases).
/// Optionally carries a LoRA adapter: y = base + scale * x @ A @ B
struct F2QLinear {
    let weight: MLXArray   // (out, in_packed) U32
    let scales: MLXArray   // (out, in/groupSize)
    let biases: MLXArray   // (out, in/groupSize)
    let groupSize: Int
    let bits: Int
    var loraA: MLXArray? = nil   // (in, r) float32 — nil = no LoRA
    var loraB: MLXArray? = nil   // (r, out) float32
    var loraScale: Float = 1.0   // user scale (default 1.0)

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let base = quantizedMM(x, weight, scales: scales, biases: biases,
                               transpose: true, groupSize: groupSize, bits: bits, mode: .affine)
        if let a = loraA, let b = loraB {
            // LoRA branch: base + scale * matmul(matmul(x, A), B)
            let xf = x.asType(.float32)
            let branch = MLX.matmul(MLX.matmul(xf, a), b)
            return base + (loraScale * branch).asType(base.dtype)
        }
        return base
    }
}

/// Quantized embedding: dequantize weight[ids] on the fly.
struct F2QEmbedding {
    let weight: MLXArray   // (vocab, dim_packed) U32
    let scales: MLXArray   // (vocab, dim/groupSize)
    let biases: MLXArray   // (vocab, dim/groupSize)
    let groupSize: Int
    let bits: Int

    func callAsFunction(_ ids: MLXArray) -> MLXArray {
        let s = ids.shape
        let flat = ids.flattened()
        let w = weight[flat]
        let sc = scales[flat]
        let bs = biases[flat]
        let out = dequantized(w, scales: sc, biases: bs,
                              groupSize: groupSize, bits: bits, mode: .affine)
        return out.reshaped(s + [-1])
    }
}

/// RMSNorm (weight-only).
struct F2QRMSNorm {
    let weight: MLXArray
    let eps: Float

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.rmsNorm(x, weight: weight, eps: eps)
    }
}

// MARK: - Qwen3 Attention (GQA + qk_norm + RoPE)

struct F2Qwen3Attention {
    let qProj: F2QLinear
    let kProj: F2QLinear
    let vProj: F2QLinear
    let oProj: F2QLinear
    let qNorm: F2QRMSNorm
    let kNorm: F2QRMSNorm
    let numHeads: Int        // 32
    let numKVHeads: Int      // 8
    let headDim: Int         // 128
    let ropeTheta: Float     // 1000000

    func callAsFunction(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let (b, l, _) = (x.dim(0), x.dim(1), x.dim(2))

        var q = qProj(x).reshaped([b, l, numHeads, headDim])
        var k = kProj(x).reshaped([b, l, numKVHeads, headDim])
        let v = vProj(x).reshaped([b, l, numKVHeads, headDim])

        // q_norm / k_norm: per-head RMSNorm on head_dim (before RoPE).
        q = qNorm(q)
        k = kNorm(k)

        q = q.transposed(0, 2, 1, 3)
        k = k.transposed(0, 2, 1, 3)
        let vt = v.transposed(0, 2, 1, 3)

        q = MLXFast.RoPE(q, dimensions: headDim, traditional: false,
                         base: ropeTheta, scale: 1.0, offset: 0)
        k = MLXFast.RoPE(k, dimensions: headDim, traditional: false,
                         base: ropeTheta, scale: 1.0, offset: 0)

        let nRep = numHeads / numKVHeads
        let scale = Float(headDim).squareRoot()
        if nRep > 1 {
            k = MLX.broadcast(k.expandedDimensions(axis: 2),
                              to: [b, numKVHeads, nRep, l, headDim])
                .reshaped([b, numHeads, l, headDim])
            let vb = MLX.broadcast(vt.expandedDimensions(axis: 2),
                                   to: [b, numKVHeads, nRep, l, headDim])
                .reshaped([b, numHeads, l, headDim])
            var scores = q.matmul(k.transposed(0, 1, 3, 2)) / scale
            if let mask { scores = scores + mask }
            let probs = MLX.softmax(scores, axis: -1)
            let output = probs.matmul(vb).transposed(0, 2, 1, 3).reshaped([b, l, -1])
            return oProj(output)
        } else {
            var scores = q.matmul(k.transposed(0, 1, 3, 2)) / scale
            if let mask { scores = scores + mask }
            let probs = MLX.softmax(scores, axis: -1)
            let output = probs.matmul(vt).transposed(0, 2, 1, 3).reshaped([b, l, -1])
            return oProj(output)
        }
    }
}

// MARK: - SwiGLU MLP

struct F2QMLP {
    let gateProj: F2QLinear
    let upProj: F2QLinear
    let downProj: F2QLinear

    func callAsFunction(_ input: MLXArray) -> MLXArray {
        let gate = gateProj(input)
        return downProj(gate * MLX.sigmoid(gate) * upProj(input))
    }
}

// MARK: - Transformer block

struct F2Qwen3Block {
    let attn: F2Qwen3Attention
    let mlp: F2QMLP
    let inputNorm: F2QRMSNorm
    let postAttnNorm: F2QRMSNorm

    /// Returns (output, hidden_state_before_this_block_output).
    /// The hidden state list collects states AFTER each block (matching mflux
    /// which appends after each layer, with the embedding as index 0).
    func callAsFunction(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let h = x + attn(inputNorm(x), mask: mask)
        return h + mlp(postAttnNorm(h))
    }
}

// MARK: - Config

public struct Flux2TextEncoderConfig: Sendable {
    public let hiddenSize: Int       // 4096
    public let numLayers: Int        // 36
    public let numHeads: Int         // 32
    public let numKVHeads: Int       // 8
    public let headDim: Int          // 128
    public let intermediateSize: Int // 12288
    public let vocabSize: Int        // 151936
    public let rmsEps: Float         // 1e-6
    public let ropeTheta: Float      // 1e6
    public let groupSize: Int        // 64
    public let bits: Int             // 8

    public init(hiddenSize: Int, numLayers: Int, numHeads: Int, numKVHeads: Int,
                headDim: Int, intermediateSize: Int, vocabSize: Int,
                rmsEps: Float, ropeTheta: Float, groupSize: Int, bits: Int) {
        self.hiddenSize = hiddenSize; self.numLayers = numLayers
        self.numHeads = numHeads; self.numKVHeads = numKVHeads
        self.headDim = headDim; self.intermediateSize = intermediateSize
        self.vocabSize = vocabSize; self.rmsEps = rmsEps
        self.ropeTheta = ropeTheta; self.groupSize = groupSize; self.bits = bits
    }
}

// MARK: - Full Qwen3-8B text encoder

public struct Flux2TextEncoder {
    let embedTokens: F2QEmbedding
    let blocks: [F2Qwen3Block]
    let finalNorm: F2QRMSNorm
    let config: Flux2TextEncoderConfig

    /// Run all layers, collecting hidden states for get_prompt_embeds.
    /// Returns (final_normed_output, hidden_states_list) where hidden_states_list
    /// includes the embedding output at index 0 and each layer output after.
    /// This matches mflux's Qwen3TextEncoder.__call__ with output_hidden_states=True.
    public func forwardCollect(_ inputIds: MLXArray, attentionMask: MLXArray?)
        -> (MLXArray, [MLXArray])
    {
        var hidden = embedTokens(inputIds)
        let seqLen = inputIds.dim(1)
        // Causal mask: upper triangle = -1e9 (matches mflux causal_tri_mask).
        var mask = MLX.triu(MLX.full([seqLen, seqLen], values: -1e9 as Float), k: 1)
            .reshaped([1, 1, seqLen, seqLen])

        // Padding mask from attention_mask (1=keep, 0=pad → -inf).
        if let am = attentionMask {
            let pad = MLX.where(am .== 1,
                                MLX.zeros(am.shape),
                                MLX.full(am.shape, values: Float(-1e9))).asType(.float32)
            mask = mask + pad.reshaped([1, 1, 1, -1])
        }

        var hiddenStates: [MLXArray] = [hidden]   // index 0 = embedding output
        for block in blocks {
            hidden = block(hidden, mask: mask)
            hiddenStates.append(hidden)
        }
        let normed = finalNorm(hidden)
        return (normed, hiddenStates)
    }

    /// Get prompt embeds: stack hidden states from layers (9, 18, 27), reshape.
    /// Output: (1, L, num_layers * hidden_size) = (1, L, 3*4096 = 12288).
    /// Matches mflux Qwen3TextEncoder.get_prompt_embeds.
    public func getPromptEmbeds(_ inputIds: MLXArray, attentionMask: MLXArray?,
                                hiddenStateLayers: [Int] = [9, 18, 27]) -> MLXArray {
        let (_, hiddenStates) = forwardCollect(inputIds, attentionMask: attentionMask)
        // mflux: hidden_states_list[i] where i is the layer index.
        // Index 0 = embedding, index k = output after layer (k-1).
        // So layer N's output is at index N+1. mflux accesses hidden_states_list[i]
        // directly with i in (9,18,27) — those are the raw list indices.
        let stacked = MLX.stacked(hiddenStateLayers.map { hiddenStates[$0] }, axis: 1)
        // stacked: (1, num_layers, L, hidden) → (1, L, num_layers * hidden)
        let b = stacked.dim(0), numLayers = stacked.dim(1), l = stacked.dim(2), hd = stacked.dim(3)
        return stacked.transposed(0, 2, 1, 3).reshaped([b, l, numLayers * hd])
    }
}

// MARK: - Weight loader

public struct Flux2TextEncoderWeights {
    public let config: Flux2TextEncoderConfig
    public let arrays: [String: MLXArray]

    /// Load qwen3-8b from the text_encoder directory. Reads config.json for dims,
    /// loads all shards (NO `model.` key prefix).
    public static func load(dir: URL) throws -> Flux2TextEncoderWeights {
        let configURL = dir.appendingPathComponent("config.json")
        let data = try Data(contentsOf: configURL)
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "Flux2TextEncoderWeights", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "config.json is not a JSON object"])
        }
        func intKey(_ key: String) -> Int {
            if let v = raw[key] as? Int { return v }
            if let s = raw[key] as? String, let v = Int(s) { return v }
            fatalError("config.json missing required key: \(key)")
        }
        let hiddenSize = intKey("hidden_size")
        let numHeads = intKey("num_attention_heads")
        let cfg = Flux2TextEncoderConfig(
            hiddenSize: hiddenSize,
            numLayers: intKey("num_hidden_layers"),
            numHeads: numHeads,
            numKVHeads: intKey("num_key_value_heads"),
            headDim: (raw["head_dim"] as? Int) ?? (hiddenSize / numHeads),
            intermediateSize: intKey("intermediate_size"),
            vocabSize: intKey("vocab_size"),
            rmsEps: (raw["rms_norm_eps"] as? Double).map { Float($0) } ?? 1e-6,
            ropeTheta: (raw["rope_theta"] as? Double).map { Float($0) } ?? 1e6,
            groupSize: 64, bits: 8
        )
        // Load all shards (sharded safetensors: 0.safetensors, 1.safetensors, ...)
        var weights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for f in files {
            let shard = try loadArrays(url: f)
            weights.merge(shard) { _, new in new }
        }
        return Flux2TextEncoderWeights(config: cfg, arrays: weights)
    }
}

public extension Flux2TextEncoder {
    static func build(weights: Flux2TextEncoderWeights) -> Flux2TextEncoder {
        let cfg = weights.config
        let gs = cfg.groupSize, bits = cfg.bits
        let w = weights.arrays

        func ql(_ key: String) -> F2QLinear {
            F2QLinear(
                weight: w["\(key).weight"]!,
                scales: w["\(key).scales"]!,
                biases: w["\(key).biases"]!,
                groupSize: gs, bits: bits
            )
        }
        func norm(_ key: String) -> F2QRMSNorm {
            F2QRMSNorm(weight: w["\(key).weight"]!, eps: cfg.rmsEps)
        }

        // Embedding: NO `model.` prefix.
        let embed = F2QEmbedding(
            weight: w["embed_tokens.weight"]!,
            scales: w["embed_tokens.scales"]!,
            biases: w["embed_tokens.biases"]!,
            groupSize: gs, bits: bits
        )

        var blocks: [F2Qwen3Block] = []
        blocks.reserveCapacity(cfg.numLayers)
        for idx in 0..<cfg.numLayers {
            let p = "layers.\(idx)"
            blocks.append(F2Qwen3Block(
                attn: F2Qwen3Attention(
                    qProj: ql("\(p).self_attn.q_proj"),
                    kProj: ql("\(p).self_attn.k_proj"),
                    vProj: ql("\(p).self_attn.v_proj"),
                    oProj: ql("\(p).self_attn.o_proj"),
                    qNorm: norm("\(p).self_attn.q_norm"),
                    kNorm: norm("\(p).self_attn.k_norm"),
                    numHeads: cfg.numHeads, numKVHeads: cfg.numKVHeads,
                    headDim: cfg.headDim, ropeTheta: cfg.ropeTheta
                ),
                mlp: F2QMLP(
                    gateProj: ql("\(p).mlp.gate_proj"),
                    upProj: ql("\(p).mlp.up_proj"),
                    downProj: ql("\(p).mlp.down_proj")
                ),
                inputNorm: norm("\(p).input_layernorm"),
                postAttnNorm: norm("\(p).post_attention_layernorm")
            ))
        }

        return Flux2TextEncoder(
            embedTokens: embed, blocks: blocks,
            finalNorm: norm("norm"), config: cfg
        )
    }
}
