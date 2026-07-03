//
//  TextEncoder.swift
//  ZImageDirector
//
//  Phase 3: Qwen3-4B text encoder — encodes prompts into cap_feats (1, N, 2560).
//  Removes the Python embedding-exchange dependency for true E2E text→image.
//

import Foundation
import MLX
import MLXFast

// MARK: - Quantized primitives (4-bit, group_size=32)

/// Quantized linear layer: y = x @ W^T (+ bias).
/// Weights are pre-quantized (weight/scales/biases from safetensors).
struct QLinear {
    let weight: MLXArray   // (out, in_packed)
    let scales: MLXArray   // (out, in/group_size)
    let biases: MLXArray   // (out, in/group_size)
    let groupSize: Int
    let bits: Int

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        quantizedMM(x, weight, scales: scales, biases: biases,
                    transpose: true, groupSize: groupSize, bits: bits, mode: .affine)
    }
}

/// Quantized embedding lookup: dequantize weight[ids] on the fly.
struct QEmbedding {
    let weight: MLXArray   // (vocab, dim_packed)
    let scales: MLXArray   // (vocab, dim/group_size)
    let biases: MLXArray   // (vocab, dim/group_size)
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

// MARK: - RMSNorm (weight-only, no learnable bias)

struct QRMSNorm {
    let weight: MLXArray
    let eps: Float

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.rmsNorm(x, weight: weight, eps: eps)
    }
}

// MARK: - Qwen3 Attention (GQA + qk_norm + RoPE)

struct Qwen3Attention {
    let qProj: QLinear
    let kProj: QLinear
    let vProj: QLinear
    let oProj: QLinear
    let qNorm: QRMSNorm
    let kNorm: QRMSNorm
    let numHeads: Int        // 32
    let numKVHeads: Int      // 8
    let headDim: Int         // 128
    let ropeTheta: Float     // 1000000

    func callAsFunction(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let (b, l, _) = (x.dim(0), x.dim(1), x.dim(2))

        var q = qProj(x).reshaped([b, l, numHeads, headDim])
        var k = kProj(x).reshaped([b, l, numKVHeads, headDim])
        let v = vProj(x).reshaped([b, l, numKVHeads, headDim])

        // q_norm / k_norm: RMSNorm applied per-head on head_dim (before RoPE).
        q = qNorm(q)
        k = kNorm(k)

        // Transpose to (b, nheads, l, head_dim).
        q = q.transposed(0, 2, 1, 3)
        k = k.transposed(0, 2, 1, 3)
        let vt = v.transposed(0, 2, 1, 3)

        // RoPE (traditional=false → interleaved=false, base=1e6).
        q = MLXFast.RoPE(q, dimensions: headDim, traditional: false,
                         base: ropeTheta, scale: 1.0, offset: 0)
        k = MLXFast.RoPE(k, dimensions: headDim, traditional: false,
                         base: ropeTheta, scale: 1.0, offset: 0)

        // GQA: repeat k,v to match num_heads.
        // (B, nkv, L, D) → expand axis 2 → broadcast → reshape
        let nRep = numHeads / numKVHeads
        if nRep > 1 {
            k = MLX.broadcast(k.expandedDimensions(axis: 2),
                              to: [b, numKVHeads, nRep, l, headDim])
                .reshaped([b, numHeads, l, headDim])
            let vb = MLX.broadcast(vt.expandedDimensions(axis: 2),
                                   to: [b, numKVHeads, nRep, l, headDim])
                .reshaped([b, numHeads, l, headDim])
            // Scaled dot-product attention.
            let scale = Float(headDim).squareRoot()
            var scores = q.matmul(k.transposed(0, 1, 3, 2)) / scale
            if let mask { scores = scores + mask }
            let probs = MLX.softmax(scores, axis: -1)
            let output = probs.matmul(vb).transposed(0, 2, 1, 3).reshaped([b, l, -1])
            return oProj(output)
        } else {
            // Scaled dot-product attention (no GQA expansion needed).
            let scale = Float(headDim).squareRoot()
            var scores = q.matmul(k.transposed(0, 1, 3, 2)) / scale
            if let mask { scores = scores + mask }
            let probs = MLX.softmax(scores, axis: -1)
            let output = probs.matmul(vt).transposed(0, 2, 1, 3).reshaped([b, l, -1])
            return oProj(output)
        }
    }
}

// MARK: - SwiGLU MLP

struct QMLP {
    let gateProj: QLinear
    let upProj: QLinear
    let downProj: QLinear

    func callAsFunction(_ input: MLXArray) -> MLXArray {
        // SiLU(x) = x * sigmoid(x)
        let gate = gateProj(input)
        return downProj(gate * MLX.sigmoid(gate) * upProj(input))
    }
}

// MARK: - Transformer block

struct Qwen3Block {
    let attn: Qwen3Attention
    let mlp: QMLP
    let inputNorm: QRMSNorm
    let postAttnNorm: QRMSNorm

    func callAsFunction(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let h = x + attn(inputNorm(x), mask: mask)
        return h + mlp(postAttnNorm(h))
    }
}

// MARK: - Full Qwen3 model

public struct Qwen3TextEncoderConfig: Sendable {
    public let hiddenSize: Int       // 2560
    public let numLayers: Int        // 36
    public let numHeads: Int         // 32
    public let numKVHeads: Int       // 8
    public let headDim: Int          // 128
    public let intermediateSize: Int // 9728
    public let vocabSize: Int        // 151936
    public let rmsEps: Float         // 1e-6
    public let ropeTheta: Float      // 1e6
    public let groupSize: Int        // 32
    public let bits: Int             // 4

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

public struct Qwen3TextEncoder {
    let embedTokens: QEmbedding
    let blocks: [Qwen3Block]
    let finalNorm: QRMSNorm
    let config: Qwen3TextEncoderConfig

