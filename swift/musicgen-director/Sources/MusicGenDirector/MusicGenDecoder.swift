//
//  MusicGenDecoder.swift
//  MusicGenDirector
//
//  MusicGen's own LM decoder — a genuine from-scratch Swift/MLX port (no
//  prior implementation found anywhere on GitHub, see the port spec's Phase
//  0 research). 24 pre-norm transformer blocks, causal self-attention +
//  cross-attention to T5 hidden states, structurally modeled on
//  ltx-video-director's WhisperDecoder.swift (same causal+cross-attn shape)
//  but with MusicGen's real numbers/differences, confirmed by reading
//  decoder_config.json and the real decoder.safetensors key layout directly
//  (see MusicGenWeights.swift header for the full key inventory):
//    - standard LayerNorm (mean+var, weight+bias), NOT T5's RMSNorm. MLXNN's
//      LayerNorm class has no initializer that accepts real weight/bias
//      MLXArrays (only a from-scratch-init `dimensions:` one) — same gap
//      already worked around in this repo's KontextCLIPEncoder.swift
//      (KClipLayerNorm) — so this file defines its own MGLayerNorm.
//    - bias=False on every q/k/v/out/fc1/fc2 projection (confirmed: the
//      checkpoint has exactly 74 `.bias` keys total = 3 layer-norms/layer *
//      24 layers + 1 final layer-norm's 2 = 74, i.e. ONLY layer-norms have
//      bias; no projection does).
//    - 4 separate per-codebook embedding tables, summed (not one token
//      table). Each table is (2049, 1024) — vocab_size(2048)+1, since index
//      2048 (bos/pad) needs an embeddable row even though the model never
//      predicts it (lm_heads output 2048-dim, never 2049).
//    - sinusoidal position embeddings — NOT a learned table in the usual
//      sense, but (confirmed against the real checkpoint) the exact buffer
//      IS exported as `model.decoder.embed_positions.weights` (2048, 1024)
//      in decoder.safetensors, because HF's
//      MusicgenSinusoidalPositionalEmbedding registers its deterministic
//      sinusoidal buffer as a real (non-persistent-false) nn.Parameter, so
//      it round-trips through state_dict/safetensors export. This decoder
//      loads that array directly and slices it by position rather than
//      recomputing the cos/sin formula in Swift — this is strictly safer
//      (byte-identical to the HF reference, zero risk of getting the
//      cos-then-sin vs sin-then-cos concatenation order backwards) and is
//      possible only because Task 2's checkpoint export happened to include
//      it. See MGSinusoidalPositionalEmbeddingReference below for the
//      formula anyway, kept for documentation/Task-7-debugging use only —
//      it is NOT on the hot path.
//    - 4 separate UNTIED per-codebook lm_heads (tie_word_embeddings=false in
//      decoder_config.json; confirmed lm_heads.{0..3}.weight are real,
//      independent (2048, 1024) arrays, not derived from embed_tokens).
//    - activation: gelu (config.decoder.activation_function == "gelu",
//      HF's exact/erf-based nn.GELU, matching MLXNN.gelu(_:) — NOT
//      MLXNN.geluApproximate/geluFastApproximate).
//    - enc_to_dec_proj: Linear(768 -> 1024, bias: true). Confirmed WITH bias
//      (checkpoint has both `enc_to_dec_proj.weight` (1024,768) AND
//      `enc_to_dec_proj.bias` (1024,)). Applied INSIDE this decoder's
//      `callAsFunction`, at the very start, to the raw T5 hidden states —
//      callers pass the untouched (1, tLen, 768) T5 encoder output, not a
//      pre-projected one. This is a hard contract Task 7's verification
//      script must know: do NOT pre-project encoderHiddenStates yourself.
//
//  v1 has NO KV cache (matches WhisperDecoder's precedent for a first
//  correctness-verified pass) — every forward call recomputes attention over
//  the full prefix. This makes long-duration generation slow; a KV-cache
//  follow-up is explicitly out of scope for this plan (see MusicGenGenerator).
//
//  Known limitation (not fixed here, out of Task 6's scope): cross-attention
//  applies NO padding mask over encoderHiddenStates — every decoder position
//  attends to the full T5 sequence including any pad positions. Task 3's T5
//  encoder already zeroes out padding's effect on OTHER tokens' own
//  representations via its required attentionMask, so a fixed-length /
//  unpadded prompt (the only case exercised by Task 7) is unaffected; a
//  future padded-batch caller would need to add an encoder padding mask to
//  MGDecoderAttention's cross-attention path.
//
//  Numerically verified via `musicgen verify-decoder-step` (Task 7).
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - LayerNorm (weight+bias loaded directly; MLXNN.LayerNorm has no such initializer — same workaround as KontextCLIPEncoder.swift's KClipLayerNorm)

struct MGLayerNorm {
    let weight: MLXArray
    let bias: MLXArray
    let eps: Float = 1e-5

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.layerNorm(x, weight: weight, bias: bias, eps: eps)
    }
}

