//
//  WhisperDecoder.swift
//  LTXVideoDirector
//
//  Third real piece of the native Swift/MLX Whisper port (after
//  WhisperMel.swift + WhisperEncoder.swift) — ports mlx_whisper.whisper's
//  TextDecoder / ResidualAttentionBlock(cross_attention=true) line-for-line.
//  Confirms the prediction in this repo's own memory notes: the decoder
//  block is the SAME ResidualAttentionBlock class as the encoder's, just
//  with a second (cross-attention) sub-layer added — WhisperAttention
//  (WhisperEncoder.swift) already generalizes to this via its
//  `crossInput`/`mask` parameters, no attention math needed re-deriving.
//
//  Still open to make transcription fully native (PLAN.md Phase 3 /
//  docs/TODO.md): the tokenizer (GPT-2 BPE + Whisper special tokens) and
//  the autoregressive decode loop (greedy/beam search + KV cache) that
//  drives this decoder token-by-token. ASRGate.swift keeps bridging to
//  mlx_whisper for actual transcription until those land.
//

import Foundation
import MLX
import MLXNN

/// mlx_whisper's ResidualAttentionBlock with cross_attention=true: self-attn
/// (causal-masked) + cross-attn to encoder output + MLP, all pre-LayerNorm.
public struct WhisperDecoderBlock {
    public let selfAttn: WhisperAttention
    public let attnLnWeight: MLXArray, attnLnBias: MLXArray
    public let crossAttn: WhisperAttention
    public let crossAttnLnWeight: MLXArray, crossAttnLnBias: MLXArray
    public let mlp1Weight: MLXArray, mlp1Bias: MLXArray
    public let mlp2Weight: MLXArray, mlp2Bias: MLXArray
    public let mlpLnWeight: MLXArray, mlpLnBias: MLXArray

    public init(
        selfAttn: WhisperAttention, attnLnWeight: MLXArray, attnLnBias: MLXArray,
        crossAttn: WhisperAttention, crossAttnLnWeight: MLXArray, crossAttnLnBias: MLXArray,
        mlp1Weight: MLXArray, mlp1Bias: MLXArray,
        mlp2Weight: MLXArray, mlp2Bias: MLXArray,
        mlpLnWeight: MLXArray, mlpLnBias: MLXArray
    ) {
        self.selfAttn = selfAttn; self.attnLnWeight = attnLnWeight; self.attnLnBias = attnLnBias
        self.crossAttn = crossAttn; self.crossAttnLnWeight = crossAttnLnWeight; self.crossAttnLnBias = crossAttnLnBias
        self.mlp1Weight = mlp1Weight; self.mlp1Bias = mlp1Bias
        self.mlp2Weight = mlp2Weight; self.mlp2Bias = mlp2Bias
        self.mlpLnWeight = mlpLnWeight; self.mlpLnBias = mlpLnBias
    }

    /// - Parameters:
    ///   - x: decoder hidden states (batch, textLen, state)
    ///   - encoderOutput: encoder's final hidden states (batch, audioLen, state)
    ///   - causalMask: additive causal mask, shape >= (textLen, textLen)
    public func callAsFunction(_ x: MLXArray, encoderOutput: MLXArray, causalMask: MLXArray) -> MLXArray {
        var h = x
        h = h + selfAttn(layerNorm(h, weight: attnLnWeight, bias: attnLnBias), mask: causalMask)
        h = h + crossAttn(layerNorm(h, weight: crossAttnLnWeight, bias: crossAttnLnBias), crossInput: encoderOutput)
        let mlpIn = layerNorm(h, weight: mlpLnWeight, bias: mlpLnBias)
        let mlpHidden = MLXNN.gelu(MLX.matmul(mlpIn, mlp1Weight.transposed(1, 0)) + mlp1Bias)
        let mlpOut = MLX.matmul(mlpHidden, mlp2Weight.transposed(1, 0)) + mlp2Bias
        return h + mlpOut
    }
}

/// mlx_whisper.whisper.TextDecoder: token + positional embedding, N decoder
/// blocks, final LayerNorm, tied-embedding projection to vocab logits.
public struct WhisperDecoder {
    public let tokenEmbeddingWeight: MLXArray  // (n_vocab, n_state)
    public let positionalEmbedding: MLXArray   // (n_text_ctx, n_state)
    public let blocks: [WhisperDecoderBlock]
    public let lnWeight: MLXArray, lnBias: MLXArray

    public init(
        tokenEmbeddingWeight: MLXArray, positionalEmbedding: MLXArray,
        blocks: [WhisperDecoderBlock], lnWeight: MLXArray, lnBias: MLXArray
    ) {
        self.tokenEmbeddingWeight = tokenEmbeddingWeight
        self.positionalEmbedding = positionalEmbedding
        self.blocks = blocks
        self.lnWeight = lnWeight; self.lnBias = lnBias
    }

    /// Additive causal mask: mirrors
    /// `nn.MultiHeadAttention.create_additive_causal_mask(n_ctx)` — upper
    /// triangle (excluding diagonal) set to -inf, everything else 0.
    public static func causalMask(length: Int) -> MLXArray {
        var values = [Float](repeating: 0, count: length * length)
        for row in 0..<length {
            for col in (row + 1)..<length {
                values[row * length + col] = -Float.infinity
            }
        }
        return MLXArray(values, [length, length])
    }

    /// - Parameters:
    ///   - tokens: (batch, textLen) integer token ids
    ///   - encoderOutput: (batch, audioLen, state) — `embed_audio` result
    ///   - offset: KV-cache position offset (0 for a from-scratch forward
    ///     pass with no cache — this port has no KV cache yet, see header)
    /// - Returns: logits (batch, textLen, n_vocab)
    public func callAsFunction(tokens: MLXArray, encoderOutput: MLXArray, offset: Int = 0) -> MLXArray {
        let textLen = tokens.dim(1)
        let posSlice = positionalEmbedding[offset..<(offset + textLen)]
        var x = MLX.take(tokenEmbeddingWeight, tokens, axis: 0) + posSlice

        let mask = Self.causalMask(length: offset + textLen)
        for block in blocks {
            x = block(x, encoderOutput: encoderOutput, causalMask: mask)
        }
        x = layerNorm(x, weight: lnWeight, bias: lnBias)
        // Tied embedding: logits = x @ tokenEmbeddingWeight^T (mlx_whisper's
        // `token_embedding.as_linear(x)`).
        return MLX.matmul(x, tokenEmbeddingWeight.transposed(1, 0))
    }
}