    /// Encode input_ids → cap_feats (1, L, hiddenSize).
    /// Returns the **second-to-last** hidden state (matches Python `hidden_states[-2]`).
    public func callAsFunction(_ inputIds: MLXArray) -> MLXArray {
        let hidden = embedTokens(inputIds)
        let seqLen = inputIds.dim(1)
        // Causal mask: upper triangle = -1e9.
        let mask = MLX.triu(MLX.full([seqLen, seqLen], values: -1e9 as Float), k: 1)

        // Run all layers; Python returns hidden_states[-2] = last layer output
        // (BEFORE the final norm). The finalNorm is computed but not returned.
        var output = hidden
        for block in blocks {
            output = block(output, mask: mask)
        }
        return output
    }

    /// Per-layer hidden states mirroring transformers ``output_hidden_states``:
    /// index 0 = embedding output, index k = output of layer (k-1), final = norm(last).
    /// Used by Krea 2 (swift/krea2-image-director) to tap 12 selected layers feeding
    /// the DiT text-fusion stage. Additive public API — does not change existing behavior.
    public func forwardHiddenStates(_ inputIds: MLXArray) -> [MLXArray] {
        var x = embedTokens(inputIds)
        let seqLen = inputIds.dim(1)
        let mask = MLX.triu(MLX.full([seqLen, seqLen], values: -1e9 as Float), k: 1)
        var hs: [MLXArray] = [x]              // [0] = embedding output
        for block in blocks {
            x = block(x, mask: mask)
            hs.append(x)                      // [k] = output of layer k-1
        }
        hs.append(finalNorm(x))               // final norm
        return hs
    }
}

// MARK: - Weight loader

public struct TextEncoderWeights {
    public let config: Qwen3TextEncoderConfig
    public let arrays: [String: MLXArray]

    public static func load(dir: URL) throws -> TextEncoderWeights {
        let configURL = dir.appendingPathComponent("config.json")
        let data = try Data(contentsOf: configURL)
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "TextEncoderWeights", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "config.json is not a JSON object"])
        }
        func intKey(_ key: String) -> Int {
            if let intValue = raw[key] as? Int { return intValue }
            if let strValue = raw[key] as? String, let parsed = Int(strValue) { return parsed }
            fatalError("config.json missing required key: \(key)")
        }
        let hiddenSize = intKey("hidden_size")
        let numHeads = intKey("num_attention_heads")
        let cfg = Qwen3TextEncoderConfig(
            hiddenSize: hiddenSize,
            numLayers: intKey("num_hidden_layers"),
            numHeads: numHeads,
            numKVHeads: intKey("num_key_value_heads"),
            headDim: (raw["head_dim"] as? Int) ?? (hiddenSize / numHeads),
            intermediateSize: intKey("intermediate_size"),
            vocabSize: intKey("vocab_size"),
            rmsEps: (raw["rms_norm_eps"] as? Double).map { Float($0) } ?? 1e-6,
            ropeTheta: (raw["rope_theta"] as? Double).map { Float($0) } ?? 1e6,
            groupSize: 32, bits: 4
        )
        let weights = try loadArrays(url: dir.appendingPathComponent("model.safetensors"))
        return TextEncoderWeights(config: cfg, arrays: weights)
    }
}

public extension Qwen3TextEncoder {
    static func build(weights: TextEncoderWeights) -> Qwen3TextEncoder {
        let cfg = weights.config
        let groupSize = cfg.groupSize, bits = cfg.bits
        let w = weights.arrays

        func ql(_ key: String) -> QLinear {
            QLinear(
                weight: w["\(key).weight"]!,
                scales: w["\(key).scales"]!,
                biases: w["\(key).biases"]!,
                groupSize: groupSize, bits: bits
            )
        }
        func norm(_ key: String) -> QRMSNorm {
            QRMSNorm(weight: w["\(key).weight"]!, eps: cfg.rmsEps)
        }

        let embed = QEmbedding(
            weight: w["model.embed_tokens.weight"]!,
            scales: w["model.embed_tokens.scales"]!,
            biases: w["model.embed_tokens.biases"]!,
            groupSize: groupSize, bits: bits
        )

        var blocks: [Qwen3Block] = []
        blocks.reserveCapacity(cfg.numLayers)
        for idx in 0..<cfg.numLayers {
            let prefix = "model.layers.\(idx)"
            blocks.append(Qwen3Block(
                attn: Qwen3Attention(
                    qProj: ql("\(prefix).self_attn.q_proj"),
                    kProj: ql("\(prefix).self_attn.k_proj"),
                    vProj: ql("\(prefix).self_attn.v_proj"),
                    oProj: ql("\(prefix).self_attn.o_proj"),
                    qNorm: norm("\(prefix).self_attn.q_norm"),
                    kNorm: norm("\(prefix).self_attn.k_norm"),
                    numHeads: cfg.numHeads, numKVHeads: cfg.numKVHeads,
                    headDim: cfg.headDim, ropeTheta: cfg.ropeTheta
                ),
                mlp: QMLP(
                    gateProj: ql("\(prefix).mlp.gate_proj"),
                    upProj: ql("\(prefix).mlp.up_proj"),
                    downProj: ql("\(prefix).mlp.down_proj")
                ),
                inputNorm: norm("\(prefix).input_layernorm"),
                postAttnNorm: norm("\(prefix).post_attention_layernorm")
            ))
        }

        return Qwen3TextEncoder(
            embedTokens: embed, blocks: blocks,
            finalNorm: norm("model.norm"), config: cfg
        )
    }
}