// MARK: - Standard scaled-dot-product attention (self OR cross, selected by whether keyValueStates is passed)

struct MGDecoderAttention {
    let q: MLXNN.Linear
    let k: MLXNN.Linear
    let v: MLXNN.Linear
    let o: MLXNN.Linear
    let numHeads: Int
    let headDim: Int

    /// - Parameters:
    ///   - x: query input (batch, qLen, 1024)
    ///   - keyValueStates: if non-nil, cross-attention input (batch, kvLen, 1024); else self-attention on `x`
    ///   - causalMask: additive mask (1, 1, qLen, kvLen), only for self-attention; nil for cross-attention
    ///     (MusicGen's cross-attn attends to the full T5 sequence, no causal structure there)
    func callAsFunction(_ x: MLXArray, keyValueStates: MLXArray? = nil, causalMask: MLXArray? = nil) -> MLXArray {
        let kv = keyValueStates ?? x
        let batch = x.dim(0)
        let qLen = x.dim(1)
        let kvLen = kv.dim(1)
        func shapeQ(_ t: MLXArray) -> MLXArray { t.reshaped([batch, qLen, numHeads, headDim]).transposed(0, 2, 1, 3) }
        func shapeKV(_ t: MLXArray) -> MLXArray { t.reshaped([batch, kvLen, numHeads, headDim]).transposed(0, 2, 1, 3) }

        let qs = shapeQ(q(x))
        let ks = shapeKV(k(kv))
        let vs = shapeKV(v(kv))

        let scale: Float = 1.0 / Float(headDim).squareRoot()
        let attnOut = MLXFast.scaledDotProductAttention(queries: qs, keys: ks, values: vs, scale: scale, mask: causalMask)
        let unshaped = attnOut.transposed(0, 2, 1, 3).reshaped([batch, qLen, numHeads * headDim])
        return o(unshaped)
    }
}

// MARK: - Decoder block (pre-norm: self-attn -> cross-attn -> FFN, each with its own residual)

struct MGDecoderLayer {
    let selfAttnLayerNorm: MGLayerNorm
    let selfAttn: MGDecoderAttention
    let crossAttnLayerNorm: MGLayerNorm
    let crossAttn: MGDecoderAttention
    let finalLayerNorm: MGLayerNorm
    let fc1: MLXNN.Linear
    let fc2: MLXNN.Linear

    func callAsFunction(_ x: MLXArray, encoderHiddenStates: MLXArray, causalMask: MLXArray) -> MLXArray {
        var h = x
        h = h + selfAttn(selfAttnLayerNorm(h), causalMask: causalMask)
        h = h + crossAttn(crossAttnLayerNorm(h), keyValueStates: encoderHiddenStates)
        let residual = h
        var ff = finalLayerNorm(h)
        ff = MLXNN.gelu(fc1(ff))
        ff = fc2(ff)
        return residual + ff
    }
}

// MARK: - Sinusoidal positional embedding reference formula (documentation / Task-7-debugging only — NOT used on the hot path, see file header)

public enum MGSinusoidalPositionalEmbeddingReference {
    /// Mirrors HF's MusicgenSinusoidalPositionalEmbedding.get_embedding:
    /// `torch.cat([torch.cos(emb), torch.sin(emb)], dim=1)` — cos-then-sin
    /// concatenation. Recalled from the HF source, NOT independently
    /// re-derived against the live checkpoint in this task (the production
    /// path below loads the checkpoint's real exported buffer instead, so
    /// this function's correctness is not load-bearing for Task 6/7).
    public static func embedding(numPositions: Int, embeddingDim: Int) -> MLXArray {
        let halfDim = embeddingDim / 2
        let logBase = Foundation.log(10000.0) / Double(halfDim - 1)
        let freqs = (0..<halfDim).map { Float(Foundation.exp(-Double($0) * logBase)) }
        var rows: [[Float]] = []
        rows.reserveCapacity(numPositions)
        for pos in 0..<numPositions {
            let angles = freqs.map { Float(pos) * $0 }
            let cosPart = angles.map { Foundation.cos($0) }
            let sinPart = angles.map { Foundation.sin($0) }
            rows.append(cosPart + sinPart)
        }
        let flat = rows.flatMap { $0 }
        return MLXArray(flat, [numPositions, embeddingDim])
    }
}

// MARK: - Full decoder

public final class MusicGenDecoder {
    public static let hiddenSize = 1024
    public static let numLayers = 24
    public static let numHeads = 16
    public static let headDim = 64   // 1024 / 16
    public static let ffnDim = 4096
    public static let numCodebooks = 4
    public static let vocabSize = 2048
    public static let textEncoderHiddenSize = 768

    let embedTokens: [MLXNN.Embedding]   // one per codebook, summed; each table is (vocabSize+1, hiddenSize)
    let posEmbeddings: MLXArray          // (maxPositions, hiddenSize) — real checkpoint buffer, see file header
    let layers: [MGDecoderLayer]
    let layerNorm: MGLayerNorm
    let encToDecProj: MLXNN.Linear       // 768 -> 1024, WITH bias
    let lmHeads: [MLXNN.Linear]          // one per codebook, UNTIED (tie_word_embeddings=false)

    init(embedTokens: [MLXNN.Embedding], posEmbeddings: MLXArray, layers: [MGDecoderLayer],
         layerNorm: MGLayerNorm, encToDecProj: MLXNN.Linear, lmHeads: [MLXNN.Linear]) {
        self.embedTokens = embedTokens
        self.posEmbeddings = posEmbeddings
        self.layers = layers
        self.layerNorm = layerNorm
        self.encToDecProj = encToDecProj
        self.lmHeads = lmHeads
    }

    static func causalMask(length: Int) -> MLXArray {
        var values = [Float](repeating: 0, count: length * length)
        for row in 0..<length {
            for col in (row + 1)..<length {
                values[row * length + col] = -3.4e38   // finite "-inf" (matches KClipAttention's causal mask), avoids NaN risk in the fused SDPA kernel
            }
        }
        return MLXArray(values, [length, length]).reshaped([1, 1, length, length])
    }

    /// - Parameters:
    ///   - inputIds: (numCodebooks, seqLen) int32 — the raw delay-pattern sequence so far.
    ///   - encoderHiddenStates: (1, tLen, 768) raw T5 encoder output — NOT pre-projected;
    ///     this decoder applies `enc_to_dec_proj` internally (see file header contract).
    ///   - offset: position-embedding start offset (0 for a from-scratch forward pass with
    ///     no cache — this port has no KV cache yet, see header).
    /// - Returns: logits, shape (numCodebooks, seqLen, vocabSize).
    public func callAsFunction(inputIds: MLXArray, encoderHiddenStates: MLXArray, offset: Int = 0) -> MLXArray {
        let seqLen = inputIds.dim(1)
        var hidden: MLXArray? = nil
        for cb in 0..<Self.numCodebooks {
            let ids = inputIds[cb].expandedDimensions(axis: 0)   // (1, seqLen)
            let e = embedTokens[cb](ids)
            hidden = hidden == nil ? e : (hidden! + e)
        }
        let posSlice = posEmbeddings[offset..<(offset + seqLen)].expandedDimensions(axis: 0)
        var h = hidden! + posSlice

        let projectedEncoderStates = encToDecProj(encoderHiddenStates)
        let mask = Self.causalMask(length: seqLen)
        for layer in layers {
            h = layer(h, encoderHiddenStates: projectedEncoderStates, causalMask: mask)
        }
        h = layerNorm(h)

        let logitsPerCodebook = lmHeads.map { $0(h) }   // each (1, seqLen, vocabSize)
        return MLX.stacked(logitsPerCodebook.map { $0.squeezed(axis: 0) }, axis: 0)   // (numCodebooks, seqLen, vocabSize)
    }
}
